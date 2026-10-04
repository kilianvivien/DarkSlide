import { describe, expect, it } from 'vitest';
import { createDefaultSettings, DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, FILM_PROFILES, LAB_STYLE_PROFILES_MAP } from '../constants';
import type { FilmProfile, WorkspaceDocument } from '../types';
import { processFloatRaster, resolveDensityInversionParams } from './imagePipeline';
import { createRawImportProfile } from './rawImport';
import { buildProfileSettingsForDocument, createPresetRecipe, resolveDocumentProfile } from './presetRecipe';
import { encodeProfileForTransport, validateDarkslideFile } from './presetStore';

function makeDocument(profile: FilmProfile): WorkspaceDocument {
  return {
    id: 'frame-1',
    source: { id: 'frame-1', name: 'scan.nef', extension: '.nef', mime: 'image/x-raw-rgba', size: 100, width: 4, height: 1 },
    previewLevels: [],
    settings: createDefaultSettings({ ...profile.defaultSettings, exposure: 17, temperature: 9, tint: -1, filmBaseSample: { r: 180, g: 150, b: 90 } }),
    colorManagement: DEFAULT_COLOR_MANAGEMENT,
    estimatedFilmBase: { sample: { r: 107, g: 97, b: 43 }, source: 'low-confidence', confidence: 0, rejectedCandidates: 0, clamped: false },
    estimatedFilmBaseSample: { r: 107, g: 97, b: 43 },
    estimatedDensityBalance: { scaleR: 0.88, scaleG: 1, scaleB: 1.184, source: 'auto-histogram' },
    profileId: profile.id,
    labStyleId: null,
    rollId: null,
    lightSourceId: 'cs-lite',
    exportOptions: DEFAULT_EXPORT_OPTIONS,
    histogram: null,
    renderRevision: 1,
    status: 'ready',
    dirty: true,
  };
}

function render(document: WorkspaceDocument, profile: FilmProfile, settings = document.settings) {
  const lab = document.labStyleId ? LAB_STYLE_PROFILES_MAP[document.labStyleId] : undefined;
  // Fractional samples exercise the 16-bit/float export path, not only 8-bit UI.
  const data = new Float32Array([0.51, 0.41, 0.21, 0.3, 0.25, 0.12, 0.12, 0.08, 0.04, 0.65, 0.55, 0.3]);
  return processFloatRaster({ width: 4, height: 1, data }, settings, profile.type === 'color', 'processed',
    profile.maskTuning, profile.colorMatrix, profile.tonalCharacter, lab?.toneCurve, lab?.channelCurves,
    lab?.tonalCharacterOverride, lab?.saturationBias ?? 0, lab?.temperatureBias ?? 0, 0.0383, 'srgb', 'srgb',
    profile.id, profile.filmType ?? 'negative', null, null, [1, 0.94, 0.88],
    document.estimatedFilmBase, document.estimatedDensityBalance, profile.lut).data;
}

describe('preset conversion recipes', () => {
  it.each(['generic-color', 'gold-200', 'portra-400', 'generic-bw', 'provia-100f'])('preserves pixels through save, JSON transport and repeated apply: %s', (id) => {
    const profile = FILM_PROFILES.find((candidate) => candidate.id === id)!;
    expect(profile).toBeDefined();
    const document = makeDocument(profile);
    if (profile.filmType === 'slide') document.settings.filmBaseSample = null;
    const before = render(document, profile);
    const recipe = createPresetRecipe(document, profile, { id: 'custom-saved', name: 'Saved' }, []);
    const transported = validateDarkslideFile(JSON.parse(JSON.stringify({ darkslideVersion: '1.0.0', profile: encodeProfileForTransport(recipe) })))!.profile;
    const applied = buildProfileSettingsForDocument(transported, document);
    expect(Array.from(render(document, transported, applied))).toEqual(Array.from(before));
    expect(Array.from(render(document, transported, buildProfileSettingsForDocument(transported, { ...document, settings: applied })))).toEqual(Array.from(before));
    expect(document.profileId).toBe(profile.id);
    expect(document.dirty).toBe(true);
  });

  it('carries color transforms and mask biases alongside a lab style', () => {
    const profile: FilmProfile = { ...FILM_PROFILES.find((p) => p.id === 'gold-200')!, maskTuning: { blackPointBias: 0.02, highlightProtectionBias: 0.08 } };
    const document = makeDocument(profile);
    document.labStyleId = 'lab-frontier-modern';
    const preset = createPresetRecipe(document, profile, { id: 'custom-look', name: 'Look' }, []);
    expect(Array.from(render(document, preset, buildProfileSettingsForDocument(preset, document)))).toEqual(Array.from(render(document, profile)));
    expect(preset.maskTuning).toEqual(profile.maskTuning);
    expect(preset.maskTuning).not.toBe(profile.maskTuning);
  });

  it('keeps an automatic zero-confidence RAW estimate automatic after save and apply', () => {
    const base = FILM_PROFILES.find((p) => p.id === 'generic-color')!;
    const document = makeDocument(base);
    document.settings.filmBaseSample = null;
    document.rawImportProfile = createRawImportProfile(base, document.settings);
    document.settings = structuredClone(document.rawImportProfile.defaultSettings);
    const preset = createPresetRecipe(document, document.rawImportProfile, { id: 'custom-raw', name: 'RAW look' }, []);
    const applied = buildProfileSettingsForDocument(preset, document);
    const resolved = resolveDensityInversionParams(applied, true, 'negative', preset.id, document.estimatedFilmBase, document.estimatedDensityBalance);
    expect(applied.filmBaseSample).toBeNull();
    expect(resolved.baseSampleSource).toBe('conservative-fallback');
    expect(resolved.baseConfidence).toBe(0);
    expect(resolved.lowConfidence).toBe(true);
    expect(Array.from(render(document, preset, applied))).toEqual(Array.from(render(document, document.rawImportProfile)));
  });

  it('keeps framing and source repair coordinates on their document', () => {
    const profile = FILM_PROFILES[0];
    const document = makeDocument(profile);
    document.settings.crop = { x: 0.1, y: 0.2, width: 0.6, height: 0.5, aspectRatio: 1.5 };
    document.settings.rotation = 90;
    document.settings.levelAngle = 2;
    document.settings.dustRemoval!.marks = [{ id: 'mark', kind: 'spot', cx: 0.5, cy: 0.5, radius: 0.02, source: 'manual' }];
    const recipe = createPresetRecipe(document, profile, { id: 'custom-look', name: 'Look' }, []);
    expect(recipe.defaultSettings.dustRemoval!.marks).toEqual([]);
    const applied = buildProfileSettingsForDocument(recipe, document);
    expect(applied.crop).toEqual(document.settings.crop);
    expect(applied.rotation).toBe(90);
    expect(applied.levelAngle).toBe(2);
    expect(applied.dustRemoval!.marks).toEqual(document.settings.dustRemoval!.marks);
    const nextFrame = { ...document, settings: createDefaultSettings() };
    expect(buildProfileSettingsForDocument(recipe, nextFrame).dustRemoval!.marks).toEqual([]);
  });

  it('resolves each RAW startup recipe from its own document when IDs collide', () => {
    const gold = FILM_PROFILES.find((p) => p.id === 'gold-200')!;
    const portra = FILM_PROFILES.find((p) => p.id === 'portra-400')!;
    const first = makeDocument(gold), second = makeDocument(portra);
    first.rawImportProfile = createRawImportProfile(gold, first.settings);
    second.rawImportProfile = createRawImportProfile(portra, second.settings);
    first.profileId = second.profileId = first.rawImportProfile.id;
    const map = new Map([[first.profileId, second.rawImportProfile]]);
    expect(resolveDocumentProfile(first, map, gold)).toBe(first.rawImportProfile);
    expect(resolveDocumentProfile(second, map, gold)).toBe(second.rawImportProfile);
  });
});
