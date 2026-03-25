import piexif from 'piexifjs';
import { describe, expect, it } from 'vitest';
import { extractExifMetadata, finalizeExportBlob, injectPngTextChunk } from './imageMetadata';

const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCABkAGQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAABAv/aAAwDAQACEAMQAAAB6A//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AYf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AYf/2Q==';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+qXcAAAAASUVORK5CYII=';

function base64ToUint8Array(value: string) {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

async function blobToBinaryString(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let result = '';
  for (let index = 0; index < bytes.length; index += 1) {
    result += String.fromCharCode(bytes[index]);
  }
  return result;
}

describe('image metadata helpers', () => {
  it('extracts JPEG EXIF fields and rewrites export orientation to top-left', async () => {
    const dataUrl = `data:image/jpeg;base64,${JPEG_BASE64}`;
    const exif = piexif.dump({
      '0th': {
        [piexif.ImageIFD.Orientation]: 6,
        [piexif.ImageIFD.Make]: 'Nikon',
        [piexif.ImageIFD.Model]: 'Coolscan',
      },
      Exif: {
        [piexif.ExifIFD.DateTimeOriginal]: '2024:03:15 14:30:00',
      },
    });
    const jpegWithExif = piexif.insert(exif, dataUrl);
    const jpegBytes = Buffer.from(jpegWithExif.split(',')[1], 'base64');
    const extracted = extractExifMetadata(jpegBytes.buffer.slice(
      jpegBytes.byteOffset,
      jpegBytes.byteOffset + jpegBytes.byteLength,
    ));

    expect(extracted).toEqual({
      orientation: 6,
      dateTimeOriginal: '2024:03:15 14:30:00',
      make: 'Nikon',
      model: 'Coolscan',
    });

    const finalized = await finalizeExportBlob(
      {
        blob: new Blob([base64ToUint8Array(JPEG_BASE64)], { type: 'image/jpeg' }),
        filename: 'scan.jpg',
      },
      {
        format: 'image/jpeg',
        quality: 0.92,
        filenameBase: 'scan',
        embedMetadata: true,
        outputProfileId: 'srgb',
        embedOutputProfile: false,
        saveSidecar: false,
        targetMaxDimension: null,
      },
      extracted,
    );

    const loaded = piexif.load(await blobToBinaryString(finalized.blob));
    expect(loaded['0th'][piexif.ImageIFD.Orientation]).toBe(1);
    expect(loaded['0th'][piexif.ImageIFD.Software]).toBe('DarkSlide');
    expect(loaded['0th'][piexif.ImageIFD.Make]).toBe('Nikon');
    expect(loaded['0th'][piexif.ImageIFD.Model]).toBe('Coolscan');
    expect(loaded.Exif[piexif.ExifIFD.DateTimeOriginal]).toBe('2024:03:15 14:30:00');
  });

  it('leaves JPEG blobs untouched when metadata embedding is disabled', async () => {
    const sourceBlob = new Blob([base64ToUint8Array(JPEG_BASE64)], { type: 'image/jpeg' });
    const finalized = await finalizeExportBlob(
      {
        blob: sourceBlob,
        filename: 'scan.jpg',
      },
      {
        format: 'image/jpeg',
        quality: 0.92,
        filenameBase: 'scan',
        embedMetadata: false,
        outputProfileId: 'srgb',
        embedOutputProfile: false,
        saveSidecar: false,
        targetMaxDimension: null,
      },
      {
        orientation: 6,
      },
    );

    expect(await finalized.blob.arrayBuffer()).toEqual(await sourceBlob.arrayBuffer());
  });

  it('injects a PNG Software text chunk for metadata-enabled exports', async () => {
    const blob = new Blob([base64ToUint8Array(PNG_BASE64)], { type: 'image/png' });
    const injected = await injectPngTextChunk(blob, 'Software', 'DarkSlide');
    const bytes = new Uint8Array(await injected.arrayBuffer());
    const text = new TextDecoder().decode(bytes);

    expect(text).toContain('tEXt');
    expect(text).toContain('Software');
    expect(text).toContain('DarkSlide');
  });
});
