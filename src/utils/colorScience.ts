const SRGB_EPSILON = 0.04045;
const XYZ_EPSILON = 216 / 24389;
const XYZ_KAPPA = 24389 / 27;
const REF_X = 95.047;
const REF_Y = 100;
const REF_Z = 108.883;

function srgbChannelToLinear(value: number) {
  const normalized = value / 255;
  if (normalized <= SRGB_EPSILON) {
    return normalized / 12.92;
  }
  return Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function linearChannelToSrgb(value: number) {
  const normalized = Math.min(1, Math.max(0, value));
  if (normalized <= 0.0031308) {
    return normalized * 12.92;
  }
  return 1.055 * Math.pow(normalized, 1 / 2.4) - 0.055;
}

function pivotXyz(value: number) {
  return value > XYZ_EPSILON ? Math.cbrt(value) : ((XYZ_KAPPA * value) + 16) / 116;
}

function inversePivotXyz(value: number) {
  const cubed = value ** 3;
  return cubed > XYZ_EPSILON ? cubed : (116 * value - 16) / XYZ_KAPPA;
}

export function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const linearR = srgbChannelToLinear(r);
  const linearG = srgbChannelToLinear(g);
  const linearB = srgbChannelToLinear(b);

  const x = ((linearR * 0.4124564) + (linearG * 0.3575761) + (linearB * 0.1804375)) * 100;
  const y = ((linearR * 0.2126729) + (linearG * 0.7151522) + (linearB * 0.072175)) * 100;
  const z = ((linearR * 0.0193339) + (linearG * 0.119192) + (linearB * 0.9503041)) * 100;

  const fx = pivotXyz(x / REF_X);
  const fy = pivotXyz(y / REF_Y);
  const fz = pivotXyz(z / REF_Z);

  return [
    (116 * fy) - 16,
    500 * (fx - fy),
    200 * (fy - fz),
  ];
}

export function labToSrgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;

  const x = REF_X * inversePivotXyz(fx);
  const y = REF_Y * inversePivotXyz(fy);
  const z = REF_Z * inversePivotXyz(fz);

  const normalizedX = x / 100;
  const normalizedY = y / 100;
  const normalizedZ = z / 100;

  const linearR = (normalizedX * 3.2404542) + (normalizedY * -1.5371385) + (normalizedZ * -0.4985314);
  const linearG = (normalizedX * -0.969266) + (normalizedY * 1.8760108) + (normalizedZ * 0.041556);
  const linearB = (normalizedX * 0.0556434) + (normalizedY * -0.2040259) + (normalizedZ * 1.0572252);

  return [
    Math.round(linearChannelToSrgb(linearR) * 255),
    Math.round(linearChannelToSrgb(linearG) * 255),
    Math.round(linearChannelToSrgb(linearB) * 255),
  ];
}

export function deltaE(lab1: [number, number, number], lab2: [number, number, number]) {
  return Math.sqrt(
    (lab1[0] - lab2[0]) ** 2 +
    (lab1[1] - lab2[1]) ** 2 +
    (lab1[2] - lab2[2]) ** 2,
  );
}
