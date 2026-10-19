const chileanPesoFormatter = new Intl.NumberFormat('es-CL', {
  style: 'currency',
  currency: 'CLP',
  currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatChileanPesos(amount: number): string {
  const parts = chileanPesoFormatter.formatToParts(Math.abs(amount));
  const symbol = parts.find((part) => part.type === 'currency')?.value ?? '$';
  const value = parts
    .filter((part) => part.type !== 'currency' && part.type !== 'literal')
    .map((part) => part.value)
    .join('');

  return `${amount < 0 ? '-' : ''}${symbol}${value}`;
}
