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
    createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
    createBindGroup(descriptor: GPUCreateBindGroupDescriptor): GPUBindGroup;
    createCommandEncoder(): GPUCommandEncoder;
    destroy(): void;
  }

  interface GPUQueue {
    writeBuffer(buffer: GPUBuffer, bufferOffset: number, data: BufferSource, dataOffset?: number, size?: number): void;
    submit(commandBuffers: GPUCommandBuffer[]): void;
  }

  interface GPUShaderModule {}

  interface GPUPipelineLayout {}

  interface GPUComputePipeline {
    getBindGroupLayout(index: number): GPUBindGroupLayout;
  }

  interface GPUBindGroupLayout {}

  interface GPUBindGroup {}

  interface GPUCreateBindGroupDescriptor {
    layout: GPUBindGroupLayout;
    entries: GPUBindGroupEntry[];
  }

  interface GPUBindGroupEntry {
    binding: number;
    resource: GPUBufferBinding;
  }

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

  interface GPUCommandEncoder {
    beginComputePass(): GPUComputePassEncoder;
    clearBuffer(buffer: GPUBuffer, offset?: number, size?: number): void;
    copyBufferToBuffer(source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size: number): void;
    finish(): GPUCommandBuffer;
  }

  interface GPUComputePassEncoder {
    setPipeline(pipeline: GPUComputePipeline): void;
    setBindGroup(index: number, bindGroup: GPUBindGroup): void;
    dispatchWorkgroups(x: number, y?: number, z?: number): void;
    end(): void;
  }

  interface GPUCommandBuffer {}

  const GPUBufferUsage: {
    MAP_READ: number;
    COPY_SRC: number;
    COPY_DST: number;
    STORAGE: number;
    UNIFORM: number;
  };

  const GPUMapMode: {
    READ: number;
  };
}

export {};
