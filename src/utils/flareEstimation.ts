export function estimateFlare(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): [number, number, number] {
  const totalPixels = Math.max(1, width * height);
  const target = Math.max(1, Math.ceil(totalPixels * 0.005));
  const histogramR = new Uint32Array(256);
  const histogramG = new Uint32Array(256);
  const histogramB = new Uint32Array(256);

  for (let index = 0; index < pixels.length; index += 4) {
    histogramR[pixels[index]] += 1;
    histogramG[pixels[index + 1]] += 1;
    histogramB[pixels[index + 2]] += 1;
  }

  return [
    percentileFromHistogram(histogramR, target),
    percentileFromHistogram(histogramG, target),
    percentileFromHistogram(histogramB, target),
  ];
}

function percentileFromHistogram(histogram: Uint32Array, target: number) {
  let cumulative = 0;

  for (let value = 0; value < histogram.length; value += 1) {
    cumulative += histogram[value];
    if (cumulative >= target) {
      return value;
    }
  }

  return 255;
}
