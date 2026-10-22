"""Extracción de datos de boletas: cadena Gemini -> OpenRouter (Gemma)."""

import os
import json
import base64
import asyncio
from pathlib import Path

from dotenv import load_dotenv

from app.schemas.boleta import GastoRespuestaSchema
from app.services.ia_clients import (
    GEMINI_MODELO,
    OPENROUTER_MODELO_BOLETAS,
    _cliente_gemini,
    _cliente_openrouter,
    _resumen_error,
)

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

PROMPT_TEXTO = """
Analiza esta boleta de compra chilena con alta precisión.
1. Extrae el nombre del comercio estandarizado (Título, una marca).
2. Clasifica el gasto eligiendo una y solo una categoría de la lista permitida
   para el conjunto de la boleta, y lo mismo para cada ítem.
3. Extrae la fecha en formato YYYY-MM-DD. Si no hay año claro, asume el año actual.
4. Extrae el monto total pagado (en pesos chilenos, número entero sin separadores;
   en Chile el punto es separador de miles).
5. Extrae el listado de todos los ítems con sus respectivos precios
   (números enteros; el punto es separador de miles).

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin texto antes ni después,
sin bloques de código markdown), con exactamente esta estructura:

{
  "comercio": "Nombre del comercio",
  "categoria_general": "Alimentos|Salud y Farmacia|Transporte|Servicios y Hogar|Entretenimiento|Otros",
  "fecha": "YYYY-MM-DD",
  "total": 0,
  "items": [
    {
      "producto": "Nombre limpio del producto",
      "precio": 0,
      "categoria": "Alimentos|Salud y Farmacia|Transporte|Servicios y Hogar|Entretenimiento|Otros"
    }
  ]
}
"""


def _extraer_json(texto: str) -> dict:
    """Tolerante: acepta JSON con fences markdown o texto previo/posterior."""
    limpio = texto.strip()
    if limpio.startswith("```"):
        limpio = limpio.strip("`")
        if limpio.lower().startswith("json"):
            limpio = limpio[4:]
        limpio = limpio.strip()
    try:
        return json.loads(limpio)
    except json.JSONDecodeError:
        inicio = limpio.find("{")
        fin = limpio.rfind("}")
        if inicio >= 0 and fin > inicio:
            return json.loads(limpio[inicio : fin + 1])
        raise


def _es_reintentable(exc: Exception) -> bool:
    status = getattr(exc, "status_code", None)
    texto = str(exc).lower()
    return (
        status in (429, 500, 502, 503, 504)
        or "429" in texto
        or "rate limit" in texto
        or "resource_exhausted" in texto
        or "503" in texto
        or "unavailable" in texto
        or "high demand" in texto
    )


async def _con_gemini(image_bytes: bytes, mime_type: str) -> GastoRespuestaSchema:
    """Primera opción: Gemini con esquema de respuesta forzado."""
    cliente = _cliente_gemini()
    if cliente is None:
        raise TypeError(
            "GEMINI_API_KEY no está configurada en el .env del backend."
        )

    from google.genai import types as genai_types

    delay = 2
    for intento in range(3):
        try:
            respuesta = cliente.models.generate_content(
                model=GEMINI_MODELO,
                contents=[
                    genai_types.Part.from_bytes(
                        data=image_bytes, mime_type=mime_type
                    ),
                    PROMPT_TEXTO,
                ],
                config=genai_types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=GastoRespuestaSchema,
                    temperature=0.0,
                ),
            )
            datos_crudos = _extraer_json(respuesta.text or "")
            return GastoRespuestaSchema.model_validate(datos_crudos)
        except Exception as exc:  # noqa: BLE001
            if _es_reintentable(exc) and intento < 2:
                print(
                    "Gemini ocupado. Reintentando en %ss (intento %s/3)"
                    % (delay, intento + 1)
                )
                await asyncio.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError("Gemini: " + _resumen_error(exc)) from exc


async def _con_openrouter(image_bytes: bytes, mime_type: str) -> GastoRespuestaSchema:
    """Segunda opción: Gemma 4 26B vía OpenRouter."""
    cliente = _cliente_openrouter()
    if cliente is None:
        raise TypeError("OPENROUTER_API_KEY no está configurada en el .env.")

    imagen_url = (
        "data:{};base64,{}".format(mime_type, base64.b64encode(image_bytes).decode())
    )
    delay = 2
    for intento in range(3):
        try:
            respuesta = cliente.chat.completions.create(
                model=OPENROUTER_MODELO_BOLETAS,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": PROMPT_TEXTO},
                            {"type": "image_url", "image_url": {"url": imagen_url}},
                        ],
                    }
                ],
                temperature=0.0,
            )
            texto = respuesta.choices[0].message.content or ""
            datos_crudos = _extraer_json(texto)
            return GastoRespuestaSchema.model_validate(datos_crudos)
        except Exception as exc:  # noqa: BLE001
            if _es_reintentable(exc) and intento < 2:
                print(
                    "OpenRouter ocupado. Reintentando en %ss (intento %s/3)"
                    % (delay, intento + 1)
                )
                await asyncio.sleep(delay)
                delay *= 2
                continue
            status = getattr(exc, "status_code", None)
            if status == 429:
                raise RuntimeError(
                    "OpenRouter: se agotaron las consultas gratuitas del día "
                    "(se reinician cada día)."
                ) from exc
            if status in (401, 403):
                raise RuntimeError(
                    "OpenRouter: la clave es inválida o no tiene permiso."
                ) from exc
            raise RuntimeError(
                "OpenRouter: " + _resumen_error(exc)
            ) from exc


async def extraer_datos_boleta(image_bytes: bytes, mime_type: str) -> GastoRespuestaSchema:
    """Cadena: Gemini primero (más cuota free y esquema forzado);
    si falla, OpenRouter con Gemma 4 26B."""
    errores = []
    try:
        return await _con_gemini(image_bytes, mime_type)
    except Exception as exc:  # noqa: BLE001
        errores.append(str(exc))
        print("Gemini falló para la boleta:", str(exc)[:200])

    try:
        return await _con_openrouter(image_bytes, mime_type)
    except Exception as exc:  # noqa: BLE001
        errores.append(str(exc))
        print("OpenRouter falló para la boleta:", str(exc)[:200])

    raise RuntimeError(
        "No se pudo interpretar la boleta con ningún proveedor. "
        + " | ".join(errores)
    )
