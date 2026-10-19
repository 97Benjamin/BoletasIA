from pydantic import BaseModel, Field
from decimal import Decimal
from enum import Enum
from datetime import date
from typing import Optional

class CategoriaSugerida(str, Enum):
    ALIMENTACION = 'Alimentos'
    SALUD = 'Salud y Farmacia'
    TRANSPORTE = 'Transporte'
    SERVICIOS = 'Servicios y Hogar'
    ENTRETENIMIENTO = 'Entretenimiento'
    OTROS = 'Otros'

class GastoItemSchema(BaseModel):
    producto: str = Field(..., description="Nombre limpio del producto o ítem.")
    precio: Decimal = Field(..., description="Precio final o unitario ajustado tras descuentos.")
    # NUEVO: Le pedimos a Gemini que clasifique cada producto individualmente
    categoria: CategoriaSugerida = Field(..., description="Categoría a la que pertenece este producto específico.")

class GastoRespuestaSchema(BaseModel):
    comercio: str = Field(..., description="Nombre normalizado del comercio.")
    categoria_general: CategoriaSugerida = Field(..., description="Categoría principal que mejor describe toda la boleta.")
    fecha: date = Field(..., description="Fecha de la boleta en formato YYYY-MM-DD.")
    total: Decimal = Field(..., description="Monto total final pagado en la boleta.")
    items: list[GastoItemSchema]


class ItemBoletaConfirmado(BaseModel):
    producto: str = Field(..., min_length=1, max_length=300)
    precio: Decimal = Field(..., ge=0)
    categoria_id: Optional[int] = None
    subcategoria_id: Optional[int] = None
    etiqueta_ids: list[int] = Field(default_factory=list)


class BoletaConfirmada(BaseModel):
    cuenta_id: int
    comercio: str = Field(..., min_length=1, max_length=200)
    fecha: date
    total: Decimal = Field(..., gt=0)
    categoria_id: Optional[int] = None
    subcategoria_id: Optional[int] = None
    items: list[ItemBoletaConfirmado] = Field(default_factory=list)