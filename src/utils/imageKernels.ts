// The generated module is reproducible with `npm run build:kernels`. A worker
// loads it once; unavailable WebAssembly keeps the reference TypeScript path.
interface KernelExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  allocate: (kind: number, length: number) => number;
  pointer: (handle: number) => number;
  release: (handle: number) => void;
  process: (data: number, channels: number, params: number, curves: number) => number;
  transform: (source: number, width: number, height: number, output: number, params: number) => number;
  flat_field: (data: number, params: number, gains: number, decode: number, encode: number) => number;
}

type Samples = Float32Array | Float64Array | Uint16Array;
const BATCH_PIXELS = 16384;

export class ImageKernels {
  private readonly exports: KernelExports;
  constructor(instance: WebAssembly.Instance) { this.exports = instance.exports as KernelExports; }
  get memoryBytes() { return this.exports.memory.buffer.byteLength; }
  private allocate(kind: number, length: number) {
    const handle = this.exports.allocate(kind, length);
    if (!handle) throw new Error('Image kernel allocation failed.');
    return handle;
  }
  private view(kind: number, handle: number, length: number): Samples {
    const pointer = this.exports.pointer(handle);
    return kind === 1 ? new Float64Array(this.exports.memory.buffer, pointer, length)
      : kind === 2 ? new Uint16Array(this.exports.memory.buffer, pointer, length)
        : new Float32Array(this.exports.memory.buffer, pointer, length);
  }
  process(data: Float32Array, channels: number, params: Float64Array, curves: Float32Array) {
    const handles: number[] = [];
    try {
      const p = this.allocate(1, params.length); handles.push(p);
      const c = this.allocate(0, curves.length); handles.push(c);
      const length = Math.min(data.length, BATCH_PIXELS * channels);
      const d = this.allocate(0, length); handles.push(d);
      this.view(1, p, params.length).set(params);
      this.view(0, c, curves.length).set(curves);
      for (let offset = 0; offset < data.length; offset += length) {
        const count = Math.min(length, data.length - offset);
        // The padding in the last batch is never copied back to the raster.
        this.view(0, d, length).set(data.subarray(offset, offset + count));
        if (!this.exports.process(d, channels, p, c)) throw new Error('Invalid image kernel parameters.');
        data.set(this.view(0, d, count) as Float32Array, offset);
      }
    } finally { handles.forEach((handle) => this.exports.release(handle)); }
  }
  flatField(data: Uint16Array, width: number, height: number, gridWidth: number, gridHeight: number,
    gains: Float32Array, decode: Float32Array, encode: Uint16Array) {
    const handles: number[] = [];
    try {
      const rows = Math.min(32, height);
      const d = this.allocate(2, width * rows * 3); handles.push(d);
      const p = this.allocate(1, 5); handles.push(p);
      const g = this.allocate(0, gains.length); handles.push(g);
      const l = this.allocate(0, decode.length); handles.push(l);
      const e = this.allocate(2, encode.length); handles.push(e);
      this.view(0, g, gains.length).set(gains);
      this.view(0, l, decode.length).set(decode);
      this.view(2, e, encode.length).set(encode);
      for (let row = 0; row < height; row += rows) {
        const offset = row * width * 3;
        const count = Math.min(rows, height - row) * width * 3;
        this.view(2, d, width * rows * 3).set(data.subarray(offset, offset + count));
        this.view(1, p, 5).set([width, height, gridWidth, gridHeight, row]);
        if (!this.exports.flat_field(d, p, g, l, e)) throw new Error('Invalid flat-field kernel parameters.');
        data.set(this.view(2, d, count) as Uint16Array, offset);
      }
    } finally { handles.forEach((handle) => this.exports.release(handle)); }
  }
  transform(source: Uint16Array, width: number, height: number, targetWidth: number, targetHeight: number, geometry: number[]) {
    const handles: number[] = [];
    try {
      const s = this.allocate(2, source.length); handles.push(s);
      const rows = Math.min(64, targetHeight);
      const d = this.allocate(0, targetWidth * rows * 3); handles.push(d);
      const p = this.allocate(1, 9); handles.push(p);
      this.view(2, s, source.length).set(source);
      const result = new Float32Array(targetWidth * targetHeight * 3);
      for (let row = 0; row < targetHeight; row += rows) {
        this.view(1, p, 9).set([targetWidth, ...geometry, row]);
        if (!this.exports.transform(s, width, height, d, p)) throw new Error('Invalid geometry kernel parameters.');
        const count = Math.min(rows, targetHeight - row) * targetWidth * 3;
        result.set(this.view(0, d, count) as Float32Array, row * targetWidth * 3);
      }
      return result;
    } finally { handles.forEach((handle) => this.exports.release(handle)); }
  }
}

let kernels: ImageKernels | null = null;
let loading: Promise<ImageKernels | null> | null = null;
export function getImageKernels() { return kernels; }
export function setImageKernels(value: ImageKernels | null) { kernels = value; }
export function loadImageKernels() {
  loading ??= (async () => {
    try {
      const response = await fetch(new URL('./wasm/image_kernels.wasm', import.meta.url));
      if (!response.ok) return null;
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
      kernels = new ImageKernels(instance);
      return kernels;
    } catch { return null; }
  })();
  return loading;
}

// WebAssembly linear memory cannot shrink. Drop a large export instance once
// its buffers have been released so inactive documents do not retain it.
export function recycleImageKernels() {
  if (kernels && kernels.memoryBytes > 32 * 1024 * 1024) { kernels = null; loading = null; }
}
