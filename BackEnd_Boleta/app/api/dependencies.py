import os
from pathlib import Path

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from supabase import AuthApiError, Client, create_client
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")
security = HTTPBearer()


def get_supabase_client(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> tuple[Client, str]:
    token = credentials.credentials

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_KEY")
    if not supabase_url or not supabase_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "Falta configurar SUPABASE_URL o SUPABASE_ANON_KEY "
                "en el backend."
            ),
        )
    if supabase_key.startswith("sb_secret_"):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "SUPABASE_ANON_KEY no puede ser una clave secreta sb_secret_. "
                "Configura la clave publishable/anon del mismo proyecto Supabase."
            ),
        )

    try:
        client: Client = create_client(supabase_url, supabase_key)
        user_response = client.auth.get_user(token)
    except AuthApiError as exc:
        if "unregistered api key" in exc.message.lower():
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=(
                    "Supabase no reconoce la API key del backend. Revisa que "
                    "SUPABASE_URL y SUPABASE_ANON_KEY pertenezcan al mismo "
                    "proyecto y que la clave sea publishable/anon, no una "
                    "clave secreta."
                ),
            ) from exc
        if exc.status in (400, 401, 403):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=(
                    "Supabase rechazó la sesión: "
                    f"{exc.message} (código: {exc.code or 'no disponible'})."
                ),
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"No se pudo validar la sesión con Supabase (HTTP {exc.status}).",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No se pudo conectar con Supabase para validar la sesión.",
        ) from exc

    if not user_response or not user_response.user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Supabase no encontró un usuario para esta sesión. Inicia sesión nuevamente.",
        )

    client.postgrest.auth(token)
    user_id = str(user_response.user.id)

    return client, user_id