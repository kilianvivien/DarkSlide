import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../constants';

const fileBridgeState = vi.hoisted(() => ({
  confirmDeletePreset: vi.fn(),
  openPresetFile: vi.fn(),
  savePresetFile: vi.fn(),
}));

vi.mock('../utils/fileBridge', () => ({
  confirmDeletePreset: fileBridgeState.confirmDeletePreset,
  isDesktopShell: () => false,
  openPresetFile: fileBridgeState.openPresetFile,
  savePresetFile: fileBridgeState.savePresetFile,
}));

import { PresetsPane } from './PresetsPane';

describe('PresetsPane', () => {
  it('switches to the custom tab when opening the save preset form', () => {
    render(
      <PresetsPane
        activeStockId="generic-color"
        onStockChange={vi.fn()}
        customPresets={[]}
        canSavePreset
        onSavePreset={vi.fn()}
        onImportPreset={vi.fn()}
        onDeletePreset={vi.fn()}
      />,
    );

    expect(screen.getByText('Generic')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save current preset/i }));

    expect(screen.getByPlaceholderText('Preset Name...')).toBeInTheDocument();
    expect(screen.queryByText('Generic')).not.toBeInTheDocument();
  });

  it('confirms before deleting a custom preset', async () => {
    const onDeletePreset = vi.fn();
    fileBridgeState.confirmDeletePreset.mockResolvedValue(true);

    render(
      <PresetsPane
        activeStockId="custom-1"
        onStockChange={vi.fn()}
        customPresets={[{
          id: 'custom-1',
          version: 1,
          name: 'Portra 400 Push',
          type: 'color',
          description: 'Imported',
          defaultSettings: createDefaultSettings(),
        }]}
        canSavePreset
        onSavePreset={vi.fn()}
        onImportPreset={vi.fn()}
        onDeletePreset={onDeletePreset}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /custom/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete portra 400 push/i }));

    await waitFor(() => {
      expect(fileBridgeState.confirmDeletePreset).toHaveBeenCalledWith('Portra 400 Push');
      expect(onDeletePreset).toHaveBeenCalledWith('custom-1');
    });
  });

  it('passes metadata through the inline save form', () => {
    const onSavePreset = vi.fn();

    render(
      <PresetsPane
        activeStockId="generic-color"
        onStockChange={vi.fn()}
        customPresets={[]}
        canSavePreset
        saveTags={['bw', 'raw']}
        onSavePreset={onSavePreset}
        onImportPreset={vi.fn()}
        onDeletePreset={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save current preset/i }));
    fireEvent.change(screen.getByPlaceholderText('Preset Name...'), { target: { value: 'My Preset' } });
    fireEvent.change(screen.getByPlaceholderText('Optional'), { target: { value: 'Kodak Gold 200' } });
    fireEvent.click(screen.getByLabelText('Smartphone'));
    fireEvent.click(screen.getByRole('button', { name: /save preset/i }));

    expect(onSavePreset).toHaveBeenCalledWith('My Preset', {
      filmStock: 'Kodak Gold 200',
      scannerType: 'smartphone',
      folderId: null,
      saveFraming: false,
    });
  });

  it('lets the user opt into saving crop and rotation with the preset', () => {
    const onSavePreset = vi.fn();

    render(
      <PresetsPane
        activeStockId="generic-color"
        onStockChange={vi.fn()}
        customPresets={[]}
        canSavePreset
        onSavePreset={onSavePreset}
        onImportPreset={vi.fn()}
        onDeletePreset={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save current preset/i }));
    fireEvent.change(screen.getByPlaceholderText('Preset Name...'), { target: { value: 'Crop Preset' } });
    fireEvent.click(screen.getByLabelText(/save crop & rotation/i));
    fireEvent.click(screen.getByRole('button', { name: /save preset/i }));

    expect(onSavePreset).toHaveBeenCalledWith('Crop Preset', {
      filmStock: undefined,
      scannerType: null,
      folderId: null,
      saveFraming: true,
    });
  });

  it('shows save-form tags for B&W RAW presets', () => {
    render(
      <PresetsPane
        activeStockId="generic-color"
        onStockChange={vi.fn()}
        customPresets={[]}
        canSavePreset
        saveTags={['bw', 'raw']}
        onSavePreset={vi.fn()}
        onImportPreset={vi.fn()}
        onDeletePreset={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save current preset/i }));

    expect(screen.getByText('B&W')).toBeInTheDocument();
    expect(screen.getByText('RAW')).toBeInTheDocument();
  });

  it('imports a valid .darkslide file through the browser fallback input', async () => {
    const onImportPreset = vi.fn();
    fileBridgeState.openPresetFile.mockResolvedValue(null);

    render(
      <PresetsPane
        activeStockId="generic-color"
        onStockChange={vi.fn()}
        customPresets={[]}
        canSavePreset
        onSavePreset={vi.fn()}
        onImportPreset={onImportPreset}
        onDeletePreset={vi.fn()}
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /custom/i }));
    fireEvent.click(screen.getByRole('button', { name: /import preset/i }));

    const file = new File([
      JSON.stringify({
        darkslideVersion: '1.0.0',
        profile: {
          id: 'custom-1',
          version: 1,
          name: 'Imported Preset',
          type: 'color',
          description: 'Imported',
          defaultSettings: createDefaultSettings(),
        },
      }),
    ], 'imported.darkslide', { type: 'application/json' });
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: vi.fn().mockResolvedValue(JSON.stringify({
        darkslideVersion: '1.0.0',
        profile: {
          id: 'custom-1',
          version: 1,
          name: 'Imported Preset',
          type: 'color',
          description: 'Imported',
          defaultSettings: createDefaultSettings(),
        },
      })),
    });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(onImportPreset).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Imported Preset',
      }));
    });
  });

  it('shows imported metadata for custom presets', () => {
    render(
      <PresetsPane
        activeStockId="custom-1"
        onStockChange={vi.fn()}
        customPresets={[{
          id: 'custom-1',
          version: 1,
          name: 'Portra 400 Push',
          type: 'color',
          description: 'Imported',
          defaultSettings: createDefaultSettings(),
          filmStock: 'Kodak Portra 400',
          scannerType: 'flatbed',
          tags: ['bw', 'raw'],
        }]}
        canSavePreset
        onSavePreset={vi.fn()}
        onImportPreset={vi.fn()}
        onDeletePreset={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /custom/i }));

    expect(screen.getByText('Film stock')).toBeInTheDocument();
    expect(screen.getByText('Kodak Portra 400')).toBeInTheDocument();
    expect(screen.getByText('Scanner')).toBeInTheDocument();
    expect(screen.getByText('Flatbed')).toBeInTheDocument();
    expect(screen.getByText('B&W')).toBeInTheDocument();
    expect(screen.getByText('RAW')).toBeInTheDocument();
  });

  it('renders smartphone metadata labels for custom presets', () => {
    render(
      <PresetsPane
        activeStockId="custom-1"
        onStockChange={vi.fn()}
        customPresets={[{
          id: 'custom-1',
          version: 1,
          name: 'Phone Scan',
          type: 'color',
          description: 'Imported',
          defaultSettings: createDefaultSettings(),
          filmStock: 'Kodak Gold 200',
          scannerType: 'smartphone',
          tags: ['color', 'non-raw'],
        }]}
        canSavePreset
        onSavePreset={vi.fn()}
        onImportPreset={vi.fn()}
        onDeletePreset={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /custom/i }));

    expect(screen.getByText('Film stock')).toBeInTheDocument();
    expect(screen.getByText('Kodak Gold 200')).toBeInTheDocument();
    expect(screen.getByText('Scanner')).toBeInTheDocument();
    expect(screen.getByText('Smartphone')).toBeInTheDocument();
    expect(screen.getByText('Color')).toBeInTheDocument();
    expect(screen.getByText('Non-RAW')).toBeInTheDocument();
  });

  it('groups built-in stocks by category and labels slide profiles', () => {
    render(
      <PresetsPane
        activeStockId="fuji-provia"
        onStockChange={vi.fn()}
        builtinProfiles={[
          {
            id: 'generic-color',
            version: 1,
            name: 'Generic Color Negative',
            type: 'color',
            description: 'Generic',
            defaultSettings: createDefaultSettings(),
            filmType: 'negative',
            category: 'Generic',
          },
          {
            id: 'kodak-gold',
            version: 1,
            name: 'Kodak Gold 200',
            type: 'color',
            description: 'Kodak',
            defaultSettings: createDefaultSettings(),
            filmType: 'negative',
            category: 'Kodak',
          },
          {
            id: 'fuji-provia',
            version: 1,
            name: 'Fuji Provia 100F',
            type: 'color',
            description: 'Fuji slide',
            defaultSettings: createDefaultSettings(),
            filmType: 'slide',
            category: 'Fuji',
          },
        ]}
        customPresets={[]}
        canSavePreset
        onSavePreset={vi.fn()}
        onImportPreset={vi.fn()}
        onDeletePreset={vi.fn()}
      />,
    );

    expect(screen.getByText('Kodak')).toBeInTheDocument();
    expect(screen.getByText('Fuji')).toBeInTheDocument();

    // Expand collapsed groups to see profile labels
    fireEvent.click(screen.getByText('Kodak'));
    fireEvent.click(screen.getByText('Fuji'));

    expect(screen.getByText('Slide · Color')).toBeInTheDocument();
    expect(screen.getByText('Negative · Color')).toBeInTheDocument();
  });

  it('does not show the old apply stored film base action on the active roll card', () => {
    const activeRoll = {
      id: 'roll-1',
      name: 'Untitled Roll',
      filmStock: null,
      profileId: null,
      camera: null,
      date: null,
      notes: '',
      filmBaseSample: null,
      createdAt: Date.now(),
      directory: null,
    };

    render(
      <PresetsPane
        activeStockId="generic-color"
        onStockChange={vi.fn()}
        customPresets={[]}
        canSavePreset
        onSavePreset={vi.fn()}
        onImportPreset={vi.fn()}
        onDeletePreset={vi.fn()}
        rolls={new Map([[activeRoll.id, activeRoll]])}
        activeRoll={activeRoll}
        filmstripTabs={[]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^rolls$/i }));
    expect(screen.queryByRole('button', { name: /apply stored film base/i })).not.toBeInTheDocument();
  });
});
