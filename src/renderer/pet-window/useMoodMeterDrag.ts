import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PetMoodMeterPosition } from "../../shared/types/mood";

const edge = 8;
function clamp(position: PetMoodMeterPosition, height: number): PetMoodMeterPosition {
  return { left: Math.min(Math.max(position.left, edge), Math.max(edge, window.innerWidth - 32 - edge)), top: Math.min(Math.max(position.top, edge), Math.max(edge, window.innerHeight - height - edge)) };
}

export function useMoodMeterDrag(initial: PetMoodMeterPosition | undefined, height: number, fallback: PetMoodMeterPosition) {
  const [position, setPosition] = useState(() => clamp(initial ?? fallback, height));
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number }>();
  useEffect(() => { setPosition((current) => clamp(initial ?? current, height)); }, [height, initial?.left, initial?.top]);
  useEffect(() => { const resize = () => setPosition((current) => clamp(current, height)); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, [height]);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => { if (event.button !== 0) return; drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ...position }; event.currentTarget.setPointerCapture(event.pointerId); };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => { const current = drag.current; if (!current || current.id !== event.pointerId) return; setPosition(clamp({ left: current.left + event.clientX - current.x, top: current.top + event.clientY - current.y }, height)); };
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current?.id !== event.pointerId) return; drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setPosition((current) => { const next = clamp(current, height); void window.desktopPet?.mood.saveMeterPosition(next).catch(() => undefined); return next; }); };
  return { position, onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish };
}
