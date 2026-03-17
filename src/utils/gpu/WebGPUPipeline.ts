import {
  ColorMatrix,
  ConversionSettings,
  MaskTuning,
  ReadTileResult,
  TonalCharacter,
} from '../../types';
import {
  buildCurveLutBuffer,
  buildProcessingUniforms,
  clamp,
} from '../imagePipeline';
import tiledRenderShader from './shaders/tiledRender.wgsl?raw';

const PROCESSING_UNIFORM_BYTES = 48 * 4;
const CURVE_LUT_BYTES = 1024 * 4;
const BLUR_UNIFORM_BYTES = 32;
const EFFECT_UNIFORM_BYTES = 16;
const TILE_SIZE = 1024;
const INTERMEDIATE_FORMAT = 'rgba16float';

function alignTo256(value: number) {
  return Math.ceil(value / 256) * 256;
}

function copyTrimmedTile(
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  trimLeft: number,
  trimTop: number,
  trimRight: number,
  trimBottom: number,
) {
  const width = Math.max(1, sourceWidth - trimLeft - trimRight);
  const height = Math.max(1, sourceHeight - trimTop - trimBottom);
  const result = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const sourceOffset = ((y + trimTop) * sourceWidth + trimLeft) * 4;
    const targetOffset = y * width * 4;
    result.set(source.subarray(sourceOffset, sourceOffset + width * 4), targetOffset);
  }

  return new ImageData(result, width, height);
}

function copyWholeImage(source: Uint8ClampedArray, width: number, height: number) {
  return new ImageData(new Uint8ClampedArray(source), width, height);
}

export function hashFloat32Array(data: Float32Array) {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let hash = 2166136261;

  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export class WebGPUPipeline {
  readonly adapterName: string | null;

  readonly limits: {
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
  };

  readonly tileSize = TILE_SIZE;

  readonly intermediateFormat = INTERMEDIATE_FORMAT;

  private readonly device: GPUDevice;

  private readonly conversionPipeline: GPURenderPipeline;

  private readonly blurPipeline: GPURenderPipeline;

  private readonly sharpenPipeline: GPURenderPipeline;

  private readonly noiseReductionPipeline: GPURenderPipeline;

  private readonly copyPipeline: GPURenderPipeline;

  private readonly processingUniformBuffer: GPUBuffer;

  private readonly curveLutBuffer: GPUBuffer;

  private readonly blurUniformBuffer: GPUBuffer;

  private readonly effectUniformBuffer: GPUBuffer;

  private sourceTexture: GPUTexture | null = null;

  private sourceTextureView: GPUTextureView | null = null;

  private workTextureA: GPUTexture | null = null;

  private workTextureAView: GPUTextureView | null = null;

  private workTextureB: GPUTexture | null = null;

  private workTextureBView: GPUTextureView | null = null;

  private workTextureC: GPUTexture | null = null;

  private workTextureCView: GPUTextureView | null = null;

  private outputTexture: GPUTexture | null = null;

  private outputTextureView: GPUTextureView | null = null;

  private readbackBuffer: GPUBuffer | null = null;

  private currentTextureWidth = 0;

  private currentTextureHeight = 0;

  private currentReadbackSize = 0;

  private lastProcessingUniformsHash: number | null = null;

  private lastCurveLutHash: number | null = null;

  private lost = false;

  private lostReason = '';

  private lostMessage = '';

  private destroyed = false;

  private constructor(device: GPUDevice, adapterName: string | null, module: GPUShaderModule) {
    this.device = device;
    this.adapterName = adapterName;
    this.limits = {
      maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize),
      maxBufferSize: Number(device.limits.maxBufferSize),
    };

    this.processingUniformBuffer = device.createBuffer({
      size: PROCESSING_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.curveLutBuffer = device.createBuffer({
      size: CURVE_LUT_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.blurUniformBuffer = device.createBuffer({
      size: BLUR_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.effectUniformBuffer = device.createBuffer({
      size: EFFECT_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.conversionPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'fullscreenVertex' },
      fragment: {
        module,
        entryPoint: 'conversionFragment',
        targets: [{ format: INTERMEDIATE_FORMAT }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.blurPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'fullscreenVertex' },
      fragment: {
        module,
        entryPoint: 'blurFragment',
        targets: [{ format: INTERMEDIATE_FORMAT }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.sharpenPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'fullscreenVertex' },
      fragment: {
        module,
        entryPoint: 'sharpenFragment',
        targets: [{ format: INTERMEDIATE_FORMAT }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.noiseReductionPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'fullscreenVertex' },
      fragment: {
        module,
        entryPoint: 'noiseReductionFragment',
        targets: [{ format: INTERMEDIATE_FORMAT }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.copyPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'fullscreenVertex' },
      fragment: {
        module,
        entryPoint: 'copyFragment',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    void this.device.lost.then((info) => {
      this.lost = true;
      this.lostReason = info.reason ?? 'unknown';
      this.lostMessage = info.message ?? 'GPU device was lost.';
      this.lastProcessingUniformsHash = null;
      this.lastCurveLutHash = null;
    });
  }

  static async create(): Promise<WebGPUPipeline | null> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      return null;
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return null;
    }

    try {
      const device = await adapter.requestDevice();
      const adapterName = await WebGPUPipeline.readAdapterName(adapter);
      const module = device.createShaderModule({ code: tiledRenderShader });
      return new WebGPUPipeline(device, adapterName, module);
    } catch {
      return null;
    }
  }

  private static async readAdapterName(adapter: GPUAdapter) {
    const infoProvider = adapter as GPUAdapter & {
      requestAdapterInfo?: () => Promise<{ vendor?: string; description?: string; device?: string; architecture?: string }>;
      info?: { vendor?: string; description?: string; device?: string; architecture?: string };
    };

    let info = infoProvider.info ?? null;
    try {
      if (!info && typeof infoProvider.requestAdapterInfo === 'function') {
        info = await infoProvider.requestAdapterInfo();
      }
    } catch {
      // Ignore adapter info failures.
    }

    if (!info) {
      return null;
    }

    return info.description ?? info.device ?? info.vendor ?? info.architecture ?? null;
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

  getLostInfo() {
    if (!this.lost) {
      return null;
    }

    return {
      reason: this.lostReason,
      message: this.lostMessage,
    };
  }

  private ensureTextures(width: number, height: number) {
    if (
      this.sourceTexture
      && this.currentTextureWidth === width
      && this.currentTextureHeight === height
    ) {
      return;
    }

    this.sourceTexture?.destroy();
    this.workTextureA?.destroy();
    this.workTextureB?.destroy();
    this.workTextureC?.destroy();
    this.outputTexture?.destroy();

    const baseUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    this.sourceTexture = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.sourceTextureView = this.sourceTexture.createView();

    this.workTextureA = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: INTERMEDIATE_FORMAT,
      usage: baseUsage,
    });
    this.workTextureAView = this.workTextureA.createView();

    this.workTextureB = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: INTERMEDIATE_FORMAT,
      usage: baseUsage,
    });
    this.workTextureBView = this.workTextureB.createView();

    this.workTextureC = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: INTERMEDIATE_FORMAT,
      usage: baseUsage,
    });
    this.workTextureCView = this.workTextureC.createView();

    this.outputTexture = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.outputTextureView = this.outputTexture.createView();

    this.currentTextureWidth = width;
    this.currentTextureHeight = height;
  }

  private ensureReadbackBuffer(width: number, height: number) {
    const paddedBytesPerRow = alignTo256(width * 4);
    const size = paddedBytesPerRow * height;

    if (this.readbackBuffer && this.currentReadbackSize >= size) {
      return;
    }

    this.readbackBuffer?.destroy();
    this.readbackBuffer = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.currentReadbackSize = size;
  }

  private beginRenderPass(encoder: GPUCommandEncoder, view: GPUTextureView) {
    return encoder.beginRenderPass({
      colorAttachments: [{
        view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
  }

  private renderSingleInput(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    extraEntries: GPUBindGroupEntry[] = [],
  ) {
    const pass = this.beginRenderPass(encoder, outputView);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: inputView },
        ...extraEntries,
      ],
    }));
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  private renderDoubleInput(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    firstView: GPUTextureView,
    secondView: GPUTextureView,
    outputView: GPUTextureView,
    extraEntries: GPUBindGroupEntry[] = [],
  ) {
    const pass = this.beginRenderPass(encoder, outputView);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: firstView },
        { binding: 1, resource: secondView },
        ...extraEntries,
      ],
    }));
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  private writeBlurParams(radius: number, direction: 0 | 1) {
    const radiusValue = Math.max(1, Math.round(radius));
    const sigma = radius * 0.65 + 0.35;
    this.device.queue.writeBuffer(
      this.blurUniformBuffer,
      0,
      new Uint32Array([radiusValue, direction, 0, 0]),
    );
    this.device.queue.writeBuffer(
      this.blurUniformBuffer,
      16,
      new Float32Array([sigma, 0, 0, 0]),
    );
  }

  private writeEffectFactor(factor: number) {
    this.device.queue.writeBuffer(
      this.effectUniformBuffer,
      0,
      new Float32Array([factor, 0, 0, 0]),
    );
  }

  private extractPixels(width: number, height: number) {
    if (!this.readbackBuffer) {
      throw new Error('Readback buffer is unavailable.');
    }

    const paddedBytesPerRow = alignTo256(width * 4);
    const mapped = new Uint8Array(this.readbackBuffer.getMappedRange());
    const result = new Uint8ClampedArray(width * height * 4);

    for (let row = 0; row < height; row += 1) {
      const sourceStart = row * paddedBytesPerRow;
      const targetStart = row * width * 4;
      result.set(mapped.subarray(sourceStart, sourceStart + width * 4), targetStart);
    }

    this.readbackBuffer.unmap();
    return result;
  }

  private async processImageData(
    imageData: ImageData,
    settings: ConversionSettings,
    isColor: boolean,
    comparisonMode: 'processed' | 'original',
    maskTuning?: MaskTuning,
    colorMatrix?: ColorMatrix,
    tonalCharacter?: TonalCharacter,
  ) {
    this.assertUsable();

    if (comparisonMode === 'original') {
      return copyWholeImage(imageData.data, imageData.width, imageData.height);
    }

    const expandedWidth = imageData.width;
    const expandedHeight = imageData.height;
    this.ensureTextures(expandedWidth, expandedHeight);
    this.ensureReadbackBuffer(expandedWidth, expandedHeight);

    if (
      !this.sourceTexture
      || !this.sourceTextureView
      || !this.workTextureAView
      || !this.workTextureBView
      || !this.workTextureCView
      || !this.outputTexture
      || !this.outputTextureView
      || !this.readbackBuffer
    ) {
      throw new Error('WebGPU tile resources are unavailable.');
    }

    if (this.readbackBuffer.mapState !== 'unmapped') {
      this.readbackBuffer.unmap();
    }

    this.device.queue.writeTexture(
      { texture: this.sourceTexture },
      imageData.data,
      {
        offset: 0,
        bytesPerRow: expandedWidth * 4,
        rowsPerImage: expandedHeight,
      },
      {
        width: expandedWidth,
        height: expandedHeight,
        depthOrArrayLayers: 1,
      },
    );

    const processingUniforms = buildProcessingUniforms(
      settings,
      isColor,
      comparisonMode,
      maskTuning,
      colorMatrix,
      tonalCharacter,
    );
    const processingUniformsHash = hashFloat32Array(processingUniforms);
    if (processingUniformsHash !== this.lastProcessingUniformsHash) {
      this.device.queue.writeBuffer(
        this.processingUniformBuffer,
        0,
        processingUniforms,
      );
      this.lastProcessingUniformsHash = processingUniformsHash;
    }

    const curveLut = buildCurveLutBuffer(settings);
    const curveLutHash = hashFloat32Array(curveLut);
    if (curveLutHash !== this.lastCurveLutHash) {
      this.device.queue.writeBuffer(this.curveLutBuffer, 0, curveLut);
      this.lastCurveLutHash = curveLutHash;
    }

    const encoder = this.device.createCommandEncoder();

    this.renderSingleInput(
      encoder,
      this.conversionPipeline,
      this.sourceTextureView,
      this.workTextureAView,
      [
        { binding: 1, resource: { buffer: this.processingUniformBuffer } },
        { binding: 2, resource: { buffer: this.curveLutBuffer } },
      ],
    );

    let currentView = this.workTextureAView;

    if (settings.noiseReduction.enabled && settings.noiseReduction.luminanceStrength > 0) {
      this.writeBlurParams(1.5, 0);
      this.renderSingleInput(
        encoder,
        this.blurPipeline,
        currentView,
        this.workTextureBView,
        [{ binding: 1, resource: { buffer: this.blurUniformBuffer } }],
      );

      this.writeBlurParams(1.5, 1);
      this.renderSingleInput(
        encoder,
        this.blurPipeline,
        this.workTextureBView,
        this.workTextureCView,
        [{ binding: 1, resource: { buffer: this.blurUniformBuffer } }],
      );

      this.writeEffectFactor(settings.noiseReduction.luminanceStrength / 100);
      this.renderDoubleInput(
        encoder,
        this.noiseReductionPipeline,
        currentView,
        this.workTextureCView,
        this.workTextureBView,
        [{ binding: 2, resource: { buffer: this.effectUniformBuffer } }],
      );
      currentView = this.workTextureBView;
    }

    if (settings.sharpen.enabled && settings.sharpen.amount > 0) {
      this.writeBlurParams(settings.sharpen.radius, 0);
      this.renderSingleInput(
        encoder,
        this.blurPipeline,
        currentView,
        this.workTextureCView,
        [{ binding: 1, resource: { buffer: this.blurUniformBuffer } }],
      );

      this.writeBlurParams(settings.sharpen.radius, 1);
      this.renderSingleInput(
        encoder,
        this.blurPipeline,
        this.workTextureCView,
        this.workTextureAView,
        [{ binding: 1, resource: { buffer: this.blurUniformBuffer } }],
      );

      this.writeEffectFactor(settings.sharpen.amount / 100);
      this.renderDoubleInput(
        encoder,
        this.sharpenPipeline,
        currentView,
        this.workTextureAView,
        this.workTextureCView,
        [{ binding: 2, resource: { buffer: this.effectUniformBuffer } }],
      );
      currentView = this.workTextureCView;
    }

    this.renderSingleInput(encoder, this.copyPipeline, currentView, this.outputTextureView);

    const paddedBytesPerRow = alignTo256(expandedWidth * 4);
    encoder.copyTextureToBuffer(
      { texture: this.outputTexture },
      {
        buffer: this.readbackBuffer,
        offset: 0,
        bytesPerRow: paddedBytesPerRow,
        rowsPerImage: expandedHeight,
      },
      {
        width: expandedWidth,
        height: expandedHeight,
        depthOrArrayLayers: 1,
      },
    );

    this.device.queue.submit([encoder.finish()]);
    await this.readbackBuffer.mapAsync(GPUMapMode.READ);

    const pixels = this.extractPixels(expandedWidth, expandedHeight);
    return copyWholeImage(pixels, expandedWidth, expandedHeight);
  }

  async processPreviewImage(
    imageData: ImageData,
    settings: ConversionSettings,
    isColor: boolean,
    comparisonMode: 'processed' | 'original',
    maskTuning?: MaskTuning,
    colorMatrix?: ColorMatrix,
    tonalCharacter?: TonalCharacter,
  ) {
    return this.processImageData(
      imageData,
      settings,
      isColor,
      comparisonMode,
      maskTuning,
      colorMatrix,
      tonalCharacter,
    );
  }

  async processTile(
    tile: ReadTileResult,
    settings: ConversionSettings,
    isColor: boolean,
    comparisonMode: 'processed' | 'original',
    maskTuning?: MaskTuning,
    colorMatrix?: ColorMatrix,
    tonalCharacter?: TonalCharacter,
  ) {
    const processed = await this.processImageData(
      tile.imageData,
      settings,
      isColor,
      comparisonMode,
      maskTuning,
      colorMatrix,
      tonalCharacter,
    );
    return copyTrimmedTile(
      processed.data,
      processed.width,
      processed.height,
      tile.haloLeft,
      tile.haloTop,
      tile.haloRight,
      tile.haloBottom,
    );
  }

  destroy() {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.sourceTexture?.destroy();
    this.workTextureA?.destroy();
    this.workTextureB?.destroy();
    this.workTextureC?.destroy();
    this.outputTexture?.destroy();
    this.readbackBuffer?.destroy();
    this.processingUniformBuffer.destroy();
    this.curveLutBuffer.destroy();
    this.blurUniformBuffer.destroy();
    this.effectUniformBuffer.destroy();
    this.lastProcessingUniformsHash = null;
    this.lastCurveLutHash = null;
    this.device.destroy();
  }
}
