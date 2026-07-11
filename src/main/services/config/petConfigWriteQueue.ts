import { assertValidPetId } from "../../../shared/validation/petId";

const petConfigWriteQueues = new Map<string, Promise<void>>();

/** Serializes complete read-modify-write operations for one pet configuration. */
export async function withPetConfigWriteLock<T>(
  petId: string,
  operation: () => Promise<T>
): Promise<T> {
  const targetPetId = assertValidPetId(petId);
  // Windows pet directories are case-insensitive, so lock aliases share one queue.
  const queueKey = targetPetId.toLocaleLowerCase("en-US");
  const previous = petConfigWriteQueues.get(queueKey) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  petConfigWriteQueues.set(queueKey, queued);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrent?.();

    if (petConfigWriteQueues.get(queueKey) === queued) {
      petConfigWriteQueues.delete(queueKey);
    }
  }
}
