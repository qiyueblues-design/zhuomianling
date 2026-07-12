export interface MemorySidecarShutdownTarget {
  shutdown(): Promise<void>;
}

const activeSidecars = new Set<MemorySidecarShutdownTarget>();

export function registerMemorySidecar(target: MemorySidecarShutdownTarget): void {
  activeSidecars.add(target);
}

export function unregisterMemorySidecar(target: MemorySidecarShutdownTarget): void {
  activeSidecars.delete(target);
}

export async function shutdownAllMemorySidecars(): Promise<void> {
  const targets = [...activeSidecars];
  await Promise.allSettled(targets.map((target) => target.shutdown()));
}
