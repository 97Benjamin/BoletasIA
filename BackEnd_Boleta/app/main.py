import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import gastos # Importamos el router que creamos

app = FastAPI(title="API de Gastos Avanzada con IA")

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

@app.get("/")
def leer_raiz():
    return {"mensaje": "Backend de finanzas avanzado activo 🚀"}