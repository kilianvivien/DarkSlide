export interface RegionRenderer {
  draw(imageData: ImageData): void;
  dispose(): void;
}

const QUAD_VERTICES = new Float32Array([
  -1, -1, 0, 0,
  1, -1, 1, 0,
  -1, 1, 0, 1,
  1, 1, 1, 1,
]);

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL could not create a shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'WebGL shader compilation failed.';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createCanvas2DRenderer(canvas: HTMLCanvasElement): RegionRenderer {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas could not create a rendering context.');

  return {
    draw(imageData) {
      if (canvas.width !== imageData.width) canvas.width = imageData.width;
      if (canvas.height !== imageData.height) canvas.height = imageData.height;
      context.putImageData(imageData, 0, 0);
    },
    dispose() {},
  };
}

export function createRegionRenderer(canvas: HTMLCanvasElement): RegionRenderer {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
  });
  if (!gl) return createCanvas2DRenderer(canvas);

  let vertexShader: WebGLShader | null = null;
  let fragmentShader: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  let vertexBuffer: WebGLBuffer | null = null;
  let texture: WebGLTexture | null = null;

  try {
    vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 position;
      attribute vec2 texCoord;
      varying vec2 uv;
      void main() {
        uv = texCoord;
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `);
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform sampler2D image;
      varying vec2 uv;
      void main() {
        gl_FragColor = texture2D(image, uv);
      }
    `);
    program = gl.createProgram();
    vertexBuffer = gl.createBuffer();
    texture = gl.createTexture();
    if (!program || !vertexBuffer || !texture) {
      throw new Error('WebGL could not allocate the zoom preview.');
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'WebGL program linking failed.');
    }

    const positionLocation = gl.getAttribLocation(program, 'position');
    const texCoordLocation = gl.getAttribLocation(program, 'texCoord');
    const imageLocation = gl.getUniformLocation(program, 'image');
    if (positionLocation < 0 || texCoordLocation < 0 || !imageLocation) {
      throw new Error('WebGL could not resolve the zoom preview shader inputs.');
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(texCoordLocation);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 16, 8);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.uniform1i(imageLocation, 0);

    gl.detachShader(program, fragmentShader);
    gl.detachShader(program, vertexShader);
    gl.deleteShader(fragmentShader);
    gl.deleteShader(vertexShader);
    fragmentShader = null;
    vertexShader = null;
  } catch (error) {
    if (texture) gl.deleteTexture(texture);
    if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
    if (program) gl.deleteProgram(program);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    if (vertexShader) gl.deleteShader(vertexShader);
    throw error;
  }

  const linkedProgram = program;
  const quadBuffer = vertexBuffer;
  const imageTexture = texture;
  let textureWidth = 0;
  let textureHeight = 0;
  let disposed = false;

  return {
    draw(imageData) {
      if (disposed) throw new Error('Cannot draw with a disposed region renderer.');

      if (canvas.width !== imageData.width) canvas.width = imageData.width;
      if (canvas.height !== imageData.height) canvas.height = imageData.height;
      gl.viewport(0, 0, imageData.width, imageData.height);
      gl.useProgram(linkedProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bindTexture(gl.TEXTURE_2D, imageTexture);

      if (textureWidth === imageData.width && textureHeight === imageData.height) {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          imageData,
        );
      } else {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          imageData,
        );
        textureWidth = imageData.width;
        textureHeight = imageData.height;
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gl.deleteTexture(imageTexture);
      gl.deleteBuffer(quadBuffer);
      gl.deleteProgram(linkedProgram);
    },
  };
}
