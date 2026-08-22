import { describe, expect, it, vi } from 'vitest';
import { createRegionRenderer } from './webglRegionRenderer';

function createWebGLMock() {
  const vertexShader = {} as WebGLShader;
  const fragmentShader = {} as WebGLShader;
  const program = {} as WebGLProgram;
  const buffer = {} as WebGLBuffer;
  const texture = {} as WebGLTexture;
  const uniform = {} as WebGLUniformLocation;
  let shaderCount = 0;

  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TEXTURE0: 8,
    TEXTURE_2D: 9,
    TEXTURE_MIN_FILTER: 10,
    TEXTURE_MAG_FILTER: 11,
    TEXTURE_WRAP_S: 12,
    TEXTURE_WRAP_T: 13,
    LINEAR: 14,
    CLAMP_TO_EDGE: 15,
    UNPACK_FLIP_Y_WEBGL: 16,
    RGBA: 17,
    UNSIGNED_BYTE: 18,
    TRIANGLE_STRIP: 19,
    createShader: vi.fn(() => (shaderCount++ === 0 ? vertexShader : fragmentShader)),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => null),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => program),
    createBuffer: vi.fn(() => buffer),
    createTexture: vi.fn(() => texture),
    attachShader: vi.fn(),
    detachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => null),
    getAttribLocation: vi.fn((_program: WebGLProgram, name: string) => name === 'position' ? 0 : 1),
    getUniformLocation: vi.fn(() => uniform),
    useProgram: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei: vi.fn(),
    uniform1i: vi.fn(),
    viewport: vi.fn(),
    texImage2D: vi.fn(),
    texSubImage2D: vi.fn(),
    drawArrays: vi.fn(),
    deleteTexture: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteProgram: vi.fn(),
  };
}

function makeImageData(width: number, height: number) {
  return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
}

describe('createRegionRenderer', () => {
  it('reuses its program, buffer, and texture between draws', () => {
    const canvas = document.createElement('canvas');
    const gl = createWebGLMock();
    vi.spyOn(canvas, 'getContext').mockReturnValue(gl as unknown as WebGLRenderingContext);

    const renderer = createRegionRenderer(canvas);
    renderer.draw(makeImageData(4, 3));
    renderer.draw(makeImageData(4, 3));
    renderer.draw(makeImageData(8, 6));

    expect(gl.createShader).toHaveBeenCalledTimes(2);
    expect(gl.createProgram).toHaveBeenCalledTimes(1);
    expect(gl.createBuffer).toHaveBeenCalledTimes(1);
    expect(gl.createTexture).toHaveBeenCalledTimes(1);
    expect(gl.bufferData).toHaveBeenCalledTimes(1);
    expect(gl.texImage2D).toHaveBeenCalledTimes(2);
    expect(gl.texSubImage2D).toHaveBeenCalledTimes(1);
    expect(gl.drawArrays).toHaveBeenCalledTimes(3);
    expect(gl.drawArrays).toHaveBeenLastCalledWith(gl.TRIANGLE_STRIP, 0, 4);

    renderer.dispose();
    renderer.dispose();
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  });

  it('uses a 2D canvas when WebGL is unavailable', () => {
    const canvas = document.createElement('canvas');
    const putImageData = vi.fn();
    vi.spyOn(canvas, 'getContext').mockImplementation((contextId: string) => {
      if (contextId === 'webgl') return null;
      return { putImageData } as unknown as CanvasRenderingContext2D;
    });

    const renderer = createRegionRenderer(canvas);
    const imageData = makeImageData(5, 4);
    renderer.draw(imageData);

    expect(canvas.width).toBe(5);
    expect(canvas.height).toBe(4);
    expect(putImageData).toHaveBeenCalledWith(imageData, 0, 0);
  });
});
