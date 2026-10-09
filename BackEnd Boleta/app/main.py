from fastapi import FastAPI
from app.api.routes import gastos # Importamos el router que creamos

app = FastAPI(title="API de Gastos Avanzada con IA")

# Registramos las rutas de gastos
app.include_router(gastos.router)

@app.get("/")
def leer_raiz():
    return {"mensaje": "Backend de finanzas avanzado activo 🚀"}