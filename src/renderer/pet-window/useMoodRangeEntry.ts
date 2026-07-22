import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PetMoodRangeEnteredEvent } from "../../shared/types/mood";

export function useMoodRangeEntry(options: {
  busy: boolean;
  trigger: (source: NonNullable<PetMoodRangeEnteredEvent["source"]>) => void;
  speak: (line: string) => void;
}): void {
  const optionsRef = useRef(options);
  const pendingRef = useRef<PetMoodRangeEnteredEvent>();
  const [revision, setRevision] = useState(0);
  useLayoutEffect(() => { optionsRef.current = options; }, [options]);
  useEffect(() => {
    const unsubscribe = window.desktopPet?.mood.onRangeEntered((entry) => { pendingRef.current = entry; setRevision((value) => value + 1); });
    return () => { unsubscribe?.(); };
  }, []);
  useEffect(() => {
    if (!pendingRef.current) return;
    if (options.busy) {
      const retry = window.setTimeout(() => setRevision((value) => value + 1), 200);
      return () => window.clearTimeout(retry);
    }
    const pending = pendingRef.current;
    const timer = window.setTimeout(() => {
      void window.desktopPet?.mood.getDisplayState().then((state) => {
        if (pendingRef.current?.id === pending.id && state.rangeId === pending.rangeId && !optionsRef.current.busy) {
          pendingRef.current = undefined;
          if (pending.source) optionsRef.current.trigger(pending.source);
          if (pending.line) optionsRef.current.speak(pending.line);
        }
      }).catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [options.busy, revision]);
}
