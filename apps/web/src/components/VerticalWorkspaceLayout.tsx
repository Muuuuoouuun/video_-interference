import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { decodeTimelineHeight, resolveTimelineHeight, resizeTimelineHeight, timelineHeightLimits, TIMELINE_HEIGHT_DEFAULT } from '../../../../packages/core/vertical-layout.mjs';
import './VerticalWorkspaceLayout.css';

const STORAGE_KEY = 'interference.timeline-height.v1';
function readHeight() {
  try { return decodeTimelineHeight(typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY)); }
  catch { return TIMELINE_HEIGHT_DEFAULT; }
}
function saveHeight(height: number) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(height)); }
  catch { /* A private or full store must not prevent local resizing. */ }
}
interface Gesture {
  pointerId: number;
  target: HTMLDivElement;
  startY: number;
  latestY: number;
  initial: number;
  availableHeight: number;
}
interface Props { viewer: ReactNode; children: ReactNode; compact: boolean; simple?: boolean }

/** Local sizing state keeps video, drawings and dock inputs mounted throughout a gesture. */
export function VerticalWorkspaceLayout({ viewer, children, compact, simple = false }: Props) {
  const [preferred, setPreferred] = useState(readHeight);
  const preferredRef = useRef(preferred);
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const rafRef = useRef<number | null>(null);
  const keyboardPending = useRef(false);
  const dockId = useId();
  const height = simple && !compact ? Math.min(160, availableHeight ?? 160) : resolveTimelineHeight(preferred, availableHeight ?? NaN, compact);
  const limits = timelineHeightLimits(availableHeight ?? NaN);
  const adjustable = !compact && !simple && limits.max > limits.min;

  const updateHeight = useCallback((next: number) => {
    preferredRef.current = next;
    setPreferred(next);
  }, []);
  const flushKeyboard = useCallback(() => {
    if (!keyboardPending.current) return;
    keyboardPending.current = false;
    saveHeight(preferredRef.current);
  }, []);
  const finishGesture = useCallback((commit: boolean, finalY?: number) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    const next = commit ? resizeTimelineHeight(gesture.initial, (finalY ?? gesture.latestY) - gesture.startY, gesture.availableHeight) : gesture.initial;
    updateHeight(next);
    if (commit) saveHeight(next);
    document.body.classList.remove('vi-timeline-resizing');
    setDragging(false);
    if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
  }, [updateHeight]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let measuredWidth = root.clientWidth, measuredHeight = root.clientHeight;
    setAvailableHeight(measuredHeight);
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width), next = Math.round(entry.contentRect.height);
      if (width === measuredWidth && next === measuredHeight) return;
      measuredWidth = width; measuredHeight = next;
      finishGesture(false); flushKeyboard(); setAvailableHeight(next);
    });
    observer.observe(root);
    const cancel = () => { finishGesture(false); flushKeyboard(); };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target === window || target === document || target instanceof Element && target.contains(root)) finishGesture(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !gestureRef.current) return;
      event.preventDefault(); event.stopPropagation(); finishGesture(false);
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', escape, true);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (gesture?.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
      document.body.classList.remove('vi-timeline-resizing');
      flushKeyboard();
    };
  }, [finishGesture, flushKeyboard]);
  useLayoutEffect(() => { finishGesture(false); flushKeyboard(); }, [compact, simple, finishGesture, flushKeyboard]);

  function begin(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || gestureRef.current || !adjustable) return;
    const measured = rootRef.current?.clientHeight;
    if (!measured || timelineHeightLimits(measured).max <= timelineHeightLimits(measured).min) return;
    event.preventDefault(); event.stopPropagation(); flushKeyboard();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = { pointerId: event.pointerId, target: event.currentTarget, startY: event.clientY, latestY: event.clientY, initial: preferredRef.current, availableHeight: measured };
    document.body.classList.add('vi-timeline-resizing');
    setDragging(true);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (!(event.buttons & 1)) { finishGesture(false); return; }
    gesture.latestY = event.clientY;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const current = gestureRef.current;
      if (current) updateHeight(resizeTimelineHeight(current.initial, current.latestY - current.startY, current.availableHeight));
    });
  }
  function end(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); finishGesture(commit, commit ? event.clientY : undefined);
  }
  function reset() {
    finishGesture(false); flushKeyboard();
    updateHeight(TIMELINE_HEIGHT_DEFAULT); saveHeight(TIMELINE_HEIGHT_DEFAULT);
  }
  function resizeWithKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (!adjustable || gestureRef.current) return;
    if (event.key === 'Enter') { if (!event.repeat) reset(); return; }
    const delta = event.key === 'Home' ? 100000 : event.key === 'End' ? -100000
      : (event.key === 'ArrowUp' ? -1 : 1) * (event.shiftKey ? 40 : 10);
    updateHeight(resizeTimelineHeight(preferredRef.current, delta, rootRef.current?.clientHeight ?? availableHeight ?? 0));
    keyboardPending.current = true;
  }

  return <div className="vi-vertical-workspace" ref={rootRef} data-compact={compact}
    style={{ '--vi-timeline-height': `${height}px` } as CSSProperties}>
    <div className="vi-viewer-region">{viewer}</div>
    {!compact && !simple ? <div className="vi-vertical-resize-handle" role="separator" tabIndex={adjustable ? 0 : -1} aria-disabled={!adjustable} aria-label="영상과 타임라인 높이 조절" aria-orientation="horizontal"
      aria-controls={dockId} aria-valuemin={limits.min} aria-valuemax={limits.max} aria-valuenow={height} aria-valuetext={`타임라인 ${Math.round(height)}픽셀`}
      title="위아래로 드래그 · ↑ ↓ 10px · Shift 40px · Home 최소 / End 최대 · 더블클릭/Enter 기본 높이 · Esc 드래그 취소"
      data-active={dragging} onPointerDown={begin} onPointerMove={move} onPointerUp={event => end(event, true)} onPointerCancel={event => end(event, false)} onLostPointerCapture={event => end(event, false)}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); if (adjustable) reset(); }} onKeyDown={resizeWithKey} onKeyUp={flushKeyboard} onBlur={flushKeyboard}><span aria-hidden="true"/></div> : null}
    <div className="vi-timeline-dock" id={dockId}>{children}</div>
  </div>;
}
