export function formatearMontoEnEntrada(raw: string): string {
  const limpios = raw.replace(/[^\d]/g, '');
  if (!limpios) return '$';
  // Solo formatear con puntos de miles cuando ya hay puntos explícitos
  // o cuando se llega a 4+ cifras y el usuario escribió en secuencia.
  if (raw.includes('.') || limpios.length >= 4) {
    const conPuntos = limpios.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `$${conPuntos}`;
  }
  return `$${limpios}`;
}

export function limpiarMontoParaEstado(formateado: string): string {
  let s = formateado.replace(/\$/g, '').trim();
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/\./g, '');
  }
  return s;
}
