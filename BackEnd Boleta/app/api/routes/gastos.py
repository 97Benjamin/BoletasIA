from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from app.api.dependencies import get_supabase_client
from app.services.boletas import extraer_datos_con_gemini
from pydantic import ValidationError

router = APIRouter(prefix="/gastos", tags=["Gastos"])

@router.post("/procesar-boleta")
async def procesar_boleta(
    file: UploadFile = File(...),
    auth_data = Depends(get_supabase_client)
):
    supabase, user_id = auth_data
    
    if not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="El archivo debe ser una imagen.")
    
    try:
        image_bytes = await file.read()
        
        # 1. Extracción y Validación estricta con Gemini
        datos = await extraer_datos_con_gemini(image_bytes, file.content_type)
        
        # 2. Gestión de Comercio
        comercio_nombre = datos.comercio.strip().title()
        comercio_res = supabase.table("comercios").select("id").eq("nombre", comercio_nombre).execute()
        
        if comercio_res.data:
            comercio_id = comercio_res.data[0]["id"]
        else:
            nuevo_comercio = supabase.table("comercios").insert({"nombre": comercio_nombre}).execute()
            comercio_id = nuevo_comercio.data[0]["id"]

        # 3. Mapeo de Categoría
        cat_res = supabase.table("categorias").select("id").eq("nombre", datos.categoria_general.value).execute()
        categoria_id = cat_res.data[0]["id"] if cat_res.data else 1 

        # 4. Inserción en la tabla transacciones (nombre real en BD)
        transaccion_data = {
            "user_id": user_id,
            "cuenta_id": 1, # O el ID de cuenta predeterminado/seleccionado por el usuario
            "comercio_id": comercio_id,
            "categoria_id": categoria_id,
            "tipo": "gasto", # Requerido por el CHECK de la tabla
            "fecha": datos.fecha.isoformat(),
            "total": str(datos.total)
        }
        transaccion_res = supabase.table("transacciones").insert(transaccion_data).execute()
        transaccion_id = transaccion_res.data[0]["id"]

        # 5. Inserción de Ítems filtrando valores inválidos o en cero
        if datos.items:
            items_data = [
                {
                    "transaccion_id": transaccion_id,
                    "producto": item.producto,
                    "precio": str(item.precio)
                }
                for item in datos.items
                if item.precio > 0  # Ignora ítems con precio 0 o negativo
            ]
            
            if items_data:
                supabase.table("transaccion_items").insert(items_data).execute()

        return {
            "mensaje": "Boleta procesada y guardada con éxito",
            "transaccion_id": transaccion_id,
            "datos_extraidos": datos.model_dump(mode='json')
        }

    except ValidationError as e:
        raise HTTPException(status_code=422, detail=f"Error en los datos extraídos: {e.errors()}")
    except Exception as e:
        if "503" in str(e) or "UNAVAILABLE" in str(e):
            raise HTTPException(
                status_code=503, 
                detail="El servicio de IA está experimentando alta demanda en este momento. Por favor, intenta de nuevo en unos segundos."
            )
        raise HTTPException(status_code=500, detail=f"Error procesando la boleta: {str(e)}")