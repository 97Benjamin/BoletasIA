import os
import json
import asyncio
from google import genai
from google.genai import types
from google.genai.errors import APIError  # O la excepción genérica de errores
from app.schemas.boleta import GastoRespuestaSchema

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

PROMPT_TEXTO = """
Analiza esta boleta de compra con alta precisión. 
1. Extrae el nombre del comercio estandarizado.
2. Clasifica el gasto eligiendo una y solo una categoría de la lista permitida.
3. Extrae la fecha en formato YYYY-MM-DD. Si no hay año claro, asume el año actual.
4. Extrae el monto total pagado.
5. Extrae el listado de todos los ítems con sus respectivos precios.
"""

async def extraer_datos_con_gemini(image_bytes: bytes, mime_type: str, max_retries: int = 3) -> GastoRespuestaSchema:
    delay = 2  # Segundos de espera iniciales
    
    for intento in range(max_retries):
        try:
            response = client.models.generate_content(
                model='gemini-3.6-flash',
                contents=[
                    types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                    PROMPT_TEXTO
                ],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=GastoRespuestaSchema,
                    temperature=0.0
                ),
            )
            datos_crudos = json.loads(response.text)
            return GastoRespuestaSchema.model_validate(datos_crudos)
            
        except Exception as e:
            # Verificamos si es un error 503 o de alta demanda
            error_str = str(e)
            if "503" in error_str or "UNAVAILABLE" in error_str or "high demand" in error_str:
                if intento < max_retries - 1:
                    print(f"Gemini ocupado (503). Reintentando en {delay} segundos... (Intento {intento + 1}/{max_retries})")
                    await asyncio.sleep(delay)
                    delay *= 2  # Duplicamos el tiempo de espera para el siguiente intento (backoff exponencial)
                    continue
            # Si es otro error o se agotaron los reintentos, relanzamos la excepción
            raise e