export function formatFullPrice(value: number | undefined | null): string {
  if (value === null || value === undefined || !isFinite(value)) return '-';
  if (value === 0) return '0';

  const abs = Math.abs(value);
  let decimals: number;
  if (abs >= 1) decimals = 2;
  else if (abs >= 0.1) decimals = 4;
  else if (abs >= 0.01) decimals = 5;
  else if (abs >= 0.001) decimals = 6;
  else if (abs >= 0.0001) decimals = 7;
  else decimals = 8;

  return value.toFixed(decimals).replace(/\.?0+$/, '');
}
