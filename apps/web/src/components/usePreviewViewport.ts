import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { resolvePreviewViewport, stepPreviewZoom, zoomPreviewViewport } from '../../../../packages/core/preview-viewport.mjs';
import type { PreviewRect, PreviewView } from '../../../../packages/core/preview-viewport.mjs';

const FIT: PreviewView = { zoom: 1, x: 0, y: 0 };
type Pan = { id: number; target: HTMLDivElement; startX: number; startY: number; initial: PreviewView; dx: number; dy: number };

export function usePreviewViewport(surface: RefObject<HTMLDivElement | null>, base: PreviewRect, versionId: string, onPanStart: () => void) {
  const [view, setView] = useState(FIT);
  const [hand, setHand] = useState(false);
  const [panning, setPanning] = useState(false);
  const rect = resolvePreviewViewport(base, view);
  const latest = useRef({ base, rect, hand, onPanStart });
  latest.current = { base, rect, hand, onPanStart };
  const gesture = useRef<Pan | null>(null);
  const animation = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const cancelPan = useCallback(() => {
    const current = gesture.current; gesture.current = null;
    if (animation.current !== null) { cancelAnimationFrame(animation.current); animation.current = null; }
    if (current?.target.hasPointerCapture(current.id)) current.target.releasePointerCapture(current.id);
    setPanning(false);
  }, []);
  useLayoutEffect(() => {
    cancelPan();
    setView(previous => { const next = resolvePreviewViewport(base, previous); return { zoom: next.zoom, x: next.x, y: next.y }; });
  }, [base.left, base.top, base.width, base.height, cancelPan]);
  useLayoutEffect(() => { cancelPan(); setView(FIT); setHand(false); }, [versionId, cancelPan]);
  useEffect(() => {
    const blur = () => cancelPan();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !gesture.current) return;
      event.preventDefault(); event.stopPropagation();
      setView(gesture.current.initial); cancelPan();
    };
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('blur', blur); window.removeEventListener('keydown', escape, true); cancelPan(); };
  }, [cancelPan]);
  const reset = useCallback(() => { cancelPan(); setView(FIT); setHand(false); }, [cancelPan]);
  const zoom = useCallback((direction: number) => {
    cancelPan();
    setView(previous => zoomPreviewViewport(latest.current.base, previous, stepPreviewZoom(previous.zoom, direction)));
  }, [cancelPan]);
  useEffect(() => {
    const target = surface.current;
    if (!target) return;
    const wheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || !event.deltaY) return;
      event.preventDefault(); cancelPan();
      const bounds = target.getBoundingClientRect();
      const factor = Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.005);
      setView(previous => zoomPreviewViewport(latest.current.base, previous, previous.zoom * factor, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }));
    };
    target.addEventListener('wheel', wheel, { passive: false });
    return () => target.removeEventListener('wheel', wheel);
  }, [surface, cancelPan]);
  function begin(event: ReactPointerEvent<HTMLDivElement>) {
    if (latest.current.rect.zoom <= 1 || (event.button !== 1 && !(event.button === 0 && latest.current.hand))) return;
    event.preventDefault(); event.stopPropagation(); cancelPan(); latest.current.onPanStart();
    const { zoom, x, y } = latest.current.rect;
    gesture.current = { id: event.pointerId, target: event.currentTarget, startX: event.clientX, startY: event.clientY, initial: { zoom, x, y }, dx: 0, dy: 0 };
    suppressClick.current = event.button === 0;
    event.currentTarget.setPointerCapture(event.pointerId); setPanning(true);
  }
  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    current.dx = event.clientX - current.startX; current.dy = event.clientY - current.startY;
    if (animation.current !== null) return;
    animation.current = requestAnimationFrame(() => {
      animation.current = null;
      const pan = gesture.current;
      if (pan) setView({ ...pan.initial, x: pan.initial.x + pan.dx, y: pan.initial.y + pan.dy });
    });
  }
  function finish(event: ReactPointerEvent<HTMLDivElement>, commit: boolean) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    setView(commit ? { ...current.initial, x: current.initial.x + event.clientX - current.startX, y: current.initial.y + event.clientY - current.startY } : current.initial);
    cancelPan();
  }
  return { rect, hand, panning, reset, zoom, toggleHand: () => { cancelPan(); setHand(value => !value); }, events: {
    onPointerDownCapture: begin, onPointerMoveCapture: move,
    onPointerUpCapture: (event: ReactPointerEvent<HTMLDivElement>) => finish(event, true),
    onPointerCancelCapture: (event: ReactPointerEvent<HTMLDivElement>) => finish(event, false),
    onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => finish(event, false),
    onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (suppressClick.current || latest.current.hand && latest.current.rect.zoom > 1) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
    }
  } };
}
