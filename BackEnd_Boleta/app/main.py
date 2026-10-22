import logging
import os
import re

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import gastos # Importamos el router que creamos
from app.api.routes import ia

app = FastAPI(title="API de Gastos Avanzada con IA")

# El servicio de OpenCode Desktop (panel de vista previa) sondea /health y
# /v1/models muy seguido y llena la terminal de ruido. Se silencian del access
# log: las peticiones funcionan igual, solo dejan de imprimirse.
_PATRON_RUIDO_ACCESS = re.compile(r'"GET (?:/health|/v1/models) HTTP')


class _FiltroRuidoAccess(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return _PATRON_RUIDO_ACCESS.search(record.getMessage()) is None


logging.getLogger("uvicorn.access").addFilter(_FiltroRuidoAccess())

cors_origins = os.getenv(
    "CORS_ORIGINS",
    (
        "http://localhost:8081,http://localhost:19006,http://localhost:8090,"
        "http://127.0.0.1:8081,http://127.0.0.1:19006,http://127.0.0.1:8090"
    ),
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in cors_origins.split(",") if origin.strip()],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# Registramos las rutas de gastos
app.include_router(gastos.router)
app.include_router(ia.router)

@app.get("/")
def leer_raiz():
    return {"mensaje": "Backend de finanzas avanzado activo 🚀"}


@app.get("/health")
def health():
    """Healthcheck estándar (para monitores, load balancers y despliegues)."""
    return {"status": "ok"}