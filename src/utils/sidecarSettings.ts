import { APP_VERSION_LABEL } from '../appVersion';
import { SidecarFile } from '../types';

export const SIDECAR_SUFFIX = '.darkslide-settings';

export function getSidecarPathForExport(exportPath: string) {
  return `${exportPath}${SIDECAR_SUFFIX}`;
}

export function getSidecarCandidatePaths(sourcePath: string) {
  const normalized = sourcePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const directory = lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const basename = fileName.replace(/\.[^.]+$/, '');

  const paths = [
    `${sourcePath}${SIDECAR_SUFFIX}`,
  ];

  if (directory) {
    paths.push(`${directory}/${basename}${SIDECAR_SUFFIX}`);
  } else {
    paths.push(`${basename}${SIDECAR_SUFFIX}`);
  }

  return Array.from(new Set(paths));
}

export function buildSidecarFile(sidecar: Omit<SidecarFile, 'version' | 'generator' | 'createdAt'>): SidecarFile {
  return {
    version: 1,
    generator: `DarkSlide ${APP_VERSION_LABEL}`,
    createdAt: new Date().toISOString(),
    ...sidecar,
  };
}

export function serializeSidecar(sidecar: SidecarFile) {
  return JSON.stringify(sidecar, null, 2);
}

function isValidSidecar(value: unknown): value is SidecarFile {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const sidecar = value as Partial<SidecarFile>;
  const sourceFile = sidecar.sourceFile as SidecarFile['sourceFile'] | undefined;
  return sidecar.version === 1
    && typeof sidecar.generator === 'string'
    && typeof sidecar.createdAt === 'string'
    && !!sourceFile
    && typeof sourceFile.name === 'string'
    && typeof sourceFile.size === 'number'
    && !!sourceFile.dimensions
    && typeof sourceFile.dimensions.width === 'number'
    && typeof sourceFile.dimensions.height === 'number'
    && !!sidecar.settings
    && typeof sidecar.profileId === 'string'
    && typeof sidecar.profileName === 'string'
    && typeof sidecar.isColor === 'boolean'
    && !!sidecar.colorManagement
    && !!sidecar.exportOptions;
}

export function parseSidecar(json: string): SidecarFile | null {
  try {
    const parsed = JSON.parse(json);
    return isValidSidecar(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
