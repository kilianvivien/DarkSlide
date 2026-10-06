import type { DecodeRequest } from '../types';
import { decodeRawIpcPayload, normalizeRawIpcBuffer } from './rawImport';
import type { FlatFieldBuildResult } from './flatField';
import { getActiveFlatFieldProfile } from './flatFieldStore';

export interface DesktopRawDecodeForWorkerOptions {
  documentId: string;
  fileName: string;
  path: string;
  size: number;
}

// Decodes a frame of the bare light source exactly like a scan (camera-native,
// no gains) and turns it into a flat-field map.
export async function buildFlatFieldFromRawPath(path: string, name: string): Promise<FlatFieldBuildResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  const buffer = normalizeRawIpcBuffer(await invoke<unknown>('decode_raw_binary', { path }));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./calibrationWorker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Flat-field calibration timed out.')); }, 30_000);
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    worker.onmessage = (event: MessageEvent<{ result?: FlatFieldBuildResult; error?: string }>) => {
      finish();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? 'Flat-field calibration failed.'));
    };
    worker.onerror = (event) => { finish(); reject(new Error(event.message || 'Flat-field calibration failed.')); };
    try {
      worker.postMessage({ buffer, name }, [buffer]);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'DataCloneError') {
        try { worker.postMessage({ buffer, name }); } catch (cloneError) { finish(); reject(cloneError); }
      } else { finish(); reject(error); }
    }
  });
}

export async function decodeDesktopRawForWorker(options: DesktopRawDecodeForWorkerOptions) {
  const { invoke } = await import('@tauri-apps/api/core');
  const startedAt = performance.now();
  const buffer = normalizeRawIpcBuffer(await invoke<unknown>('decode_raw_binary', { path: options.path }));
  const rawNativeMs = performance.now() - startedAt;
  // Header validation and a typed view are cheap; every pixel operation runs
  // in the image worker, which takes ownership of the original IPC buffer.
  const rawResult = decodeRawIpcPayload(buffer);

  return {
    rawResult,
    decodeRequest: {
      documentId: options.documentId, fileName: options.fileName, size: options.size,
      buffer, mime: 'image/x-raw-ipc', nativeRawPath: options.path, rawNativeMs,
      rawFlatField: getActiveFlatFieldProfile(),
      cameraColorMatrix: rawResult.cameraColorMatrix,
    } satisfies DecodeRequest,
  };
}
