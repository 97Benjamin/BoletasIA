import os
import asyncio
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from dotenv import load_dotenv

from app.api.dependencies import get_supabase_client
from app.services.ia_clients import generar_texto

from typing import Optional

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

router = APIRouter(prefix="/ia", tags=["ia"])

MAX_LONGITUD_PREGUNTA = 500
LIMITE_TRANSACCIONES = 90
# Solo las transacciones más recientes incluyen su detalle de artículos
# (protege el límite de tokens por minuto del plan free de Groq):
LIMITE_TRANSACCIONES_CON_ARTICULOS = 30
LIMITE_ARTICULOS_POR_TRANSACCION = 25

INSTRUCCIONES = """
Eres el asesor financiero personal de un usuario de la app BoletasIA.
Responde SIEMPRE en español de Chile y en pesos chilenos.
Importante con los números: los montos usan formato chileno, el punto es
separador de miles (1.046 = mil cuarenta y seis) y la coma es decimal.
BoletasIA registra transacciones y cada una puede tener ARTÍCULOS
(productos individuales con su precio y su propia categoría).
La categoría de la transacción es una vista general de la compra; las
categorías de los ARTÍCULOS dicen a qué es cada producto (ejemplo: la
compra de supermercado es "Alimentos" y cada artículo es un lácteo, una
fruta, etc.).
Si te preguntan por los productos de una compra, lista los ARTÍCULOS de
esa transacción con sus precios exactos tal como aparecen en los datos.
Base cada respuesta en los DATOS DEL USUARIO entregados a continuación:
no inventes movimientos, montos ni fechas que no estén en los datos.
Si la información no alcanza para responder algo, dilo explícitamente.
Entrega consejos prácticos y concretos (máximo ~200 palabras),
usando listas o viñetas cuando ayuden.
"""

SUGERENCIAS = [
    "¿Cuánto gasté este mes y en qué?",
    "¿Cuál es mi categoría con más gastos?",
    "¿Cuánto tengo disponible en mis cuentas?",
    "¿Dónde puedo recortar gastos?",
    "¿Cómo puedo empezar a ahorrar más?",
]


class ConsultaRequest(BaseModel):
    pregunta: str
    chat_id: Optional[int] = None


class ConsultaRespuesta(BaseModel):
    respuesta: str
    chat_id: int


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pesos(valor) -> str:
    try:
        return f"${float(valor):,.0f}".replace(",", ".")
    except (TypeError, ValueError):
        return "$0"


def _texto(valor) -> str:
    return str(valor) if valor else ""


def _construir_contexto(supabase, user_id: str) -> str:
    secciones: list[str] = []

    cuentas = (
        supabase.table("cuentas")
        .select("id,nombre,tipo,banco,saldo_actual,cupo,dia_corte,dia_pago")
        .eq("user_id", user_id)
        .execute()
    ).data or []

    if cuentas:
        lineas = ["CUENTAS:"]
        for cuenta in cuentas:
            banco = _texto(cuenta.get("banco"))
            tipo = _texto(cuenta.get("tipo")) or "sin tipo"
            detalle = f" [{tipo}{', ' + banco if banco else ''}]"
            sal = cuenta.get("saldo_actual")
            cupo = cuenta.get("cupo")
            if tipo == "credito" and cupo is not None:
                disponible = float(sal or 0)
                cupo_f = float(cupo)
                deuda = max(cupo_f - disponible, 0)
                corte = cuenta.get("dia_corte")
                pago = cuenta.get("dia_pago")
                ciclo = f" · Corte día {corte}" if corte else ""
                ciclo += f" · Pago día {pago}" if pago else ""
                lineas.append(
                    f"- {cuenta.get('nombre')}: Cupo {_pesos(cupo_f)} · Deuda {_pesos(deuda)} · "
                    f"Disponible {_pesos(disponible)}{detalle}{ciclo}"
                )
            else:
                lineas.append(
                    f"- {cuenta.get('nombre')}: {_pesos(sal)}{detalle}"
                )
        secciones.append("\n".join(lineas))
    else:
        secciones.append("CUENTAS: el usuario aún no tiene cuentas registradas.")

    filas = (
        supabase.table("transacciones")
        .select("id,fecha,total,tipo,frecuencia,comercio_id,categoria_id,cuenta_id")
        .eq("user_id", user_id)
        .order("fecha", desc=True)
        .limit(LIMITE_TRANSACCIONES)
        .execute()
    ).data or []

    if not filas:
        secciones.append(
            "TRANSACCIONES: el usuario todavía no tiene transacciones registradas."
        )
        return "\n\n".join(secciones)

    comercio_ids = sorted({t["comercio_id"] for t in filas if t.get("comercio_id")})
    categoria_ids = sorted({t["categoria_id"] for t in filas if t.get("categoria_id")})
    cuenta_ids = sorted({t["cuenta_id"] for t in filas if t.get("cuenta_id")})

    comercios: dict = {}
    if comercio_ids:
        resultado = (
            supabase.table("comercios")
            .select("id,nombre")
            .in_("id", comercio_ids)
            .execute()
        )
        comercios = {r["id"]: _texto(r.get("nombre")) for r in (resultado.data or [])}

    # ARTÍCULOS (detalle de boleta) de las transacciones más recientes.
    ids_recientes = [
        fila["id"] for fila in reversed(filas)
    ][:LIMITE_TRANSACCIONES_CON_ARTICULOS]
    articulos: dict = {}
    ids_categ_articulo: set = set()
    if ids_recientes:
        resultado = (
            supabase.table("transaccion_items")
            .select("transaccion_id,producto,precio,categoria_id")
            .in_("transaccion_id", ids_recientes)
            .execute()
        )
        for articulo in resultado.data or []:
            articulos.setdefault(articulo["transaccion_id"], []).append(articulo)
            if articulo.get("categoria_id"):
                ids_categ_articulo.add(articulo["categoria_id"])

    categoria_ids = sorted(set(categoria_ids) | ids_categ_articulo)

    categorias: dict = {}
    if categoria_ids:
        resultado = (
            supabase.table("categorias")
            .select("id,nombre")
            .in_("id", categoria_ids)
            .execute()
        )
        categorias = {r["id"]: _texto(r.get("nombre")) for r in (resultado.data or [])}

    nombres_cuentas: dict = {}
    if cuenta_ids:
        resultado = (
            supabase.table("cuentas")
            .select("id,nombre")
            .in_("id", cuenta_ids)
            .execute()
        )
        nombres_cuentas = {r["id"]: _texto(r.get("nombre")) for r in (resultado.data or [])}

    detalle = ["TRANSACCIONES RECIENTES (más antiguas primero, hasta la más reciente):"]
    for fila in reversed(filas):
        comercio = comercios.get(fila.get("comercio_id"), "Comercio sin nombre")
        categoria = categorias.get(fila.get("categoria_id"), "Sin categoría")
        cuenta = nombres_cuentas.get(fila.get("cuenta_id"), "Cuenta sin nombre")
        detalle.append(
            f"- {_texto(fila.get('fecha'))[:10]} | {comercio} | {_pesos(fila.get('total'))} | "
            f"{categoria} | {_texto(fila.get('tipo')) or 'gasto'} | {cuenta}"
        )
        articulos_fila = articulos.get(fila.get("id")) or []
        if articulos_fila:
            detalle.append("  ARTÍCULOS DE ESTA COMPRA:")
            for articulo in articulos_fila[:LIMITE_ARTICULOS_POR_TRANSACCION]:
                cat_articulo = categorias.get(
                    articulo.get("categoria_id"), "Sin categoría"
                )
                detalle.append(
                    f"  - {_texto(articulo.get('producto'))} | "
                    f"{_pesos(articulo.get('precio'))} | {cat_articulo}"
                )
            excedente = len(articulos_fila) - LIMITE_ARTICULOS_POR_TRANSACCION
            if excedente > 0:
                detalle.append(f"  ... y {excedente} artículos más")
    secciones.append("\n".join(detalle))

    por_mes: dict[str, float] = defaultdict(float)
    por_categoria: dict[str, float] = defaultdict(float)
    por_comercio: dict[str, list[float]] = defaultdict(lambda: [0.0, 0])
    for fila in filas:
        monto = float(fila.get("total") or 0)
        mes = _texto(fila.get("fecha"))[:7] or "desconocido"
        por_mes[mes] += monto
        if _texto(fila.get("tipo")) != "ingreso":
            por_categoria[
                categorias.get(fila.get("categoria_id"), "Sin categoría")
            ] += monto
            nom_comercio = comercios.get(fila.get("comercio_id"), "Comercio sin nombre")
            por_comercio[nom_comercio][0] += monto
            por_comercio[nom_comercio][1] += 1

    resumen = ["RESUMENES (sobre las transacciones anteriores):", "Gasto por mes:"]
    resumen.extend(f"- {mes}: {_pesos(monto)}" for mes, monto in sorted(por_mes.items()))
    resumen.append("Gasto por categoría:")
    resumen.extend(
        f"- {nombre}: {_pesos(monto)}"
        for nombre, monto in sorted(por_categoria.items(), key=lambda item: -item[1])
    )
    resumen.append("Comercios más frecuentes:")
    resumen.extend(
        f"- {nombre}: {_pesos(total)} en {int(veces)} compras"
        for nombre, (total, veces) in sorted(
            por_comercio.items(), key=lambda item: -item[1][0]
        )[:10]
    )
    secciones.append("\n".join(resumen))

    # PRESUPUESTOS definidos por el usuario
    try:
        presupuestos_raw = (
            supabase.table("presupuestos")
            .select("id,nombre,monto_mensual")
            .eq("user_id", user_id)
            .execute()
        ).data or []
        if presupuestos_raw:
            lineas_pres = ["PRESUPUESTOS DEL USUARIO:"]
            for p in presupuestos_raw:
                nombre_p = _texto(p.get("nombre")) or "Sin nombre"
                monto_p = float(p.get("monto_mensual") or 0)
                lineas_pres.append(
                    f"- {nombre_p}: {_pesos(monto_p)} mensual"
                )
            secciones.append("\n".join(lineas_pres))
    except Exception:
        pass

    return "\n\n".join(secciones)


@router.get("/sugerencias")
def sugerencias() -> dict:
    return {"sugerencias": SUGERENCIAS}


@router.post("/consultar", response_model=ConsultaRespuesta)
async def consultar(
    consulta: ConsultaRequest,
    supabase_y_usuario: tuple = Depends(get_supabase_client),
) -> ConsultaRespuesta:
    supabase, user_id = supabase_y_usuario

    pregunta = consulta.pregunta.strip()[:MAX_LONGITUD_PREGUNTA]
    if not pregunta:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Escribe una pregunta para el asistente.",
        )

    # Resuelve el chat: valida el existente o crea uno nuevo
    chat_id = consulta.chat_id
    chat_nuevo = False
    titulo_actual = ""
    try:
        if chat_id is not None:
            existe = (
                supabase.table("chats")
                .select("id,titulo")
                .eq("id", chat_id)
                .limit(1)
                .execute()
            )
            filas_chat = existe.data or []
            if not filas_chat:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="El chat indicado no existe.",
                )
            titulo_actual = _texto(filas_chat[0].get("titulo"))
        else:
            creado = (
                supabase.table("chats")
                .insert({"titulo": pregunta[:40]})
                .select("id")
                .execute()
            )
            filas_chat = creado.data or []
            if not filas_chat or "id" not in filas_chat[0]:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="No se pudo crear el chat en Supabase.",
                )
            chat_id = int(filas_chat[0]["id"])
            chat_nuevo = True
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"No se pudo preparar el chat: {exc}",
        ) from exc

    # Historial reciente de la conversación (últimos 6 mensajes)
    historial_mensajes: list[dict] = []
    try:
        previos = (
            supabase.table("chat_mensajes")
            .select("rol,contenido")
            .eq("chat_id", chat_id)
            .order("id", desc=True)
            .limit(6)
            .execute()
        )
        desde = list(reversed(previos.data or []))
        historial_mensajes = [
            {
                "role": "assistant" if m.get("rol") == "ia" else "user",
                "content": _texto(m.get("contenido"))[:500],
            }
            for m in desde
        ]
    except Exception as exc:  # noqa: BLE001
        print(f"[ia] sin historial de chat {chat_id}: {exc}")

    try:
        contexto = _construir_contexto(supabase, user_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"No se pudieron leer tus datos en Supabase: {exc}",
        ) from exc

    mensajes_ia = [
        {
            "role": "system",
            "content": f"{INSTRUCCIONES}\n\nDATOS DEL USUARIO:\n{contexto}",
        },
        *historial_mensajes,
        {"role": "user", "content": pregunta},
    ]

    try:
        texto = await asyncio.to_thread(generar_texto, mensajes_ia, 0.3)
    except Exception as exc:  # noqa: BLE001
        if chat_nuevo and chat_id is not None:
            try:
                supabase.table("chats").delete().eq("id", chat_id).execute()
            except Exception:  # noqa: BLE001
                pass
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc

    if not texto:
        if chat_nuevo and chat_id is not None:
            try:
                supabase.table("chats").delete().eq("id", chat_id).execute()
            except Exception:  # noqa: BLE001
                pass
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="El asistente IA no devolvió respuesta. Intenta de nuevo.",
        )

    # Guardar el turno en el historial del chat
    try:
        supabase.table("chat_mensajes").insert(
            {"chat_id": chat_id, "rol": "user", "contenido": pregunta}
        ).execute()
        supabase.table("chat_mensajes").insert(
            {"chat_id": chat_id, "rol": "ia", "contenido": texto}
        ).execute()
        campos: dict = {"actualizado_en": _ahora()}
        if not titulo_actual or titulo_actual == "Nuevo chat":
            campos["titulo"] = pregunta[:40]
        supabase.table("chats").update(campos).eq("id", chat_id).execute()
    except Exception as exc:  # noqa: BLE001
        print(f"[ia] no se pudo guardar el turno en {chat_id}: {exc}")

    return ConsultaRespuesta(respuesta=texto, chat_id=chat_id)
