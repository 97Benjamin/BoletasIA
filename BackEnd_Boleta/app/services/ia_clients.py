"""Clientes de IA (todos free-tier) y cadena de respuesta para el asistente.

Orden para el CHAT: GROQ (1.000/día) -> GEMINI (miles/día) -> OPENROUTER (router openrouter/free).
El fallback de BOLETAS (Gemini -> OpenRouter Gemma) vive en servicios/boletas.py.
"""

import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

GROQ_MODELO = os.getenv("GROQ_MODELO") or "openai/gpt-oss-120b"
GEMINI_MODELO = os.getenv("GEMINI_MODELO") or "gemini-3.6-flash"
OPENROUTER_MODELO = os.getenv("OPENROUTER_MODELO") or "openrouter/free"
OPENROUTER_MODELO_BOLETAS = (
    os.getenv("OPENROUTER_MODELO_BOLETAS")
    or "google/gemma-4-26b-a4b-it:free"
)

_GROQ: Optional[OpenAI] = None
_OPENROUTER: Optional[OpenAI] = None
_GEMINI = None


def _cliente_groq() -> Optional[OpenAI]:
    global _GROQ
    if _GROQ is None and os.getenv("GROQ_API_KEY"):
        _GROQ = OpenAI(
            base_url="https://api.groq.com/openai/v1",
            api_key=os.getenv("GROQ_API_KEY"),
            timeout=90.0,
            max_retries=0,
        )
    return _GROQ


def _cliente_openrouter() -> Optional[OpenAI]:
    global _OPENROUTER
    if _OPENROUTER is None and os.getenv("OPENROUTER_API_KEY"):
        _OPENROUTER = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=os.getenv("OPENROUTER_API_KEY"),
            timeout=90.0,
            max_retries=0,
        )
    return _OPENROUTER


def _cliente_gemini():
    global _GEMINI
    if _GEMINI is None and os.getenv("GEMINI_API_KEY"):
        from google import genai

        _GEMINI = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    return _GEMINI


def _resumen_error(exc: Exception) -> str:
    return "{}: {}".format(type(exc).__name__, str(exc)[:180])


def texto_de_mensajes(mensajes) -> str:
    """Convierte mensajes estilo OpenAI en un prompt de un bloque (para Gemini)."""
    bloques = []
    for mensaje in mensajes:
        rol = mensaje.get("role")
        contenido = mensaje.get("content") or ""
        if rol == "system":
            bloques.append(contenido)
        elif rol == "assistant":
            bloques.append(
                "RESPUESTA ANTERIOR DEL ASISTENTE:\n{}".format(contenido)
            )
        else:
            bloques.append("PREGUNTA DEL USUARIO:\n{}".format(contenido))
    return "\n\n".join(bloques)


def generar_texto(mensajes, temperature: float = 0.3) -> str:
    """Cadena del chat: Groq -> Gemini -> OpenRouter. Lanza RuntimeError si todos fallan."""
    errores = []

    groq = _cliente_groq()
    if groq is not None:
        try:
            respuesta = groq.chat.completions.create(
                model=GROQ_MODELO,
                messages=mensajes,
                temperature=temperature,
            )
            texto = (respuesta.choices[0].message.content or "").strip()
            if texto:
                return texto
            errores.append("Groq devolvió respuesta vacía")
        except Exception as exc:  # noqa: BLE001
            errores.append("Groq: " + _resumen_error(exc))

    gemini = _cliente_gemini()
    if gemini is not None:
        try:
            from google.genai import types as genai_types

            respuesta = gemini.models.generate_content(
                model=GEMINI_MODELO,
                contents=texto_de_mensajes(mensajes),
                config=genai_types.GenerateContentConfig(
                    temperature=temperature
                ),
            )
            texto = (respuesta.text or "").strip()
            if texto:
                return texto
            errores.append("Gemini devolvió respuesta vacía")
        except Exception as exc:  # noqa: BLE001
            errores.append("Gemini: " + _resumen_error(exc))

    openrouter = _cliente_openrouter()
    if openrouter is not None:
        try:
            respuesta = openrouter.chat.completions.create(
                model=OPENROUTER_MODELO,
                messages=mensajes,
                temperature=temperature,
            )
            texto = (respuesta.choices[0].message.content or "").strip()
            if texto:
                return texto
            errores.append("OpenRouter devolvió respuesta vacía")
        except Exception as exc:  # noqa: BLE001
            errores.append("OpenRouter: " + _resumen_error(exc))

    if errores:
        raise RuntimeError(
            "Ningún proveedor de IA respondió. " + " | ".join(errores)
        )
    raise RuntimeError("No hay proveedores de IA configurados en el .env.")
