function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

export function formatAspectRatio(width: number, height: number) {
  if (width <= 0 || height <= 0) return '1:1';

  const ratio = width / height;
  let bestNumerator = 1;
  let bestDenominator = 1;
  let bestError = Number.POSITIVE_INFINITY;

  for (let denominator = 1; denominator <= 32; denominator += 1) {
    const numerator = Math.max(1, Math.round(ratio * denominator));
    if (numerator > 32) continue;
    const error = Math.abs((numerator / denominator) - ratio) / ratio;
    if (error < bestError) {
      bestNumerator = numerator;
      bestDenominator = denominator;
      bestError = error;
    }
  }

  if (bestError <= 0.001) {
    const divisor = greatestCommonDivisor(bestNumerator, bestDenominator);
    return `${bestNumerator / divisor}:${bestDenominator / divisor}`;
  }

  const formatPart = (value: number) => Number(value.toFixed(2)).toString();
  return ratio >= 1 ? `${formatPart(ratio)}:1` : `1:${formatPart(1 / ratio)}`;
}
