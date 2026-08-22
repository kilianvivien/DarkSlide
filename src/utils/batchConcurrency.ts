export type BatchConcurrencySetting = 'auto' | 1 | 2 | 3 | 4 | 5;

export interface BatchMachineCapacity {
  hardwareConcurrency?: number;
  deviceMemoryGb?: number;
}

export function getBatchMachineCapacity(): BatchMachineCapacity {
  if (typeof navigator === 'undefined') return {};
  const memoryNavigator = navigator as Navigator & { deviceMemory?: number };
  return {
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGb: memoryNavigator.deviceMemory,
  };
}

export function resolveBatchConcurrency(
  setting: BatchConcurrencySetting,
  capacity: BatchMachineCapacity = getBatchMachineCapacity(),
) {
  if (setting !== 'auto') return setting;

  const cores = capacity.hardwareConcurrency ?? 6;
  const cpuLimit = cores >= 12 ? 5 : cores >= 8 ? 4 : cores >= 6 ? 3 : 2;
  const memory = capacity.deviceMemoryGb;
  const memoryLimit = memory === undefined
    ? 3
    : memory >= 32
      ? 5
      : memory >= 24
        ? 4
        : memory >= 8
          ? 3
          : 2;

  return Math.max(1, Math.min(5, cpuLimit, memoryLimit));
}
