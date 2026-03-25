const ROLL_ACCENTS = [
  { dot: 'bg-amber-400', border: 'border-amber-500/40', tint: 'rgba(251, 191, 36, 0.22)' },
  { dot: 'bg-emerald-400', border: 'border-emerald-500/40', tint: 'rgba(52, 211, 153, 0.22)' },
  { dot: 'bg-sky-400', border: 'border-sky-500/40', tint: 'rgba(56, 189, 248, 0.22)' },
  { dot: 'bg-rose-400', border: 'border-rose-500/40', tint: 'rgba(251, 113, 133, 0.22)' },
  { dot: 'bg-cyan-400', border: 'border-cyan-500/40', tint: 'rgba(34, 211, 238, 0.22)' },
  { dot: 'bg-lime-400', border: 'border-lime-500/40', tint: 'rgba(163, 230, 53, 0.22)' },
  { dot: 'bg-orange-400', border: 'border-orange-500/40', tint: 'rgba(251, 146, 60, 0.22)' },
  { dot: 'bg-fuchsia-400', border: 'border-fuchsia-500/40', tint: 'rgba(232, 121, 249, 0.22)' },
] as const;

export function getRollAccent(rollId: string | null | undefined) {
  if (!rollId) {
    return {
      dot: 'bg-zinc-700',
      border: 'border-zinc-700/60',
      tint: 'rgba(63, 63, 70, 0.22)',
    };
  }

  let hash = 0;
  for (let index = 0; index < rollId.length; index += 1) {
    hash = ((hash << 5) - hash) + rollId.charCodeAt(index);
    hash |= 0;
  }

  return ROLL_ACCENTS[Math.abs(hash) % ROLL_ACCENTS.length];
}
