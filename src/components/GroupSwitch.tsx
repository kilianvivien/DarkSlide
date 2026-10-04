import { memo } from 'react';

interface GroupSwitchProps {
  label: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

/** Small on/off switch for an adjustment group, shown in its section heading. */
export const GroupSwitch = memo(function GroupSwitch({ label, enabled, onChange }: GroupSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${label} adjustments`}
      data-tip={enabled ? `Turn off ${label} to compare` : `Turn on ${label}`}
      onClick={() => onChange(!enabled)}
      className={`relative h-[15px] w-[26px] shrink-0 rounded-full transition-colors ${enabled ? 'bg-accent-400' : 'bg-zinc-700'}`}
    >
      <span
        className={`absolute top-[2px] h-[11px] w-[11px] rounded-full transition-all ${enabled ? 'left-[13px] bg-zinc-950' : 'left-[2px] bg-zinc-400'}`}
      />
    </button>
  );
});
