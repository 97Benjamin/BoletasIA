import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import ValidationError

from app.api.dependencies import get_supabase_client
from app.schemas.boleta import BoletaConfirmada
from app.services.boletas import extraer_datos_boleta

router = APIRouter(prefix="/gastos", tags=["Gastos"])
logger = logging.getLogger(__name__)


@router.post("/procesar-boleta")
async def procesar_boleta(
    file: UploadFile = File(...),
    auth_data=Depends(get_supabase_client),
):
    _, user_id = auth_data
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Debes iniciar sesión para analizar una boleta.",
        )
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El archivo debe ser una imagen.",
        )

    try:
        image_bytes = await file.read()
        if not image_bytes:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La imagen seleccionada está vacía.",
            )

        datos = await extraer_datos_boleta(image_bytes, file.content_type)
        return {"datos_extraidos": datos.model_dump(mode="json")}
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Error en los datos extraídos: {exc.errors()}",
        ) from exc
    except HTTPException:
        raise
    except RuntimeError as exc:
        # Mensajes controlados del proveedor IA (límites, clave inválida)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        if "503" in str(exc) or "UNAVAILABLE" in str(exc):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=(
                    "El servicio de IA está experimentando alta demanda. "
                    "Intenta de nuevo en unos segundos."
                ),
            ) from exc
        logger.exception("Error al analizar la imagen de la boleta")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="No se pudo analizar la boleta.",
        ) from exc


def _validate_category_ids(supabase, user_id: str, category_ids: set[int]) -> None:
    if not category_ids:
        return

    category_rows = (
        supabase.table("categorias")
        .select("id")
        .in_("id", list(category_ids))
        .or_(f"user_id.is.null,user_id.eq.{user_id}")
        .execute()
    )
    valid_ids = {row["id"] for row in category_rows.data or []}
    if valid_ids != category_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Una o más categorías no existen o no están disponibles para este usuario.",
        )


def _validate_subcategories(supabase, assignments: set[tuple[int, int]]) -> None:
    if not assignments:
        return

    subcategory_rows = (
        supabase.table("subcategorias")
        .select("id, categoria_id")
        .in_("id", list({subcategory_id for subcategory_id, _ in assignments}))
        .execute()
    )
    valid_assignments = {
        row["id"]: row["categoria_id"] for row in subcategory_rows.data or []
    }
    if any(
        valid_assignments.get(subcategory_id) != category_id
        for subcategory_id, category_id in assignments
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cada subcategoría debe pertenecer a la categoría seleccionada en su artículo.",
        )


@router.post("/confirmar-boleta", status_code=status.HTTP_201_CREATED)
def confirmar_boleta(
    boleta: BoletaConfirmada,
    auth_data=Depends(get_supabase_client),
):
    supabase, user_id = auth_data
    merchant_name = boleta.comercio.strip()
    if not merchant_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El nombre del comercio no puede estar vacío.",
        )

    category_ids = {
        category_id
        for category_id in (
            boleta.categoria_id,
            *(item.categoria_id for item in boleta.items),
        )
        if category_id is not None
    }
    _validate_category_ids(supabase, user_id, category_ids)

    subcategory_assignments: set[tuple[int, int]] = set()
    if boleta.subcategoria_id is not None:
        if boleta.categoria_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Selecciona una categoría antes de elegir la subcategoría de la transacción.",
            )
        subcategory_assignments.add(
            (boleta.subcategoria_id, boleta.categoria_id)
        )
    for item in boleta.items:
        if item.subcategoria_id is not None:
            if item.categoria_id is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Selecciona una categoría para cada artículo que tenga subcategoría.",
                )
            subcategory_assignments.add(
                (item.subcategoria_id, item.categoria_id)
            )
    _validate_subcategories(supabase, subcategory_assignments)

    selected_tag_ids = {
        tag_id for item in boleta.items for tag_id in item.etiqueta_ids
    }
    if selected_tag_ids:
        tag_rows = (
            supabase.table("etiquetas")
            .select("id")
            .eq("user_id", user_id)
            .in_("id", list(selected_tag_ids))
            .execute()
        )
        valid_tag_ids = {row["id"] for row in tag_rows.data or []}
        if valid_tag_ids != selected_tag_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Una o más etiquetas no existen o no pertenecen a este usuario.",
            )

    account_rows = (
        supabase.table("cuentas")
        .select("id")
        .eq("id", boleta.cuenta_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not account_rows.data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Selecciona una cuenta válida perteneciente a tu usuario.",
        )

    commerce_rows = (
        supabase.table("comercios")
        .select("id")
        .eq("nombre", merchant_name.title())
        .execute()
    )
    if commerce_rows.data:
        commerce_id = commerce_rows.data[0]["id"]
    else:
        created_commerce = (
            supabase.table("comercios")
            .insert({"nombre": merchant_name.title()})
            .execute()
        )
        if not created_commerce.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="No se pudo guardar el comercio de la transacción.",
            )
        commerce_id = created_commerce.data[0]["id"]

    transaction_data = {
        "user_id": user_id,
        "cuenta_id": boleta.cuenta_id,
        "comercio_id": commerce_id,
        "categoria_id": boleta.categoria_id,
        "subcategoria_id": boleta.subcategoria_id,
        "tipo": "gasto",
        "fecha": boleta.fecha.isoformat(),
        "total": str(boleta.total),
    }
    transaction_id: Optional[int] = None
    created_item_ids: list[int] = []
    try:
        transaction_result = (
            supabase.table("transacciones").insert(transaction_data).execute()
        )
        if not transaction_result.data:
            raise RuntimeError("La base de datos no devolvió la transacción creada.")
        transaction_id = transaction_result.data[0]["id"]

        for item in boleta.items:
            inserted_item = (
                supabase.table("transaccion_items")
                .insert(
                    {
                        "transaccion_id": transaction_id,
                        "producto": item.producto.strip(),
                        "precio": str(item.precio),
                        "categoria_id": item.categoria_id,
                        "subcategoria_id": item.subcategoria_id,
                    }
                )
                .execute()
            )
            if not inserted_item.data:
                raise RuntimeError(
                    "La base de datos no devolvió el artículo creado."
                )
            item_id = inserted_item.data[0]["id"]
            created_item_ids.append(item_id)

            item_tag_rows = [
                {
                    "transaccion_item_id": item_id,
                    "etiqueta_id": tag_id,
                }
                for tag_id in set(item.etiqueta_ids)
            ]
            if item_tag_rows:
                supabase.table("transaccion_item_etiquetas").insert(
                    item_tag_rows
                ).execute()
    except Exception as exc:
        if transaction_id is not None:
            try:
                if created_item_ids:
                    supabase.table("transaccion_items").delete().in_(
                        "id", created_item_ids
                    ).execute()
                supabase.table("transacciones").delete().eq(
                    "id", transaction_id
                ).eq("user_id", user_id).execute()
            except Exception:
                logger.exception(
                    "No se pudo limpiar la transacción incompleta %s",
                    transaction_id,
                )
        logger.exception("No se pudo guardar la boleta confirmada")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="No se pudo guardar la boleta completa. No se confirmó la transacción.",
        ) from exc

    return {
        "mensaje": "Boleta confirmada y guardada con éxito.",
        "transaccion_id": transaction_id,
    }
