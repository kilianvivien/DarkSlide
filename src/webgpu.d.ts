declare global {
  interface Navigator {
    gpu?: GPU;
  }

  interface GPU {
    requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
  }

  interface GPURequestAdapterOptions {
    powerPreference?: 'low-power' | 'high-performance';
  }

  interface GPUAdapter {
    limits: GPUSupportedLimits;
    info?: GPUAdapterInfo;
    requestAdapterInfo?(): Promise<GPUAdapterInfo>;
    requestDevice(): Promise<GPUDevice>;
  }

  interface GPUAdapterInfo {
    vendor?: string;
    description?: string;
    device?: string;
    architecture?: string;
  }

  interface GPUSupportedLimits {
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
  }

  interface GPUDevice {
    limits: GPUSupportedLimits;
    queue: GPUQueue;
    lost: Promise<unknown>;
    createShaderModule(descriptor: { code: string }): GPUShaderModule;
    createComputePipeline(descriptor: {
      layout: 'auto' | GPUPipelineLayout;
      compute: { module: GPUShaderModule; entryPoint: string };
    }): GPUComputePipeline;
    createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
    createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
    createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
    createBindGroup(descriptor: GPUCreateBindGroupDescriptor): GPUBindGroup;
    createCommandEncoder(): GPUCommandEncoder;
    destroy(): void;
  }

  interface GPUQueue {
    writeBuffer(buffer: GPUBuffer, bufferOffset: number, data: BufferSource, dataOffset?: number, size?: number): void;
    writeTexture(
      destination: GPUImageCopyTexture,
      data: BufferSource,
      dataLayout: GPUImageDataLayout,
      size: GPUExtent3D,
    ): void;
    submit(commandBuffers: GPUCommandBuffer[]): void;
  }

  interface GPUShaderModule {}

  interface GPUPipelineLayout {}

  interface GPUComputePipeline {
    getBindGroupLayout(index: number): GPUBindGroupLayout;
  }

  interface GPURenderPipeline {
    getBindGroupLayout(index: number): GPUBindGroupLayout;
  }

  interface GPUBindGroupLayout {}

  interface GPUBindGroup {}

  interface GPURenderPipelineDescriptor {
    layout: 'auto' | GPUPipelineLayout;
    vertex: GPUVertexState;
    fragment?: GPUFragmentState;
    primitive?: GPUPrimitiveState;
  }

  interface GPUVertexState {
    module: GPUShaderModule;
    entryPoint: string;
  }

  interface GPUFragmentState {
    module: GPUShaderModule;
    entryPoint: string;
    targets: GPUColorTargetState[];
  }

  interface GPUColorTargetState {
    format: GPUTextureFormat;
  }

  interface GPUPrimitiveState {
    topology?: 'triangle-list';
  }

  interface GPUCreateBindGroupDescriptor {
    layout: GPUBindGroupLayout;
    entries: GPUBindGroupEntry[];
  }

  interface GPUBindGroupEntry {
    binding: number;
    resource: GPUBindingResource;
  }

  type GPUBindingResource = GPUBufferBinding | GPUTextureView;

  interface GPUBufferBinding {
    buffer: GPUBuffer;
  }

  interface GPUBufferDescriptor {
    size: number;
    usage: number;
  }

  interface GPUBuffer {
    mapState: 'unmapped' | 'pending' | 'mapped';
    destroy(): void;
    mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
    getMappedRange(offset?: number, size?: number): ArrayBuffer;
    unmap(): void;
  }

  interface GPUTextureDescriptor {
    size: GPUExtent3D;
    format: GPUTextureFormat;
    usage: number;
  }

  interface GPUTexture {
    createView(): GPUTextureView;
    destroy(): void;
  }

  interface GPUTextureView {}

  interface GPUCommandEncoder {
    beginComputePass(): GPUComputePassEncoder;
    beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder;
    clearBuffer(buffer: GPUBuffer, offset?: number, size?: number): void;
    copyBufferToBuffer(source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size: number): void;
    copyTextureToBuffer(source: GPUImageCopyTexture, destination: GPUImageCopyBuffer, copySize: GPUExtent3D): void;
    finish(): GPUCommandBuffer;
  }

  interface GPUComputePassEncoder {
    setPipeline(pipeline: GPUComputePipeline): void;
    setBindGroup(index: number, bindGroup: GPUBindGroup): void;
    dispatchWorkgroups(x: number, y?: number, z?: number): void;
    end(): void;
  }

  interface GPURenderPassDescriptor {
    colorAttachments: GPURenderPassColorAttachment[];
  }

  interface GPURenderPassColorAttachment {
    view: GPUTextureView;
    loadOp: 'clear' | 'load';
    storeOp: 'store' | 'discard';
    clearValue?: GPUColor;
  }

  interface GPURenderPassEncoder {
    setPipeline(pipeline: GPURenderPipeline): void;
    setBindGroup(index: number, bindGroup: GPUBindGroup): void;
    draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
    end(): void;
  }

  interface GPUCommandBuffer {}

  interface GPUImageCopyTexture {
    texture: GPUTexture;
  }

  interface GPUImageCopyBuffer {
    buffer: GPUBuffer;
    offset: number;
    bytesPerRow: number;
    rowsPerImage: number;
  }

  interface GPUImageDataLayout {
    offset?: number;
    bytesPerRow?: number;
    rowsPerImage?: number;
  }

  interface GPUExtent3DDict {
    width: number;
    height: number;
    depthOrArrayLayers: number;
  }

  type GPUExtent3D = GPUExtent3DDict;
  type GPUTextureFormat = 'rgba8unorm' | 'rgba16float';

  interface GPUColor {
    r: number;
    g: number;
    b: number;
    a: number;
  }

  const GPUBufferUsage: {
    MAP_READ: number;
    COPY_SRC: number;
    COPY_DST: number;
    STORAGE: number;
    UNIFORM: number;
  };

  const GPUTextureUsage: {
    COPY_SRC: number;
    COPY_DST: number;
    TEXTURE_BINDING: number;
    STORAGE_BINDING: number;
    RENDER_ATTACHMENT: number;
  };

  const GPUMapMode: {
    READ: number;
  };
}

export {};
