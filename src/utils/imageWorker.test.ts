import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../constants';
import type { AutoAnalyzeResult, ColorProfileId, ConversionAnalysisRequest, ConversionAnalysisResult, DecodedImage, FilmBaseSample, PreparedTileJobResult, RenderResult } from '../types';
import { neutralWhiteBalance } from './autoAnalysis';
import type { WorkerMessage, WorkerResponse } from './workerProtocol';
import { computeResidualBaseOffset } from './imagePipeline';

vi.mock('./imagePipeline', async (importOriginal) => {
  const original = await importOriginal<typeof import('./imagePipeline')>();
  return { ...original, computeResidualBaseOffset: vi.fn(original.computeResidualBaseOffset) };
});

// These tests exercise worker requests with uniform pixels. Geometry is neutral;
// the canvas stand-in only copies samples between source and analysis surfaces.
class AnalysisCanvas {
  data = new Uint8ClampedArray(0);
  constructor(public width: number, public height: number) {}
  getContext() {
    return {
      clearRect: () => {},
      translate: () => {},
      rotate: () => {},
      setTransform: () => {},
      putImageData: (image: ImageData) => { this.data = image.data.slice(); },
      drawImage: (source: AnalysisCanvas) => {
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
        for (let i = 0; i < this.data.length; i += 4) this.data.set(source.data.subarray(0, 4), i);
      },
      getImageData: (_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < data.length; i += 4) data.set(this.data.subarray(0, 4), i);
        return new ImageData(data, width, height);
      },
    };
  }
}

const posted = vi.fn();
let receive: (event: { data: WorkerMessage }) => Promise<void>;
let sequence = 0;

async function request<T>(message: Omit<WorkerMessage, 'id' | 'epoch'>): Promise<T> {
  posted.mockClear();
  await receive({ data: { ...message, id: String(++sequence), epoch: 1 } as WorkerMessage });
  const response = posted.mock.calls.at(-1)?.[0] as WorkerResponse;
  if (!response.ok) throw new Error(response.error.message);
  return response.payload as T;
}

async function decode(id: string, pixel: [number, number, number], size = 12) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...pixel, 255], i);
  return request<DecodedImage>({ type: 'decode', payload: {
    documentId: id, buffer: data.buffer, rawDimensions: { width: size, height: size },
    fileName: 'scan.dng', mime: 'image/x-raw-rgba', size: data.length,
    precomputedFilmBase: { sample: { r: 255, g: 255, b: 255 }, source: 'outer-border', confidence: 1, rejectedCandidates: 0, clamped: false },
  } });
}

describe('worker conversion analysis consistency', () => {
  beforeEach(async () => {
    vi.stubGlobal('OffscreenCanvas', AnalysisCanvas);
    const scope = { postMessage: posted, onmessage: null };
    vi.stubGlobal('self', scope);
    vi.resetModules();
    // Keep the worker's WebWorker globals out of the app's DOM type-check.
    const workerModulePath: string = './imageWorker';
    await import(workerModulePath);
    receive = scope.onmessage as unknown as typeof receive;
    vi.mocked(computeResidualBaseOffset).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('recomputes residual analysis when color is switched to monochrome and reuses identical requests', async () => {
    await decode('frame', [120, 160, 190]);
    const settings = createDefaultSettings();
    const payload: ConversionAnalysisRequest = { documentId: 'frame', settings, isColor: true, profileId: 'generic-color' };
    const first = await request<ConversionAnalysisResult>({ type: 'conversion-analysis', payload });
    const repeated = await request<ConversionAnalysisResult>({ type: 'conversion-analysis', payload });
    const monochrome = await request<ConversionAnalysisResult>({ type: 'conversion-analysis', payload: {
      ...payload, settings: { ...settings, blackAndWhite: { ...settings.blackAndWhite, enabled: true } },
    } });
    expect(repeated.residualBaseOffset).toEqual(first.residualBaseOffset);
    expect(monochrome.debug.densityScaleSource).toBe('neutral');
    // Both computations must run even though the profile ID remains color.
    expect(vi.mocked(computeResidualBaseOffset)).toHaveBeenCalledTimes(2);
  });

  it('measures highlights before both slider protection and film-profile protection', async () => {
    await decode('slide', [245, 245, 245]);
    const result = await request<ConversionAnalysisResult>({ type: 'conversion-analysis', payload: {
      documentId: 'slide', settings: createDefaultSettings({ contrast: 0, blackPoint: 0, whitePoint: 255, highlightProtection: 100 }),
      isColor: true, filmType: 'slide',
      maskTuning: { highlightProtectionBias: 1, blackPointBias: 0 },
    } });
    expect(result.highlightDensity).toBe(1);
  });

  it('gives auto-adjust the same result regardless of the previous preview highlight count', async () => {
    await decode('slide', [245, 245, 245]);
    const payload = {
      documentId: 'slide', settings: createDefaultSettings({ contrast: 0, blackPoint: 0, whitePoint: 255 }),
      isColor: true, filmType: 'slide' as const, targetMaxDimension: 1024,
    };
    const first = await request<AutoAnalyzeResult>({ type: 'auto-analyze', payload: { ...payload, highlightDensityEstimate: 0 } });
    const second = await request<AutoAnalyzeResult>({ type: 'auto-analyze', payload: { ...payload, highlightDensityEstimate: 1 } });
    expect(second).toEqual(first);
  });

  it.each<ColorProfileId>(['srgb', 'display-p3', 'adobe-rgb', 'linear'])('gives auto WB and grey-point sampling the same calibrated result without accumulating adjustments in %s', async (outputProfileId) => {
    await decode('gray', [120, 132, 144], 96);
    const settings = createDefaultSettings({
      temperature: 67, tint: -40, contrast: 0, blackPoint: 0, whitePoint: 255,
      highlightProtection: 0, residualBaseCorrection: false,
    });
    const payload = {
      documentId: 'gray', settings, isColor: true, filmType: 'slide' as const,
      colorMatrix: [1.1, 0, 0, 0, 1, 0, 0, 0, 0.95] as [number, number, number, number, number, number, number, number, number],
      labTemperatureBias: 8, targetMaxDimension: 1024, outputProfileId,
    };
    const auto = await request<AutoAnalyzeResult>({ type: 'auto-analyze', payload });
    const picked = await request<FilmBaseSample>({ type: 'sample-film-base', payload: { ...payload, sampleMode: 'white-balance', x: 0.5, y: 0.5 } });
    expect({ temperature: auto.temperature, tint: auto.tint }).toEqual(neutralWhiteBalance(picked, 8, outputProfileId));
    const corrected = { ...settings, temperature: auto.temperature!, tint: auto.tint! };
    const repeated = await request<AutoAnalyzeResult>({ type: 'auto-analyze', payload: { ...payload, settings: corrected } });
    expect(repeated.temperature).toBe(auto.temperature);
    expect(repeated.tint).toBe(auto.tint);
    const render = await request<RenderResult>({ type: 'render', payload: { ...payload, settings: corrected, comparisonMode: 'processed', revision: 1 } });
    const pixel = Array.from(render.imageData.data.slice(0, 3));
    expect(Math.max(...pixel) - Math.min(...pixel)).toBeLessThanOrEqual(2);
  });

  it.each(['gain', 'matrix'] as const)('keeps over-range %s values when picking a grey point', async (mode) => {
    await decode('bright-gray', [200, 220, 220], 96);
    const settings = createDefaultSettings({
      redBalance: mode === 'gain' ? 1.5 : 1, greenBalance: 1, blueBalance: 1,
      exposure: -50, contrast: 0, saturation: 100, blackPoint: 0, whitePoint: 255,
      highlightProtection: 0, residualBaseCorrection: false,
    });
    const payload = {
      documentId: 'bright-gray', settings, isColor: true, filmType: 'slide' as const,
      targetMaxDimension: 1024,
      colorMatrix: mode === 'matrix'
        ? [1.5, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number]
        : undefined,
    };
    const picked = await request<FilmBaseSample>({ type: 'sample-film-base', payload: {
      ...payload, sampleMode: 'white-balance', x: 0.5, y: 0.5,
    } });
    expect(picked.r).toBeCloseTo(300);
    const correction = neutralWhiteBalance(picked);
    expect(correction).toEqual({ temperature: -20, tint: 20 });
    const corrected = { ...settings, ...correction };
    const result = await request<RenderResult>({ type: 'render', payload: {
      ...payload, settings: corrected, comparisonMode: 'processed', revision: 1,
    } });
    expect(Array.from(result.imageData.data.slice(0, 3))).toEqual([124, 124, 124]);
    const repeated = await request<FilmBaseSample>({ type: 'sample-film-base', payload: {
      ...payload, settings: corrected, sampleMode: 'white-balance', x: 0.5, y: 0.5,
    } });
    expect(neutralWhiteBalance(repeated)).toEqual(correction);
  });

  it('samples a negative grey point after inversion and preserves source sampling for the film-base picker', async () => {
    await decode('negative', [180, 180, 180]);
    const payload = { documentId: 'negative', settings: createDefaultSettings({ residualBaseCorrection: false }), targetMaxDimension: 1024, x: 0.5, y: 0.5 };
    const source = await request<FilmBaseSample>({ type: 'sample-film-base', payload });
    const gray = await request<FilmBaseSample>({ type: 'sample-film-base', payload: { ...payload, sampleMode: 'white-balance' } });
    expect(source).toEqual({ r: 180, g: 180, b: 180 });
    expect(gray.r).toBeLessThan(128);
    expect(neutralWhiteBalance(gray)).toEqual({ temperature: 0, tint: 0 });
  });

  it('does not change white balance when the color profile is rendered as monochrome', async () => {
    await decode('mono', [120, 130, 140], 96);
    const settings = createDefaultSettings();
    const auto = await request<AutoAnalyzeResult>({ type: 'auto-analyze', payload: {
      documentId: 'mono', settings: { ...settings, blackAndWhite: { ...settings.blackAndWhite, enabled: true } },
      isColor: true, targetMaxDimension: 1024,
    } });
    expect(auto.temperature).toBeNull();
    expect(auto.tint).toBeNull();
  });

  it('keeps enough tile border for denoising followed by sharpening', async () => {
    await decode('tile', [120, 130, 140]);
    const result = await request<PreparedTileJobResult>({ type: 'prepare-tile-job', payload: {
      documentId: 'tile', jobId: 'job', sourceKind: 'source', comparisonMode: 'processed',
      settings: createDefaultSettings({ noiseReduction: { enabled: true, luminanceStrength: 25 }, sharpen: { enabled: true, amount: 150, radius: 3 } }),
    } });
    expect(result.halo).toBe(5);
  });
});
