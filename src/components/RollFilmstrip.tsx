import React from 'react';
import { ChevronsRight, Info } from 'lucide-react';
import { DocumentTab, FilmProfile, LightSourceProfile, Roll } from '../types';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import { getRollAccent } from '../utils/rolls';
import { DocumentThumbnail } from './DocumentThumbnail';

type RollFilmstripProps = {
  workerClient: ImageWorkerClient | null;
  tabs: DocumentTab[];
  activeTabId: string | null;
  activeRoll: Roll | null;
  profilesById: Map<string, FilmProfile>;
  lightSourceProfilesById: Map<string, LightSourceProfile>;
  onSelectTab: (tabId: string) => void;
  onOpenRollInfo: () => void;
};

export function RollFilmstrip({
  workerClient,
  tabs,
  activeTabId,
  activeRoll,
  profilesById,
  lightSourceProfilesById,
  onSelectTab,
  onOpenRollInfo,
}: RollFilmstripProps) {
  const accent = getRollAccent(activeRoll?.id ?? null);

  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/90 px-4 py-3 backdrop-blur-xl">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${accent.dot}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-100">
              {activeRoll ? activeRoll.name : 'Open Frames'}
            </p>
            <p className="truncate text-xs text-zinc-500">
              {activeRoll
                ? `${tabs.length} frame${tabs.length === 1 ? '' : 's'} · ${activeRoll.filmStock || 'Roll metadata not set'}`
                : `${tabs.length} open tab${tabs.length === 1 ? '' : 's'}`}
            </p>
          </div>
        </div>

        {activeRoll && (
          <button
            type="button"
            onClick={onOpenRollInfo}
            className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Info size={14} />
            Roll Info
          </button>
        )}
      </div>

      <div
        className="flex gap-3 overflow-x-auto pb-1"
        tabIndex={0}
        onKeyDown={(event) => {
          if (tabs.length < 2) {
            return;
          }

          const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            onSelectTab(tabs[Math.min(tabs.length - 1, Math.max(0, currentIndex + 1))]?.id ?? activeTabId ?? tabs[0].id);
          }
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            onSelectTab(tabs[Math.max(0, currentIndex - 1)]?.id ?? activeTabId ?? tabs[0].id);
          }
        }}
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          const profile = profilesById.get(tab.document.profileId) ?? null;
          const lightSource = lightSourceProfilesById.get(tab.document.lightSourceId ?? 'auto') ?? null;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              className={`group flex shrink-0 flex-col gap-2 rounded-2xl border p-2 text-left transition-all ${
                isActive
                  ? `${accent.border} bg-zinc-900 shadow-lg shadow-black/30`
                  : 'border-zinc-800 bg-zinc-950 hover:bg-zinc-900'
              }`}
            >
              <DocumentThumbnail
                workerClient={workerClient}
                document={tab.document}
                profile={profile}
                lightSource={lightSource}
                size={72}
                className={isActive ? 'border-zinc-600' : ''}
              />
              <div className="w-[72px]">
                <p className="truncate text-[11px] font-medium text-zinc-200">{tab.document.source.name}</p>
                <p className="mt-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                  <span>{index + 1}</span>
                  {isActive && <ChevronsRight size={11} className="text-zinc-400" />}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
