import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../../constants';
import { hashFloat32Array, WebGPUPipeline } from './WebGPUPipeline';

describe('hashFloat32Array', () => {
  it('returns the same hash for identical payloads', () => {
    expect(hashFloat32Array(new Float32Array([1, 2, 3, 4]))).toBe(
      hashFloat32Array(new Float32Array([1, 2, 3, 4])),
    );
  });

  it('returns a different hash for different payloads', () => {
    expect(hashFloat32Array(new Float32Array([1, 2, 3, 4]))).not.toBe(
      hashFloat32Array(new Float32Array([1, 2, 3, 5])),
    );
  });
});

describe('GPU spatial filter submission', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])('keeps filter parameters and unblurred source intact until submission (denoise=%s)', async (denoise) => {
    class Buffer {
      bytes: ArrayBuffer;
      mapState = 'unmapped';
      constructor(size: number) { this.bytes = new ArrayBuffer(size); }
      async mapAsync() { this.mapState = 'mapped'; }
      getMappedRange() { return this.bytes; }
      unmap() { this.mapState = 'unmapped'; }
      destroy() {}
    }
    type Binding = { buffer: Buffer; offset?: number };
    type Pass = { name: string; entries: Array<{ binding: number; resource: Binding }> };
    const submitted: Array<{ name: string; radius?: number; direction?: number; factor?: number }> = [];
    const device = {
      destroy() {},
      limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024 },
      lost: new Promise(() => {}),
      createBuffer: ({ size }: { size: number }) => new Buffer(size),
      createTexture: () => ({ createView: () => ({}), destroy() {} }),
      createShaderModule: () => ({}),
      createRenderPipeline: ({ fragment }: { fragment: { entryPoint: string } }) => ({
        name: fragment.entryPoint, getBindGroupLayout: () => ({}),
      }),
      createBindGroup: ({ entries }: { entries: Pass['entries'] }) => ({ entries }),
      createCommandEncoder: () => {
        const passes: Pass[] = [];
        return {
          beginRenderPass: () => {
            const pass: Pass = { name: '', entries: [] };
            return {
              setPipeline: ({ name }: { name: string }) => { pass.name = name; },
              setBindGroup: (_index: number, group: { entries: Pass['entries'] }) => { pass.entries = group.entries; },
              draw() {}, end: () => passes.push(pass),
            };
          },
          copyTextureToBuffer() {}, finish: () => passes,
        };
      },
      queue: {
        writeTexture() {},
        writeBuffer: (buffer: Buffer, offset: number, data: ArrayBufferView) => {
          new Uint8Array(buffer.bytes).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
        },
        submit: (commands: Pass[][]) => {
          // GPU buffers are read here, after every writeBuffer call for the job.
          for (const pass of commands.flat()) {
            const blur = pass.name === 'blurFragment';
            if (!blur && !['noiseReductionFragment', 'sharpenFragment'].includes(pass.name)) continue;
            if (!blur) {
              expect(pass.entries.find((entry) => entry.binding === 0)!.resource)
                .not.toBe(pass.entries.find((entry) => entry.binding === 1)!.resource);
            }
            const binding = pass.entries.find((entry) => entry.binding === (blur ? 1 : 2))!.resource;
            const bytes = new DataView(binding.buffer.bytes, binding.offset ?? 0);
            submitted.push(blur
              ? { name: pass.name, radius: bytes.getUint32(0, true), direction: bytes.getUint32(4, true) }
              : { name: pass.name, factor: bytes.getFloat32(0, true) });
          }
        },
      },
    };
    vi.stubGlobal('GPUBufferUsage', { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8, MAP_READ: 16 });
    vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4, COPY_SRC: 8 });
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ requestDevice: async () => device, info: {} }) } });
    const pipeline = await WebGPUPipeline.create();
    expect(pipeline).not.toBeNull();
    await pipeline!.processPreviewImage(new ImageData(new Uint8ClampedArray([128, 128, 128, 255]), 1, 1),
      createDefaultSettings({ noiseReduction: { enabled: denoise, luminanceStrength: 25 }, sharpen: { enabled: true, radius: 3, amount: 150 } }),
      true, 'processed');
    expect(submitted).toEqual([
      ...(denoise ? [
        { name: 'blurFragment', radius: 2, direction: 0 },
        { name: 'blurFragment', radius: 2, direction: 1 },
        { name: 'noiseReductionFragment', factor: 0.25 },
      ] : []),
      { name: 'blurFragment', radius: 3, direction: 0 },
      { name: 'blurFragment', radius: 3, direction: 1 },
      { name: 'sharpenFragment', factor: 1.5 },
    ]);
    pipeline!.destroy();
  });
});

describe('GPU job serialization', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs overlapping preview jobs one after another so a newer job never aborts an in-flight readback', async () => {
    const pendingMaps: Array<() => void> = [];
    class Buffer {
      bytes: ArrayBuffer;
      mapState = 'unmapped';
      private rejectMap: ((error: Error) => void) | null = null;
      constructor(size: number) { this.bytes = new ArrayBuffer(size); }
      mapAsync() {
        this.mapState = 'pending';
        return new Promise<void>((resolve, reject) => {
          this.rejectMap = reject;
          pendingMaps.push(() => { this.mapState = 'mapped'; this.rejectMap = null; resolve(); });
        });
      }
      getMappedRange() { return this.bytes; }
      unmap() {
        // Unmapping a pending map aborts it, as WebGPU does.
        this.rejectMap?.(new Error('The operation was aborted.'));
        this.rejectMap = null;
        this.mapState = 'unmapped';
      }
      destroy() {}
    }
    const device = {
      destroy() {},
      limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024 },
      lost: new Promise(() => {}),
      createBuffer: ({ size }: { size: number }) => new Buffer(size),
      createTexture: () => ({ createView: () => ({}), destroy() {} }),
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
        copyTextureToBuffer() {}, finish: () => ({}),
      }),
      queue: { writeTexture() {}, writeBuffer() {}, submit() {} },
    };
    vi.stubGlobal('GPUBufferUsage', { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8, MAP_READ: 16 });
    vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4, COPY_SRC: 8 });
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ requestDevice: async () => device, info: {} }) } });
    const pipeline = (await WebGPUPipeline.create())!;
    const image = () => new ImageData(new Uint8ClampedArray([128, 128, 128, 255]), 1, 1);

    const first = pipeline.processPreviewImage(image(), createDefaultSettings(), true, 'processed');
    const second = pipeline.processPreviewImage(image(), createDefaultSettings(), true, 'processed');
    await vi.waitFor(() => expect(pendingMaps).toHaveLength(1));
    pendingMaps[0]();
    await expect(first).resolves.toBeInstanceOf(ImageData);
    await vi.waitFor(() => expect(pendingMaps).toHaveLength(2));
    pendingMaps[1]();
    await expect(second).resolves.toBeInstanceOf(ImageData);
    pipeline.destroy();
  });
});
