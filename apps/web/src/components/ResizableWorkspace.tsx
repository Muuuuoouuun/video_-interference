import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { decodePanelWidths, PANEL_DEFAULTS, PANEL_LIMITS, resolvePanelWidths, resizePanelWidth } from '../../../../packages/core/panel-layout.mjs';
import type { PanelOpen, PanelSide, PanelWidths } from '../../../../packages/core/panel-layout.mjs';
import './ResizableWorkspace.css';

const STORAGE_KEY = 'interference.panel-widths.v1';
function readWidths(): PanelWidths {
  try { return decodePanelWidths(typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY)); }
  catch { return { ...PANEL_DEFAULTS }; }
}
function saveWidths(widths: PanelWidths) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths)); }
  catch { /* Layout remains usable when browser storage is unavailable. */ }
}
interface Gesture {
  side: PanelSide;
  pointerId: number;
  target: HTMLDivElement;
  startX: number;
  latestX: number;
  initial: PanelWidths;
  containerWidth: number;
  open: PanelOpen;
}
interface Props { children: readonly [ReactNode, ReactNode, ReactNode]; projectOpen: boolean; feedbackOpen: boolean }

/** Resize state stays here: unchanged children keep their video, input and scroll state. */
export function ResizableWorkspace({ children, projectOpen, feedbackOpen }: Props) {
  const [preferred, setPreferred] = useState(readWidths);
  const preferredRef = useRef(preferred);
  const [containerWidth, setContainerWidth] = useState(0);
  const [dragging, setDragging] = useState<PanelSide | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const animationRef = useRef<number | null>(null);
  const keyboardPending = useRef(false);
  const open = { project: projectOpen, feedback: feedbackOpen };
  const actual = resolvePanelWidths(preferred, containerWidth, open);

  const updateWidths = useCallback((next: PanelWidths) => {
    preferredRef.current = next;
    setPreferred(previous => previous.project === next.project && previous.feedback === next.feedback ? previous : next);
  }, []);
  const flushKeyboard = useCallback(() => {
    if (!keyboardPending.current) return;
    keyboardPending.current = false;
    saveWidths(preferredRef.current);
  }, []);
  const finishGesture = useCallback((commit: boolean, finalX?: number) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    const next = commit ? resizePanelWidth(gesture.side, gesture.initial, (finalX ?? gesture.latestX) - gesture.startX, gesture.containerWidth, gesture.open) : gesture.initial;
    updateWidths(next);
    if (commit) saveWidths(next);
    document.body.classList.remove('vi-panel-resizing');
    setDragging(null);
    if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
  }, [updateWidths]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let measuredWidth = root.clientWidth;
    setContainerWidth(measuredWidth);
    const observer = new ResizeObserver(entries => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (!next || next === measuredWidth) return;
      measuredWidth = next;
      finishGesture(false);
      setContainerWidth(next);
    });
    observer.observe(root);
    const cancel = () => { finishGesture(false); flushKeyboard(); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !gestureRef.current) return;
      event.preventDefault(); event.stopPropagation(); finishGesture(false);
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape, true);
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (gesture?.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
      document.body.classList.remove('vi-panel-resizing');
      flushKeyboard();
    };
  }, [finishGesture, flushKeyboard]);
  useLayoutEffect(() => { finishGesture(false); }, [projectOpen, feedbackOpen, finishGesture]);

  function begin(event: PointerEvent<HTMLDivElement>, side: PanelSide) {
    if (event.button !== 0 || gestureRef.current || !open[side] || !window.matchMedia('(min-width: 901px)').matches) return;
    event.preventDefault(); event.stopPropagation(); flushKeyboard();
    const width = rootRef.current?.clientWidth;
    if (!width) return;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = { side, pointerId: event.pointerId, target: event.currentTarget, startX: event.clientX, latestX: event.clientX, initial: { ...preferredRef.current }, containerWidth: width, open: { ...open } };
    document.body.classList.add('vi-panel-resizing');
    setDragging(side);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    gesture.latestX = event.clientX;
    if (animationRef.current !== null) return;
    animationRef.current = requestAnimationFrame(() => {
      animationRef.current = null;
      const current = gestureRef.current;
      if (current) updateWidths(resizePanelWidth(current.side, current.initial, current.latestX - current.startX, current.containerWidth, current.open));
    });
  }
  function end(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    finishGesture(commit, commit ? event.clientX : undefined);
  }
  function reset(side: PanelSide) {
    finishGesture(false); flushKeyboard();
    const next = { ...preferredRef.current, [side]: PANEL_DEFAULTS[side] };
    updateWidths(next); saveWidths(next);
  }
  function resizeWithKey(event: KeyboardEvent<HTMLDivElement>, side: PanelSide) {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (gestureRef.current) return;
    if (event.key === 'Enter') { if (!event.repeat) reset(side); return; }
    const delta = event.key === 'Home' ? (side === 'project' ? -100000 : 100000)
      : event.key === 'End' ? (side === 'project' ? 100000 : -100000)
      : (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10);
    updateWidths(resizePanelWidth(side, preferredRef.current, delta, rootRef.current?.clientWidth ?? containerWidth, open));
    keyboardPending.current = true;
  }
  const separator = (side: PanelSide) => {
    if (!open[side]) return null;
    const name = side === 'project' ? '프로젝트' : '댓글';
    const max = resizePanelWidth(side, preferred, side === 'project' ? 100000 : -100000, containerWidth, open)[side];
    return <div className={`workspace-resize-handle workspace-resize-${side}`} role="separator" tabIndex={0} aria-label={`${name} 패널 너비 조절`} aria-orientation="vertical"
      aria-controls={side === 'project' ? 'project-panel-content' : 'feedback-panel-content'}
      aria-valuemin={PANEL_LIMITS[side].min} aria-valuemax={max} aria-valuenow={actual[side]} aria-valuetext={`${Math.round(actual[side])}픽셀`}
      title={`${name} 패널 너비 · 드래그 또는 ← → · Shift로 크게 조절 · 더블클릭/Enter로 기본 너비 · Esc로 드래그 취소`}
      data-active={dragging === side} onPointerDown={event => begin(event, side)} onPointerMove={move}
      onPointerUp={event => end(event, true)} onPointerCancel={event => end(event, false)} onLostPointerCapture={event => end(event, false)}
      onDoubleClick={() => reset(side)} onKeyDown={event => resizeWithKey(event, side)} onKeyUp={flushKeyboard} onBlur={flushKeyboard}><span aria-hidden="true"/></div>;
  };
  return <main ref={rootRef} className={`editor-layout workspace-resizable${projectOpen ? '' : ' project-collapsed'}${feedbackOpen ? '' : ' feedback-collapsed'}`}
    style={containerWidth > 900 ? { '--project-width': `${actual.project}px`, '--feedback-width': `${actual.feedback}px` } as CSSProperties : undefined}>
    {children[0]}{separator('project')}{children[1]}{separator('feedback')}{children[2]}
  </main>;
}
