import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { seekFrameAtPointer, timelineSeekKey } from '../../../../packages/core/timeline-seek.mjs';
import { time } from '../format';
import './TimelineSeekSurface.css';

interface Props { compact?: boolean; children: ReactNode; durationFrames: number; frame: number; disabled: boolean; onSeek: (frame: number) => void }
interface SeekDrag { pointerId: number; target: HTMLDivElement; bounds: DOMRect; latestX: number; lastFrame: number | null }
interface Preview { frame: number; x: number; labelX: number }
const interactive = 'button, input, textarea, select, a, summary, [contenteditable], [data-timeline-interactive], [role="button"], [role="dialog"], [role="separator"], [role="slider"]:not([data-timeline-seek-control])';
const isControl = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(interactive));

/** Hover and scrub updates are local; the app receives only distinct requested frames. */
export function TimelineSeekSurface({ compact = false, children, durationFrames, frame, disabled, onSeek }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<SeekDrag | null>(null);
  const rafRef = useRef<number | null>(null);
  const hoverX = useRef<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const actionsRef = useRef({ durationFrames, disabled, onSeek });
  actionsRef.current = { durationFrames, disabled, onSeek };

  const clearPending = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    hoverX.current = null;
  }, []);
  const cancel = useCallback((clearPreview = true) => {
    clearPending();
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    if (clearPreview) setPreview(null);
  }, [clearPending]);
  const showAt = useCallback((clientX: number, bounds: DOMRect, drag: SeekDrag | null) => {
    const actions = actionsRef.current;
    if (actions.disabled) return;
    const next = seekFrameAtPointer(clientX, bounds.left, bounds.width, actions.durationFrames);
    if (next === null) return;
    const x = next / actions.durationFrames * bounds.width;
    const labelX = Math.max(Math.min(48, bounds.width / 2), Math.min(bounds.width - 48, x));
    setPreview(previous => previous?.frame === next && previous.x === x && previous.labelX === labelX ? previous : { frame: next, x, labelX });
    if (drag && drag.lastFrame !== next) { drag.lastFrame = next; actions.onSeek(next); }
  }, []);
  const schedule = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const drag = dragRef.current;
      if (drag) showAt(drag.latestX, drag.bounds, drag);
      else if (hoverX.current !== null) {
        const bounds = rootRef.current?.getBoundingClientRect();
        if (bounds) showAt(hoverX.current, bounds, null);
      }
    });
  }, [showAt]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let width = root.clientWidth, height = root.clientHeight;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const nextWidth = Math.round(entry.contentRect.width), nextHeight = Math.round(entry.contentRect.height);
      if (nextWidth !== width || nextHeight !== height) { width = nextWidth; height = nextHeight; cancel(); }
    });
    observer.observe(root);
    const dismiss = () => cancel();
    const scroll = (event: Event) => {
      const target = event.target;
      if (target === window || target instanceof Node && target.contains(root)) cancel();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragRef.current) return;
      event.preventDefault(); event.stopPropagation(); cancel();
    };
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('keydown', escape, true);
      cancel(false);
    };
  }, [cancel]);
  useLayoutEffect(() => { cancel(); }, [disabled, durationFrames, compact, cancel]);

  function begin(event: PointerEvent<HTMLDivElement>) {
    if (disabled || event.button !== 0 || dragRef.current || isControl(event.target)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    event.preventDefault(); event.stopPropagation(); clearPending();
    rulerRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const drag = { pointerId: event.pointerId, target: event.currentTarget, bounds, latestX: event.clientX, lastFrame: null };
    dragRef.current = drag;
    showAt(event.clientX, bounds, drag);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    const drag = dragRef.current;
    if (drag) {
      if (drag.pointerId !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      if (!(event.buttons & 1)) { cancel(); return; }
      drag.latestX = event.clientX;
      schedule();
    } else if (event.pointerType !== 'touch' && !isControl(event.target)) {
      hoverX.current = event.clientX; schedule();
    } else { clearPending(); setPreview(null); }
  }
  function finish(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); clearPending();
    if (commit) showAt(event.clientX, drag.bounds, drag);
    cancel();
  }
  function seekWithKey(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || event.target !== event.currentTarget || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const next = timelineSeekKey(event.key, frame, durationFrames, event.shiftKey);
    if (next === null) return;
    event.preventDefault(); event.stopPropagation(); cancel();
    onSeek(next);
  }

  return <div className="vi-timeline-seek-surface" ref={rootRef} role="group" aria-label="영상 시간축 탐색" data-disabled={disabled} data-compact={compact}
    onPointerDown={begin} onPointerMove={move} onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)} onLostPointerCapture={event => finish(event, false)}
    onPointerOver={event => { if (!dragRef.current && isControl(event.target)) { clearPending(); setPreview(null); } }}
    onPointerLeave={() => { if (!dragRef.current) { clearPending(); setPreview(null); } }}>
    <div className="vi-timeline-ruler" ref={rulerRef} role="slider" data-timeline-seek-control tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label="재생 위치" aria-orientation="horizontal"
      aria-valuemin={0} aria-valuemax={Math.max(0, durationFrames - 1)} aria-valuenow={frame} aria-valuetext={time(frame)} onKeyDown={seekWithKey}
      title="클릭·드래그로 이동 · ← → 프레임 · Shift: 1초 · Home / End: 처음 / 끝 · PageUp / Down: 5초">
      {[0, .25, .5, .75, 1].map(fraction => <span aria-hidden="true" key={fraction} style={{ left: `${fraction * 100}%`, transform: `translateX(${fraction === 0 ? 0 : fraction === 1 ? -100 : -50}%)` }}>{time(Math.round(durationFrames * fraction)).split('.')[0]}</span>)}
    </div>
    {children}
    {preview && !disabled ? <div className="vi-timeline-hover" aria-hidden="true"><span className="vi-timeline-hover-line" style={{ left: preview.x }}/><span className="vi-timeline-hover-time" style={{ left: preview.labelX }}>{time(preview.frame)}</span></div> : null}
  </div>;
}
