import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR_MANAGEMENT, FILM_PROFILES, MAX_FILE_SIZE_BYTES, createDefaultSettings } from '../constants';
import { ContactSheetModal } from './ContactSheetModal';
import type { ImageWorkerClient } from '../utils/imageWorkerClient';

const coreState = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const fileBridgeState = vi.hoisted(() => ({
  isDesktopShell: vi.fn(() => false),
  saveExportBlob: vi.fn<(...args: unknown[]) => Promise<'saved' | 'cancelled'>>(),
}));

vi.mock('motion/react', async () => {
  const ReactModule = await import('react');

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy({}, {
      get: (_, tag: string) => ReactModule.forwardRef((
        props: { children?: React.ReactNode } & Record<string, unknown>,
        ref,
      ) => {
        const { children, ...rest } = props;
        return ReactModule.createElement(tag, { ...rest, ref }, children);
      }),
    }),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: coreState.invoke,
}));

vi.mock('../utils/fileBridge', () => ({
  isDesktopShell: fileBridgeState.isDesktopShell,
  saveExportBlob: fileBridgeState.saveExportBlob,
}));

function createFile(name: string, type: string) {
  const file = new File([new Uint8Array([1, 2, 3, 4])], name, { type });
  const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer);
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: arrayBuffer,
  });
  return { file, arrayBuffer };
}

function createWorkerClient() {
  return {
    decode: vi.fn(async () => ({
      metadata: {
        id: 'decoded-doc',
        name: 'decoded',
        mime: 'image/png',
        extension: '.png',
        size: 4,
        width: 2,
        height: 1,
      },
      previewLevels: [],
    })),
    contactSheet: vi.fn(async () => ({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      filename: 'contact_sheet.jpg',
      width: 1200,
      height: 800,
    })),
    disposeDocument: vi.fn(async () => ({ disposed: true })),
  };
}

function renderModal({
  entries,
  workerClient = createWorkerClient(),
  onClose = vi.fn(),
}: {
  entries: Array<{
    id: string;
    kind: 'file' | 'open-tab';
    file?: File;
    nativePath?: string;
    documentId?: string;
    filename: string;
    size: number;
    status: 'pending' | 'processing' | 'done' | 'error';
  }>;
  workerClient?: ReturnType<typeof createWorkerClient>;
  onClose?: () => void;
}) {
  render(
    <ContactSheetModal
      isOpen
      onClose={onClose}
      entries={entries}
      sharedSettings={createDefaultSettings()}
      sharedProfile={FILM_PROFILES.find((profile) => profile.id === 'generic-color') ?? FILM_PROFILES[0]}
      sharedColorManagement={DEFAULT_COLOR_MANAGEMENT}
      workerClient={workerClient as unknown as ImageWorkerClient}
    />,
  );

  return { workerClient, onClose };
}

describe('ContactSheetModal', () => {
  beforeEach(() => {
    coreState.invoke.mockReset();
    fileBridgeState.isDesktopShell.mockReset();
    fileBridgeState.isDesktopShell.mockReturnValue(false);
    fileBridgeState.saveExportBlob.mockReset();
    fileBridgeState.saveExportBlob.mockResolvedValue('saved');
  });

  it('decodes RAW queued files via the desktop path before generating the sheet', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    coreState.invoke.mockResolvedValue({
      width: 2,
      height: 1,
      data: new Uint8Array([10, 20, 30, 40, 50, 60]),
      color_space: 'Adobe RGB (1998)',
      orientation: 6,
    });

    const { file } = createFile('img2016.nef', 'application/octet-stream');
    const { workerClient, onClose } = renderModal({
      entries: [{
        id: 'raw-entry',
        kind: 'file',
        file,
        nativePath: '/Users/tester/Desktop/img2016.nef',
        filename: 'img2016.nef',
        size: MAX_FILE_SIZE_BYTES + 1,
        status: 'pending',
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Generate Sheet' }));

    await waitFor(() => {
      expect(coreState.invoke).toHaveBeenCalledWith('decode_raw', { path: '/Users/tester/Desktop/img2016.nef' });
    });

    expect(workerClient.decode).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'contact-sheet-raw-entry',
      fileName: 'img2016.nef',
      mime: 'image/x-raw-rgba',
      size: MAX_FILE_SIZE_BYTES + 1,
      rawDimensions: {
        width: 2,
        height: 1,
      },
      declaredColorProfileName: 'Adobe RGB (1998)',
      declaredColorProfileId: 'adobe-rgb',
    }));
    expect(workerClient.contactSheet).toHaveBeenCalledTimes(1);
    expect(fileBridgeState.saveExportBlob).toHaveBeenCalledWith(expect.any(Blob), 'contact_sheet.jpg', 'image/jpeg');
    expect(workerClient.disposeDocument).toHaveBeenCalledWith('contact-sheet-raw-entry');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a clear error when a RAW contact sheet entry is missing a native path', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    const { file } = createFile('scan.nef', 'application/octet-stream');
    const { workerClient } = renderModal({
      entries: [{
        id: 'raw-entry',
        kind: 'file',
        file,
        filename: 'scan.nef',
        size: 128,
        status: 'pending',
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Generate Sheet' }));

    await screen.findByText('RAW files require the desktop app. Missing native path for "scan.nef".');
    expect(coreState.invoke).not.toHaveBeenCalled();
    expect(workerClient.decode).not.toHaveBeenCalled();
    expect(workerClient.contactSheet).not.toHaveBeenCalled();
  });

  it('does not block large RAW files when a native path is available', async () => {
    fileBridgeState.isDesktopShell.mockReturnValue(true);
    coreState.invoke.mockResolvedValue({
      width: 1,
      height: 1,
      data: new Uint8Array([10, 20, 30]),
      color_space: 'sRGB IEC61966-2.1',
    });

    const { file } = createFile('large.nef', 'application/octet-stream');
    const { workerClient } = renderModal({
      entries: [{
        id: 'large-raw-entry',
        kind: 'file',
        file,
        nativePath: '/Users/tester/Desktop/large.nef',
        filename: 'large.nef',
        size: MAX_FILE_SIZE_BYTES + 100,
        status: 'pending',
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Generate Sheet' }));

    await waitFor(() => {
      expect(workerClient.contactSheet).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/exceeds the supported file size limit/i)).not.toBeInTheDocument();
  });

  it('keeps raster files on the arrayBuffer decode path', async () => {
    const { file, arrayBuffer } = createFile('scan.png', 'image/png');
    const { workerClient } = renderModal({
      entries: [{
        id: 'png-entry',
        kind: 'file',
        file,
        filename: 'scan.png',
        size: 4,
        status: 'pending',
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Generate Sheet' }));

    await waitFor(() => {
      expect(arrayBuffer).toHaveBeenCalledTimes(1);
    });

    expect(coreState.invoke).not.toHaveBeenCalled();
    expect(workerClient.decode).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'contact-sheet-png-entry',
      fileName: 'scan.png',
      mime: 'image/png',
      size: 4,
    }));
    expect(workerClient.contactSheet).toHaveBeenCalledTimes(1);
  });
});
