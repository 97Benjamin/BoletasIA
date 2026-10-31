type EtiquetaConIcono = {
  nombre: string;
  icono?: string | null;
};

// Etiquetas: texto para chips y resúmenes. Si la etiqueta tiene un icono
// guardado (columna etiquetas.icono, ej. "🐜" para Gasto hormiga) se muestra
// antes del nombre; si no, se preserva el prefijo "#" de siempre.
export function textoEtiqueta(etiqueta: EtiquetaConIcono): string {
  const nombre = etiqueta.nombre.trim();
  return etiqueta.icono ? `${etiqueta.icono} ${nombre}` : `#${nombre}`;
}

// Normaliza el valor recibido (puede venir de PostgREST como string | null)
// a string | null, descartando cadenas vacías o con solo espacios.
export function iconoNormalizado(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
