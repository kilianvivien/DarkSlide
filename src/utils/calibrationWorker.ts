/// <reference lib="webworker" />
import { decodeRawIpcPayload } from './rawImport';
import { buildFlatFieldProfile } from './flatField';

self.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; name: string }>) => {
  try {
    const raw = decodeRawIpcPayload(event.data.buffer);
    self.postMessage({ result: buildFlatFieldProfile(raw.data, raw.width, raw.height, event.data.name) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
