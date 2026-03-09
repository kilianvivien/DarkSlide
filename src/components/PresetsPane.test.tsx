import React from 'react';
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
    });
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
          tags: ['color'],
        }]}
        canSavePreset
        onSavePreset={vi.fn()}
        onImportPreset={vi.fn()}
        onDeletePreset={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /custom/i }));

    expect(screen.getByText('Kodak Portra 400 · Flatbed · Color')).toBeInTheDocument();
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
          tags: ['color'],
        }]}
        canSavePreset
        onSavePreset={vi.fn()}
        onImportPreset={vi.fn()}
        onDeletePreset={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /custom/i }));

    expect(screen.getByText('Kodak Gold 200 · Smartphone · Color')).toBeInTheDocument();
  });
});
