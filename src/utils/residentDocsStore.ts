const STORAGE_KEY = 'darkslide_max_resident_docs';

export const DEFAULT_MAX_RESIDENT_DOCS = 3;
export const MAX_RESIDENT_DOC_OPTIONS = [2, 3, 5] as const;

export type MaxResidentDocs = typeof MAX_RESIDENT_DOC_OPTIONS[number] | null;

export function loadMaxResidentDocs(): MaxResidentDocs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'unlimited') {
      return null;
    }

    const parsed = Number(raw);
    if (MAX_RESIDENT_DOC_OPTIONS.includes(parsed as typeof MAX_RESIDENT_DOC_OPTIONS[number])) {
      return parsed as typeof MAX_RESIDENT_DOC_OPTIONS[number];
    }
  } catch {
    // Ignore storage access failures and fall back to the default.
  }

  return DEFAULT_MAX_RESIDENT_DOCS;
}

export function saveMaxResidentDocs(value: MaxResidentDocs) {
  try {
    localStorage.setItem(STORAGE_KEY, value === null ? 'unlimited' : String(value));
  } catch {
    // Ignore storage access failures.
  }
}
