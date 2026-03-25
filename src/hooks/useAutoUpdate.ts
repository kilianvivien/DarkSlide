import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { UpdateChannel } from '../types';
import { isDesktopShell } from '../utils/fileBridge';

const DISMISSED_UPDATE_KEY = 'darkslide_dismissed_update';

type UpdateResponse = {
  version: string;
  currentVersion: string;
  releaseNotes: string | null;
};

type UpdaterStatusResponse = {
  enabled: boolean;
  reason: string | null;
};

export type UpdateState = {
  enabled: boolean;
  available: boolean;
  version: string | null;
  releaseNotes: string | null;
  downloadProgress: number | null;
  dismissed: boolean;
  error: string | null;
  disabledReason: string | null;
  lastCheckedAt: number | null;
  isChecking: boolean;
  isDownloading: boolean;
};

function getDismissedVersion() {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem(DISMISSED_UPDATE_KEY);
}

export function useAutoUpdate(channel: UpdateChannel) {
  const [state, setState] = useState<UpdateState>({
    enabled: false,
    available: false,
    version: null,
    releaseNotes: null,
    downloadProgress: null,
    dismissed: false,
    error: null,
    disabledReason: null,
    lastCheckedAt: null,
    isChecking: false,
    isDownloading: false,
  });

  const isDesktop = useMemo(() => isDesktopShell(), []);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const status = await invoke<UpdaterStatusResponse | null>('get_updater_status');
        if (cancelled) {
          return;
        }

        setState((current) => ({
          ...current,
          enabled: status?.enabled ?? false,
          disabledReason: status?.reason ?? 'Updater is unavailable in this environment.',
        }));
      } catch (error) {
        if (cancelled) {
          return;
        }

        setState((current) => ({
          ...current,
          enabled: false,
          disabledReason: error instanceof Error ? error.message : String(error),
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  const checkNow = useCallback(async () => {
    if (!isDesktop || !state.enabled) {
      return;
    }

    setState((current) => ({ ...current, isChecking: true, error: null }));
    try {
      const update = await invoke<UpdateResponse | null>('check_for_update', { channel });
      const dismissedVersion = getDismissedVersion();

      setState((current) => ({
        ...current,
        available: Boolean(update),
        version: update?.version ?? null,
        releaseNotes: update?.releaseNotes ?? null,
        dismissed: Boolean(update && dismissedVersion === update.version),
        error: null,
        lastCheckedAt: Date.now(),
        isChecking: false,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        available: false,
        error: error instanceof Error ? error.message : String(error),
        lastCheckedAt: Date.now(),
        isChecking: false,
      }));
    }
  }, [channel, isDesktop, state.enabled]);

  const startDownload = useCallback(async () => {
    if (!isDesktop || !state.enabled) {
      return;
    }

    setState((current) => ({ ...current, isDownloading: true, downloadProgress: null, error: null }));
    try {
      await invoke('install_update_and_restart');
    } catch (error) {
      setState((current) => ({
        ...current,
        isDownloading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [isDesktop, state.enabled]);

  const dismiss = useCallback(() => {
    if (typeof window !== 'undefined' && state.version) {
      window.localStorage.setItem(DISMISSED_UPDATE_KEY, state.version);
    }
    setState((current) => ({ ...current, dismissed: true }));
  }, [state.version]);

  useEffect(() => {
    if (!isDesktop || !state.enabled) {
      return;
    }

    const launchTimer = window.setTimeout(() => {
      void checkNow();
    }, 5000);
    const interval = window.setInterval(() => {
      void checkNow();
    }, 24 * 60 * 60 * 1000);

    return () => {
      window.clearTimeout(launchTimer);
      window.clearInterval(interval);
    };
  }, [checkNow, isDesktop, state.enabled]);

  useEffect(() => {
    if (!isDesktop || !state.enabled) {
      return;
    }
    void checkNow();
  }, [channel, checkNow, isDesktop, state.enabled]);

  return {
    state,
    checkNow,
    startDownload,
    installAndRestart: startDownload,
    dismiss,
  };
}
