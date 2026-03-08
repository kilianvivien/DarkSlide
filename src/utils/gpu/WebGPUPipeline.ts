import {
  ColorMatrix,
  ConversionSettings,
  HistogramData,
  MaskTuning,
  TonalCharacter,
} from '../../types';
import {
  buildCurveLutBuffer,
  buildProcessingUniforms,
  clamp,
} from '../imagePipeline';
import blurShader from './shaders/blur.wgsl?raw';
import conversionShader from './shaders/conversion.wgsl?raw';
import histogramShader from './shaders/histogram.wgsl?raw';
import noiseReductionShader from './shaders/noiseReduction.wgsl?raw';
import sharpenShader from './shaders/sharpen.wgsl?raw';

const WORKGROUP_SIZE = 256;
const HISTOGRAM_BIN_COUNT = 1024;
const PROCESSING_UNIFORM_BYTES = 40 * 4;
const DISPATCH_UNIFORM_BYTES = 16;
const BLUR_UNIFORM_BYTES = 48;
const EFFECT_UNIFORM_BYTES = 32;

function createHistogramFromBuffer(data: Uint32Array): HistogramData {
  return {
    r: Array.from(data.subarray(0, 256)),
    g: Array.from(data.subarray(256, 512)),
    b: Array.from(data.subarray(512, 768)),
    l: Array.from(data.subarray(768, 1024)),
  };
}

export class WebGPUPipeline {
  readonly adapterName: string | null;

  readonly limits: {
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
  };

  private readonly device: GPUDevice;

  private readonly maxStorageBufferBindingSize: number;

  private readonly maxBufferSize: number;

  private readonly conversionPipeline: GPUComputePipeline;

  private readonly blurPipeline: GPUComputePipeline;

  private readonly histogramPipeline: GPUComputePipeline;

  private readonly sharpenPipeline: GPUComputePipeline;

  private readonly noiseReductionPipeline: GPUComputePipeline;

  private readonly uniformBuffer: GPUBuffer;

  private readonly curveLutBuffer: GPUBuffer;

  private readonly dispatchParamsBuffer: GPUBuffer;

  private readonly blurParamsBuffer: GPUBuffer;

  private readonly effectParamsBuffer: GPUBuffer;

  private readonly histogramBuffer: GPUBuffer;

  private readonly histogramReadBuffer: GPUBuffer;

  private pixelBuffer: GPUBuffer | null = null;

  private blurTempBuffer: GPUBuffer | null = null;

  private blurOutputBuffer: GPUBuffer | null = null;

  private pixelReadBuffer: GPUBuffer | null = null;

  private currentPixelCapacity = 0;

  private lost = false;

  private destroyed = false;

  private constructor(
    device: GPUDevice,
    adapterName: string | null,
    conversionPipeline: GPUComputePipeline,
    blurPipeline: GPUComputePipeline,
    histogramPipeline: GPUComputePipeline,
    sharpenPipeline: GPUComputePipeline,
    noiseReductionPipeline: GPUComputePipeline,
  ) {
    this.device = device;
    this.adapterName = adapterName;
    this.maxStorageBufferBindingSize = Number(device.limits.maxStorageBufferBindingSize);
    this.maxBufferSize = Number(device.limits.maxBufferSize);
    this.limits = {
      maxStorageBufferBindingSize: this.maxStorageBufferBindingSize,
      maxBufferSize: this.maxBufferSize,
    };
    this.conversionPipeline = conversionPipeline;
    this.blurPipeline = blurPipeline;
    this.histogramPipeline = histogramPipeline;
    this.sharpenPipeline = sharpenPipeline;
    this.noiseReductionPipeline = noiseReductionPipeline;

    this.uniformBuffer = device.createBuffer({
      size: PROCESSING_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.curveLutBuffer = device.createBuffer({
      size: 1024 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.dispatchParamsBuffer = device.createBuffer({
      size: DISPATCH_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.blurParamsBuffer = device.createBuffer({
      size: BLUR_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.effectParamsBuffer = device.createBuffer({
      size: EFFECT_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.histogramBuffer = device.createBuffer({
      size: HISTOGRAM_BIN_COUNT * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.histogramReadBuffer = device.createBuffer({
      size: HISTOGRAM_BIN_COUNT * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    void this.device.lost.then(() => {
      this.lost = true;
    });
  }

  static async create(): Promise<WebGPUPipeline | null> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      return null;
    }

    const gpu = navigator.gpu;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return null;
    }

    try {
      const device = await adapter.requestDevice();
      const adapterInfo = await WebGPUPipeline.readAdapterName(adapter);

      const conversionModule = device.createShaderModule({ code: conversionShader });
      const blurModule = device.createShaderModule({ code: blurShader });
      const histogramModule = device.createShaderModule({ code: histogramShader });
      const sharpenModule = device.createShaderModule({ code: sharpenShader });
      const noiseReductionModule = device.createShaderModule({ code: noiseReductionShader });

      return new WebGPUPipeline(
        device,
        adapterInfo,
        device.createComputePipeline({
          layout: 'auto',
          compute: { module: conversionModule, entryPoint: 'main' },
        }),
        device.createComputePipeline({
          layout: 'auto',
          compute: { module: blurModule, entryPoint: 'main' },
        }),
        device.createComputePipeline({
          layout: 'auto',
          compute: { module: histogramModule, entryPoint: 'main' },
        }),
        device.createComputePipeline({
          layout: 'auto',
          compute: { module: sharpenModule, entryPoint: 'main' },
        }),
        device.createComputePipeline({
          layout: 'auto',
          compute: { module: noiseReductionModule, entryPoint: 'main' },
        }),
      );
    } catch {
      return null;
    }
  }

  private static async readAdapterName(adapter: GPUAdapter) {
    type AdapterInfo = { vendor?: string; description?: string; device?: string; architecture?: string };
    const infoProvider = adapter as GPUAdapter & {
      requestAdapterInfo?: () => Promise<AdapterInfo>;
      info?: AdapterInfo;
    };

    let info: AdapterInfo | null = null;

    try {
      if (typeof infoProvider.requestAdapterInfo === 'function') {
        info = await infoProvider.requestAdapterInfo();
      }
    } catch {
      // Ignore adapter info lookup failures.
    }

    if (!info && infoProvider.info) {
      info = infoProvider.info;
    }

    if (!info) return null;

    return WebGPUPipeline.buildAdapterLabel(info);
  }

  private static buildAdapterLabel(info: { vendor?: string; description?: string; device?: string; architecture?: string }): string | null {
    const capitalize = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    const vendor = info.vendor?.trim() ?? '';
    const description = info.description?.trim() ?? '';
    const device = info.device?.trim() ?? '';
    const architecture = info.architecture?.trim() ?? '';

    // Prefer description if it's more than just the vendor name
    if (description && description.toLowerCase() !== vendor.toLowerCase()) {
      return capitalize(description);
    }

    // Use device if available
    if (device) {
      return capitalize(device);
    }

    // Combine vendor + architecture for a more informative label (e.g. "Apple (common-3)")
    if (vendor && architecture) {
      return `${capitalize(vendor)} (${architecture})`;
    }

    return capitalize(vendor) || capitalize(architecture) || null;
  }

  private assertUsable() {
    if (this.destroyed) {
      throw new Error('WebGPU pipeline has been destroyed.');
    }
    if (this.lost) {
      throw new Error('WebGPU device was lost.');
    }
  }

  isLost() {
    return this.lost;
  }

  private ensurePixelBuffers(pixelCount: number) {
    if (this.pixelBuffer && this.currentPixelCapacity >= pixelCount) {
      return;
    }

    const byteSize = pixelCount * 4 * 4;
    if (byteSize > this.maxStorageBufferBindingSize || byteSize > this.maxBufferSize) {
      throw new Error('Image is too large for the current WebGPU buffer limits.');
    }

    this.pixelBuffer?.destroy();
    this.blurTempBuffer?.destroy();
    this.blurOutputBuffer?.destroy();
    this.pixelReadBuffer?.destroy();

    this.pixelBuffer = this.device.createBuffer({
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.blurTempBuffer = this.device.createBuffer({
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.blurOutputBuffer = this.device.createBuffer({
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.pixelReadBuffer = this.device.createBuffer({
      size: byteSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.currentPixelCapacity = pixelCount;
  }

  private createFloatPixels(imageData: ImageData) {
    const { data } = imageData;
    const floatPixels = new Float32Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
      floatPixels[index] = data[index] / 255;
    }
    return floatPixels;
  }

  private writeDispatchParams(pixelCount: number) {
    this.device.queue.writeBuffer(
      this.dispatchParamsBuffer,
      0,
      new Uint32Array([pixelCount, 0, 0, 0]),
    );
  }

  private encodeBlur(
    encoder: GPUCommandEncoder,
    pixelCount: number,
    width: number,
    height: number,
    radius: number,
  ) {
    if (!this.pixelBuffer || !this.blurTempBuffer || !this.blurOutputBuffer) {
      throw new Error('WebGPU blur buffers are unavailable.');
    }

    const radiusValue = Math.max(1, Math.round(radius));
    const sigma = radius * 0.65 + 0.35;
    const workgroupCount = Math.ceil(pixelCount / WORKGROUP_SIZE);

    this.device.queue.writeBuffer(
      this.blurParamsBuffer,
      0,
      new Uint32Array([pixelCount, width, height, radiusValue, 1, 0, 0, 0]),
    );
    this.device.queue.writeBuffer(
      this.blurParamsBuffer,
      32,
      new Float32Array([sigma, 0, 0, 0]),
    );
    const horizontalPass = encoder.beginComputePass();
    horizontalPass.setPipeline(this.blurPipeline);
    horizontalPass.setBindGroup(0, this.device.createBindGroup({
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.pixelBuffer } },
        { binding: 1, resource: { buffer: this.blurTempBuffer } },
        { binding: 2, resource: { buffer: this.blurParamsBuffer } },
      ],
    }));
    horizontalPass.dispatchWorkgroups(workgroupCount);
    horizontalPass.end();

    this.device.queue.writeBuffer(
      this.blurParamsBuffer,
      0,
      new Uint32Array([pixelCount, width, height, radiusValue, 0, 0, 0, 0]),
    );
    this.device.queue.writeBuffer(
      this.blurParamsBuffer,
      32,
      new Float32Array([sigma, 0, 0, 0]),
    );
    const verticalPass = encoder.beginComputePass();
    verticalPass.setPipeline(this.blurPipeline);
    verticalPass.setBindGroup(0, this.device.createBindGroup({
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.blurTempBuffer } },
        { binding: 1, resource: { buffer: this.blurOutputBuffer } },
        { binding: 2, resource: { buffer: this.blurParamsBuffer } },
      ],
    }));
    verticalPass.dispatchWorkgroups(workgroupCount);
    verticalPass.end();
  }

  private encodeEffect(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    pixelCount: number,
    factor: number,
  ) {
    if (!this.pixelBuffer || !this.blurOutputBuffer) {
      throw new Error('WebGPU effect buffers are unavailable.');
    }

    this.device.queue.writeBuffer(
      this.effectParamsBuffer,
      0,
      new Uint32Array([pixelCount, 0, 0, 0]),
    );
    this.device.queue.writeBuffer(
      this.effectParamsBuffer,
      16,
      new Float32Array([factor, 0, 0, 0]),
    );

    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.pixelBuffer } },
        { binding: 1, resource: { buffer: this.blurOutputBuffer } },
        { binding: 2, resource: { buffer: this.effectParamsBuffer } },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(pixelCount / WORKGROUP_SIZE));
    pass.end();
  }

  async processImageData(
    imageData: ImageData,
    settings: ConversionSettings,
    isColor: boolean,
    comparisonMode: 'processed' | 'original',
    maskTuning?: MaskTuning,
    colorMatrix?: ColorMatrix,
    tonalCharacter?: TonalCharacter,
  ): Promise<HistogramData> {
    this.assertUsable();

    const pixelCount = imageData.width * imageData.height;
    this.ensurePixelBuffers(pixelCount);
    if (!this.pixelBuffer || !this.pixelReadBuffer) {
      throw new Error('WebGPU pixel buffers are unavailable.');
    }

    if (this.pixelReadBuffer.mapState !== 'unmapped') {
      this.pixelReadBuffer.unmap();
    }
    if (this.histogramReadBuffer.mapState !== 'unmapped') {
      this.histogramReadBuffer.unmap();
    }

    this.device.queue.writeBuffer(this.pixelBuffer, 0, this.createFloatPixels(imageData));
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      buildProcessingUniforms(settings, isColor, comparisonMode, maskTuning, colorMatrix, tonalCharacter),
    );
    this.device.queue.writeBuffer(this.curveLutBuffer, 0, buildCurveLutBuffer(settings));
    this.writeDispatchParams(pixelCount);

    const encoder = this.device.createCommandEncoder();

    if (comparisonMode === 'processed') {
      const conversionPass = encoder.beginComputePass();
      conversionPass.setPipeline(this.conversionPipeline);
      conversionPass.setBindGroup(0, this.device.createBindGroup({
        layout: this.conversionPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.pixelBuffer } },
          { binding: 1, resource: { buffer: this.uniformBuffer } },
          { binding: 2, resource: { buffer: this.curveLutBuffer } },
          { binding: 3, resource: { buffer: this.dispatchParamsBuffer } },
        ],
      }));
      conversionPass.dispatchWorkgroups(Math.ceil(pixelCount / WORKGROUP_SIZE));
      conversionPass.end();

      if (settings.noiseReduction.enabled && settings.noiseReduction.luminanceStrength > 0) {
        this.encodeBlur(encoder, pixelCount, imageData.width, imageData.height, 1.5);
        this.encodeEffect(encoder, this.noiseReductionPipeline, pixelCount, settings.noiseReduction.luminanceStrength / 100);
      }

      if (settings.sharpen.enabled && settings.sharpen.amount > 0) {
        this.encodeBlur(encoder, pixelCount, imageData.width, imageData.height, settings.sharpen.radius);
        this.encodeEffect(encoder, this.sharpenPipeline, pixelCount, settings.sharpen.amount / 100);
      }
    }

    encoder.clearBuffer(this.histogramBuffer);
    const histogramPass = encoder.beginComputePass();
    histogramPass.setPipeline(this.histogramPipeline);
    histogramPass.setBindGroup(0, this.device.createBindGroup({
      layout: this.histogramPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.pixelBuffer } },
        { binding: 1, resource: { buffer: this.histogramBuffer } },
        { binding: 2, resource: { buffer: this.dispatchParamsBuffer } },
      ],
    }));
    histogramPass.dispatchWorkgroups(Math.ceil(pixelCount / WORKGROUP_SIZE));
    histogramPass.end();

    encoder.copyBufferToBuffer(this.pixelBuffer, 0, this.pixelReadBuffer, 0, pixelCount * 4 * 4);
    encoder.copyBufferToBuffer(this.histogramBuffer, 0, this.histogramReadBuffer, 0, HISTOGRAM_BIN_COUNT * 4);
    this.device.queue.submit([encoder.finish()]);

    await Promise.all([
      this.pixelReadBuffer.mapAsync(GPUMapMode.READ),
      this.histogramReadBuffer.mapAsync(GPUMapMode.READ),
    ]);

    const resultPixels = new Float32Array(this.pixelReadBuffer.getMappedRange());
    for (let index = 0; index < imageData.data.length; index += 4) {
      imageData.data[index] = Math.round(clamp(resultPixels[index], 0, 1) * 255);
      imageData.data[index + 1] = Math.round(clamp(resultPixels[index + 1], 0, 1) * 255);
      imageData.data[index + 2] = Math.round(clamp(resultPixels[index + 2], 0, 1) * 255);
      imageData.data[index + 3] = Math.round(clamp(resultPixels[index + 3], 0, 1) * 255);
    }

    const histogramCopy = new Uint32Array(this.histogramReadBuffer.getMappedRange().slice(0));
    this.pixelReadBuffer.unmap();
    this.histogramReadBuffer.unmap();

    return createHistogramFromBuffer(histogramCopy);
  }

  destroy() {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.pixelBuffer?.destroy();
    this.blurTempBuffer?.destroy();
    this.blurOutputBuffer?.destroy();
    this.pixelReadBuffer?.destroy();
    this.uniformBuffer.destroy();
    this.curveLutBuffer.destroy();
    this.dispatchParamsBuffer.destroy();
    this.blurParamsBuffer.destroy();
    this.effectParamsBuffer.destroy();
    this.histogramBuffer.destroy();
    this.histogramReadBuffer.destroy();
    this.device.destroy();
  }
}
