import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Circle, CornerUpLeft, CornerUpRight, Eraser, MousePointer2, Pencil, Plus, RotateCcw, Slash, Square, Trash2, Type, X } from 'lucide-react';
import type { Drawing, Point } from '../../../../packages/core/types';
import { arrowHeadPoints, createDrawing, drawingBounds, drawingResizeHandles, isDrawableSize, normalizeDrawing, translateDrawing } from '../../../../packages/core/overlay-geometry.mjs';
import type { DrawingHandle, DrawingStyle } from '../../../../packages/core/overlay-geometry.mjs';
import { createOverlayGesture } from '../../../../packages/core/overlay-gesture.mjs';
import type { OverlayGesture } from '../../../../packages/core/overlay-gesture.mjs';
import { createTextDrawing, scaleTextDrawing, textDrawingLayout, DRAWING_TEXT_FONT, MAX_DRAWING_TEXT, MAX_DRAWING_TEXT_LINES, drawingTextLines } from '../../../../packages/core/overlay-text.mjs';
import { drawingFrame, groupDrawings } from '../../../../packages/core/drawing-anchors.mjs';
import { changedDrawingFrames, createDrawingHistoryStore } from '../../../../packages/core/drawing-history.mjs';
import type { DrawingHistorySession } from '../../../../packages/core/drawing-history.mjs';
import { time as frameTime } from '../format';
import './OverlayEditor.css';

type Tool = 'select' | Drawing['kind'];
type Viewport = { left: number; top: number; width: number; height: number };
type Gesture = { kind: 'create' | 'move' | 'resize'; pointerId: number; frame: number; original: Drawing; draft: OverlayGesture; bounds: DOMRect };
type StylePopover = { anchor: DOMRect; textPoint?: Point; textId?: string };
type EditorStyle = DrawingStyle & { fontSize: number };
const DEFAULT_STYLE: DrawingStyle = { color: '#bcf7de', strokeWidth: 3, opacity: 1, fill: 'none' };
const COLORS = ['#bcf7de', '#ffffff', '#ffd166', '#ff7878', '#86baff'];
const SHAPE_LIMIT = 30;
const EMPTY_DRAWINGS: Drawing[] = [];
const TOOL_OPTIONS: { id: Tool; label: string; shortcut: string; icon: typeof MousePointer2 }[] = [
  { id: 'select', label: '선택', shortcut: 'V', icon: MousePointer2 },
  { id: 'rect', label: '박스', shortcut: 'B', icon: Square },
  { id: 'ellipse', label: '원', shortcut: 'E', icon: Circle },
  { id: 'line', label: '선', shortcut: 'L', icon: Slash },
  { id: 'arrow', label: '화살표', shortcut: 'A', icon: ArrowUpRight },
  { id: 'pen', label: '펜', shortcut: 'P', icon: Pencil },
  { id: 'text', label: '텍스트', shortcut: 'T', icon: Type },
];
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const pointAt = (event: { clientX: number; clientY: number }, bounds: DOMRect): Point => ({ x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height) });

interface OverlayEditorProps {
  drawings: Drawing[];
  currentFrame: number;
  fallbackFrame?: number;
  onFrameSelect?: (frame: number) => void;
  onChange: (drawings: Drawing[]) => void;
  viewport: Viewport;
  enabled: boolean;
  blocked?: boolean;
  readOnly?: boolean;
  blockedLabel?: string;
  onPause: () => void;
  onToolSelect?: () => void;
  onBackgroundClick: () => void;
  toolbarHost: HTMLElement | null;
  toolsHost?: HTMLElement | null;
  resetKey: string;
  onHistoryChange?: (available: boolean) => void;
  onInsertDrawings?: () => void;
  onCreate?: (frame: number) => void;
}

const Shape = memo(function Shape({ drawing, logicalHeight, displayScale }: { drawing: Drawing; logicalHeight: number; displayScale: number }) {
  const points = drawing.points;
  const start = points[0], end = points[points.length - 1];
  const linePoints = useMemo(() => drawing.kind === 'pen' ? points.map((point) => `${(point.x * 1000).toFixed(2)},${(point.y * logicalHeight).toFixed(2)}`).join(' ') : '', [drawing.kind, points, logicalHeight]);
  const arrowPoints = useMemo(() => drawing.kind === 'arrow' && start && end ? arrowHeadPoints({ x: start.x * 1000, y: start.y * logicalHeight }, { x: end.x * 1000, y: end.y * logicalHeight }, drawing.strokeWidth ?? 3).map((point) => `${point.x},${point.y}`).join(' ') : null, [drawing.kind, drawing.strokeWidth, start, end, logicalHeight]);
  const region = drawing.region || (drawing.kind === 'rect' || drawing.kind === 'ellipse' || drawing.kind === 'text' ? drawingBounds(drawing) : null);
  if ((!start || !end) && drawing.kind !== 'rect' && drawing.kind !== 'ellipse' && drawing.kind !== 'text') return null;
  const common = { stroke: drawing.color, strokeWidth: drawing.strokeWidth ?? 3, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  // Hit strokes use screen pixels; artwork uses the logical 1000-unit canvas.
  const hitStyle = { strokeWidth: Math.max(14, (drawing.strokeWidth ?? 3) * displayScale) };
  const textLayout = drawing.kind === 'text' ? textDrawingLayout(drawing, logicalHeight) : null;
  const shape = textLayout ? <g fill={drawing.color} fontFamily={DRAWING_TEXT_FONT} fontSize={textLayout.fontSize} fontWeight={600}>
    {textLayout.lines.map((line, index) => line.text ? <text key={index} x={line.x} y={line.y} textLength={line.width} lengthAdjust="spacingAndGlyphs" xmlSpace="preserve">{line.text}</text> : null)}
  </g> : drawing.kind === 'rect' && region ? <rect {...common} x={region.x * 1000} y={region.y * logicalHeight} width={region.w * 1000} height={region.h * logicalHeight} fill={drawing.fill || 'none'} />
    : drawing.kind === 'ellipse' && region ? <ellipse {...common} cx={(region.x + region.w / 2) * 1000} cy={(region.y + region.h / 2) * logicalHeight} rx={region.w * 500} ry={region.h * logicalHeight / 2} fill={drawing.fill || 'none'} />
      : drawing.kind === 'pen' ? points.length === 1 ? <circle cx={start.x * 1000} cy={start.y * logicalHeight} r={(drawing.strokeWidth ?? 3) / 2} fill={drawing.color} /> : <polyline {...common} points={linePoints} />
        : <g><line {...common} x1={start.x * 1000} y1={start.y * logicalHeight} x2={end.x * 1000} y2={end.y * logicalHeight} />{arrowPoints ? <polygon points={arrowPoints} fill={drawing.color} /> : null}</g>;
  return <g data-drawing-id={drawing.id} className="oe-shape">
    <g className="oe-artwork" opacity={drawing.opacity ?? 1}>{shape}</g>
    {(drawing.kind === 'rect' || drawing.kind === 'ellipse' || drawing.kind === 'text') && region ? <rect className="oe-hit oe-hit-area" style={hitStyle} x={region.x * 1000} y={region.y * logicalHeight} width={region.w * 1000} height={region.h * logicalHeight} />
      : drawing.kind === 'pen' ? points.length === 1 ? <circle className="oe-hit-point" cx={start.x * 1000} cy={start.y * logicalHeight} r={Math.max((drawing.strokeWidth ?? 3) / 2, 7 / displayScale)} /> : <polyline className="oe-hit" style={hitStyle} points={linePoints} />
        : <g><line className="oe-hit" style={hitStyle} x1={start.x * 1000} y1={start.y * logicalHeight} x2={end.x * 1000} y2={end.y * logicalHeight} />{arrowPoints ? <polygon className="oe-hit oe-hit-area" points={arrowPoints} /> : null}</g>}
  </g>;
});

const CommittedShapes = memo(function CommittedShapes({ drawings, hiddenId, logicalHeight, displayScale }: { drawings: Drawing[]; hiddenId: string | null; logicalHeight: number; displayScale: number }) {
  return <g>{drawings.map((drawing) => drawing.id === hiddenId ? null : <Shape key={drawing.id} drawing={drawing} logicalHeight={logicalHeight} displayScale={displayScale} />)}</g>;
});

const SelectionHandles = memo(function SelectionHandles({ drawing, logicalHeight, viewport }: { drawing: Drawing; logicalHeight: number; viewport: Viewport }) {
  const pixel = 1000 / Math.max(1, viewport.width), size = 9 * pixel;
  if (drawing.kind === 'pen' && drawing.points.length === 1) {
    const point = drawing.points[0];
    return <circle cx={point.x * 1000} cy={point.y * logicalHeight} r={Math.max((drawing.strokeWidth ?? 3) / 2 + 3 * pixel, 6 * pixel)} fill="none" stroke="#bcf7de" strokeWidth="1" vectorEffect="non-scaling-stroke" pointerEvents="none" />;
  }
  const bounds = drawingBounds(drawing);
  const handles = drawingResizeHandles(drawing, viewport.width, viewport.height, bounds);
  return <g className="oe-selection">
    <rect x={bounds.x * 1000} y={bounds.y * logicalHeight} width={bounds.w * 1000} height={bounds.h * logicalHeight} fill="none" stroke="#bcf7de" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" pointerEvents="none" />
    {handles.map((handle) => <g key={handle.id} data-handle={handle.id} className={`oe-handle oe-handle-${handle.id}`}>
      <rect x={handle.x * 1000 - 9 * pixel} y={handle.y * logicalHeight - 9 * pixel} width={18 * pixel} height={18 * pixel} fill="transparent" />
      <rect x={handle.x * 1000 - size / 2} y={handle.y * logicalHeight - size / 2} width={size} height={size} fill="#bcf7de" stroke="#12352a" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </g>)}
  </g>;
});

export const OverlayEditor = memo(function OverlayEditor({ drawings, currentFrame, fallbackFrame, onFrameSelect, onChange, viewport, enabled, blocked = false, readOnly = false, blockedLabel = '이미지 배치 중', onPause, onToolSelect, onBackgroundClick, toolbarHost, toolsHost, resetKey, onHistoryChange, onInsertDrawings, onCreate }: OverlayEditorProps) {
  const ownerId = `oe-${useId().replace(/:/g, '')}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<EditorStyle>({ ...DEFAULT_STYLE, fontSize: 32 });
  const [popover, setPopover] = useState<StylePopover | null>(null);
  const [popoverPosition, setPopoverPosition] = useState({ left: 8, top: 8 });
  const [textDraft, setTextDraft] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverTrigger = useRef<HTMLButtonElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const lastTextTap = useRef<{ id: string; time: number; x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<Drawing | null>(null);
  const [previewOffset, setPreviewOffset] = useState<Point | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const [historyFrameHint, setHistoryFrameHint] = useState<number|null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const rafRef = useRef<number | null>(null);
  const presentRef = useRef(drawings);
  const emittedRef = useRef<Drawing[] | null>(null);
  const [historyStore] = useState(() => createDrawingHistoryStore({ maxContexts: 1 }));
  const historySessionRef = useRef<DrawingHistorySession | null>(null);
  const editGroupRef = useRef<{ kind: 'style' | 'nudge'; key?: string } | null>(null);
  const historyAvailableRef = useRef(false);
  const activeRef = useRef(false);
  const previousResetRef = useRef(resetKey);
  const previousReadOnlyRef = useRef(readOnly);
  const resolvedFallback = fallbackFrame ?? currentFrame;
  const frameGroups = useMemo(() => groupDrawings(drawings, resolvedFallback), [drawings, resolvedFallback]);
  const visibleDrawings = frameGroups.find(group => group.frame === currentFrame)?.drawings ?? EMPTY_DRAWINGS;
  const selected = visibleDrawings.find((drawing) => drawing.id === selectedId);
  const latestRef = useRef({ onChange, onPause, onToolSelect, onBackgroundClick, defaults, selectedId: selected?.id ?? null, tool, viewport, enabled, blocked, readOnly, onCreate, onHistoryChange, currentFrame, fallbackFrame: resolvedFallback });
  latestRef.current = { onChange, onPause, onToolSelect, onBackgroundClick, defaults, selectedId: selected?.id ?? null, tool, viewport, enabled, blocked, readOnly, onCreate, onHistoryChange, currentFrame, fallbackFrame: resolvedFallback };
  // Keep a constant aspect ratio stable across subpixel panel sizes, so resizing
  // does not serialize every long pen path for floating-point rounding noise.
  const logicalHeight = viewport.width > 0 ? Math.round(1e6 * 1000 * viewport.height / viewport.width) / 1e6 : 562.5;
  const displayScale = Math.max(1, viewport.width) / 1000;
  const style: EditorStyle = selected ? { color: selected.color, strokeWidth: selected.strokeWidth ?? 3, opacity: selected.opacity ?? 1, fill: selected.fill || 'none', fontSize: selected.kind === 'text' ? textDrawingLayout(selected, logicalHeight).fontSize : defaults.fontSize } : defaults;
  const editingText = Boolean(popover?.textPoint || popover?.textId);
  const textStyle = tool === 'text' || selected?.kind === 'text' || editingText;
  const closedShape = selected ? selected.kind === 'rect' || selected.kind === 'ellipse' : tool === 'rect' || tool === 'ellipse';
  const hiddenId = gestureRef.current?.kind !== 'create' ? preview?.id || null : null;
  const visiblePreview = preview && drawingFrame(preview, resolvedFallback) === currentFrame ? preview : null;
  // Translation preserves every point's relative geometry. Keep long SVG pen
  // paths stable while dragging; update a single transform until commit.
  const movingOriginal = visiblePreview && gestureRef.current?.kind === 'move' ? gestureRef.current.original : null;
  const previewTransform = movingOriginal && previewOffset
    ? `translate(${previewOffset.x * 1000} ${previewOffset.y * logicalHeight})` : undefined;
  const selection = visiblePreview && visiblePreview.id === selectedId ? visiblePreview : selected;

  const cancelGesture = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (gesture && svgRef.current?.hasPointerCapture(gesture.pointerId)) svgRef.current.releasePointerCapture(gesture.pointerId);
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    setPreview(null);
    setPreviewOffset(null);
  }, []);

  useLayoutEffect(() => {
    if (gestureRef.current) cancelGesture();
  }, [viewport.left, viewport.top, viewport.width, viewport.height, cancelGesture]);

  useEffect(() => {
    const onResize = () => { if (gestureRef.current) cancelGesture(); };
    const onScroll = (event: Event) => {
      const svg = svgRef.current, target = event.target;
      if (!gestureRef.current || !svg) return;
      // Scrolling a sibling panel does not move this canvas. Ancestor scrolling does,
      // even when its size (and therefore ResizeObserver's result) stays unchanged.
      if (target === window || target === document || target instanceof Element && target.contains(svg)) cancelGesture();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('scroll', onScroll, true); };
  }, [cancelGesture]);

  function cancelPointerGesture(event: ReactPointerEvent<SVGSVGElement>) {
    if (gestureRef.current?.pointerId === event.pointerId) cancelGesture();
  }

  const notifyHistory = useCallback(() => {
    const session = historySessionRef.current;
    if (!session) return;
    const available = session.canUndo || session.canRedo;
    if (historyAvailableRef.current !== available) {
      historyAvailableRef.current = available;
      latestRef.current.onHistoryChange?.(available);
    }
  }, []);

  const emit = useCallback((next: Drawing[]) => {
    presentRef.current = next;
    emittedRef.current = next;
    latestRef.current.onChange(next);
    notifyHistory();
    setHistoryRevision(revision => revision + 1);
  }, [notifyHistory]);

  const endEditGroup = useCallback(() => {
    editGroupRef.current = null;
    const session = historySessionRef.current;
    if (!session) return;
    const changed = session.endGroup();
    presentRef.current = session.present;
    notifyHistory();
    if (changed) setHistoryRevision(revision => revision + 1);
  }, [notifyHistory]);

  const commit = useCallback((next: Drawing[]) => {
    endEditGroup();
    const session = historySessionRef.current;
    if (!session?.commit(next)) return;
    emit(session.present);
    setHistoryFrameHint(null);
  }, [emit, endEditGroup]);

  useLayoutEffect(() => {
    const contextChanged = previousResetRef.current !== resetKey || previousReadOnlyRef.current !== readOnly;
    previousResetRef.current = resetKey;
    previousReadOnlyRef.current = readOnly;
    if (!contextChanged && !readOnly && drawings === emittedRef.current) { emittedRef.current = null; return; }
    endEditGroup();
    // Review data never occupies or resets the editable draft's history slot.
    historySessionRef.current = readOnly ? null : historyStore.activate(resetKey, drawings, latestRef.current.fallbackFrame);
    presentRef.current = historySessionRef.current?.present ?? drawings;
    emittedRef.current = null;
    notifyHistory();
    setHistoryRevision(revision => revision + 1);
    setSelectedId(null);
    setHistoryFrameHint(null);
    setNotice('');
    cancelGesture();
  }, [drawings, resetKey, readOnly, historyStore, endEditGroup, notifyHistory, cancelGesture]);

  useEffect(() => {
    if (!enabled || blocked || readOnly) { endEditGroup(); cancelGesture(); }
    return cancelGesture;
  }, [enabled, blocked, readOnly, cancelGesture, endEditGroup]);

  useEffect(() => {
    endEditGroup();
    cancelGesture();
    setSelectedId(null); lastTextTap.current = null;
  }, [currentFrame, endEditGroup, cancelGesture]);

  const undo = useCallback(() => {
    endEditGroup();
    cancelGesture();
    const session = historySessionRef.current, before = session?.present;
    const previous = session?.undo();
    if (!previous || !before) return;
    const changed = changedDrawingFrames(before, previous, latestRef.current.fallbackFrame);
    emit(previous);
    setSelectedId(null);
    setHistoryFrameHint(changed.find(frame => frame !== latestRef.current.currentFrame) ?? null);
    setNotice(changed.length ? `되돌리기 · ${changed.map(frame => frameTime(frame)).join(', ')} 장면의 그림 변경` : '그림 기록을 되돌렸습니다.');
  }, [cancelGesture, emit, endEditGroup]);

  const redo = useCallback(() => {
    endEditGroup();
    cancelGesture();
    const session = historySessionRef.current, before = session?.present;
    const next = session?.redo();
    if (!next || !before) return;
    const changed = changedDrawingFrames(before, next, latestRef.current.fallbackFrame);
    emit(next);
    setSelectedId(null);
    setHistoryFrameHint(changed.find(frame => frame !== latestRef.current.currentFrame) ?? null);
    setNotice(changed.length ? `다시 실행 · ${changed.map(frame => frameTime(frame)).join(', ')} 장면의 그림 변경` : '그림 기록을 다시 실행했습니다.');
  }, [cancelGesture, emit, endEditGroup]);

  const deleteSelected = useCallback(() => {
    const id = latestRef.current.selectedId;
    if (!id) return;
    cancelGesture();
    commit(presentRef.current.filter((drawing) => drawing.id !== id || drawingFrame(drawing, latestRef.current.fallbackFrame) !== latestRef.current.currentFrame));
    setSelectedId(null);
  }, [cancelGesture, commit]);

  const clearCurrentFrame = useCallback(() => {
    const current = latestRef.current;
    if (current.blocked || current.readOnly || !current.enabled) return;
    cancelGesture();
    commit(presentRef.current.filter(drawing => drawingFrame(drawing, current.fallbackFrame) !== current.currentFrame));
    setSelectedId(null);
  }, [cancelGesture, commit]);

  const chooseTool = useCallback((nextTool: Tool) => {
    if (latestRef.current.blocked || latestRef.current.readOnly) return;
    latestRef.current.onPause();
    latestRef.current.onToolSelect?.();
    endEditGroup();
    cancelGesture();
    activeRef.current = true;
    setTool(nextTool);
    setPopover(null);
    if (nextTool !== 'select') setSelectedId(null);
    setNotice('');
  }, [cancelGesture, endEditGroup]);

  const closePopover = useCallback((restoreFocus = false) => {
    endEditGroup(); setPopover(null);
    if (restoreFocus) (popoverTrigger.current ?? svgRef.current)?.focus({ preventScroll: true });
  }, [endEditGroup]);

  useLayoutEffect(() => {
    if (!popover || !popoverRef.current) return;
    const bounds = popoverRef.current.getBoundingClientRect(), margin = 8, gap = 8;
    const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
    const above = popover.anchor.top - gap - bounds.height;
    setPopoverPosition({
      left: Math.max(margin, Math.min(width - bounds.width - margin, popover.anchor.left)),
      top: Math.max(margin, Math.min(height - bounds.height - margin, above >= margin ? above : popover.anchor.bottom + gap)),
    });
    if (popover.textPoint || popover.textId) textInputRef.current?.focus({ preventScroll: true });
    else popoverRef.current.focus({ preventScroll: true });
  }, [popover]);

  useEffect(() => {
    if (!popover) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !popoverRef.current?.contains(target) && !popoverTrigger.current?.contains(target)) closePopover();
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node && popoverRef.current?.contains(event.target))) closePopover(); };
    const resize = () => closePopover();
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize); };
  }, [popover, closePopover]);

  useEffect(() => { closePopover(); }, [currentFrame, resetKey, readOnly, enabled, blocked, closePopover]);

  useEffect(() => {
    const handleFocus = (event: Event) => {
      const target = event.target;
      const owned = target instanceof Element && Boolean(target.closest(`[data-overlay-owner="${ownerId}"]`));
      if (!owned || editGroupRef.current?.kind === 'nudge') endEditGroup();
      activeRef.current = owned;
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (editGroupRef.current?.kind === 'nudge' && editGroupRef.current.key === event.key) endEditGroup();
    };
    const handleBlur = () => { endEditGroup(); cancelGesture(); activeRef.current = false; };

    const handleKey = (event: KeyboardEvent) => {
      const current = latestRef.current;
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || !activeRef.current || current.blocked || current.readOnly) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (target && target !== document.body && !target.closest(`[data-overlay-owner="${ownerId}"]`)) return;
      const key = event.key.toLowerCase();
      const modifier = event.metaKey || event.ctrlKey;
      if (gestureRef.current && !modifier && !event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        // The active pointer owns geometry until release; a seek or nudge would overwrite its preview.
        event.preventDefault(); event.stopPropagation(); return;
      }
      let handled = false;
      if (key === 'escape') { cancelGesture(); setSelectedId(null); setTool('select'); handled = true; }
      else if (modifier && key === 'z' && current.enabled) { event.shiftKey ? redo() : undo(); handled = true; }
      else if (modifier && key === 'y' && current.enabled) { redo(); handled = true; }
      else if ((key === 'delete' || key === 'backspace') && current.selectedId && current.enabled) { deleteSelected(); handled = true; }
      else if (!modifier && !event.altKey && current.selectedId && current.enabled && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        const amount = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowRight' ? amount / current.viewport.width : event.key === 'ArrowLeft' ? -amount / current.viewport.width : 0;
        const dy = event.key === 'ArrowDown' ? amount / current.viewport.height : event.key === 'ArrowUp' ? -amount / current.viewport.height : 0;
        if (current.viewport.width <= 0 || current.viewport.height <= 0) return;
        const session = historySessionRef.current;
        if (!session) return;
        if (!event.repeat || editGroupRef.current?.kind !== 'nudge' || editGroupRef.current.key !== event.key) {
          endEditGroup(); session.beginGroup(); editGroupRef.current = { kind: 'nudge', key: event.key };
        }
        const next = presentRef.current.map(drawing => drawing.id === current.selectedId && drawingFrame(drawing, current.fallbackFrame) === current.currentFrame ? translateDrawing(drawing, dx, dy) : drawing);
        if (session.updateGroup(next)) { emit(session.present); setHistoryFrameHint(null); }
        handled = true;
      } else if (!modifier && !event.altKey) {
        const option = TOOL_OPTIONS.find((item) => item.shortcut.toLowerCase() === key);
        if (option) { chooseTool(option.id); handled = true; }
        else if (key === 'd') { chooseTool(current.tool === 'rect' ? 'select' : 'rect'); handled = true; }
      }
      if (handled) { event.preventDefault(); event.stopPropagation(); }
    };
    document.addEventListener('pointerdown', handleFocus, true);
    document.addEventListener('focusin', handleFocus, true);
    window.addEventListener('keydown', handleKey, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('pointerdown', handleFocus, true);
      document.removeEventListener('focusin', handleFocus, true);
      window.removeEventListener('keydown', handleKey, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [ownerId, cancelGesture, chooseTool, deleteSelected, redo, undo, endEditGroup, emit]);

  const schedulePreview = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const gesture = gestureRef.current;
      if (gesture?.kind === 'move') setPreviewOffset(gesture.draft.translation());
      else if (gesture) setPreview(gesture.draft.flush());
    });
  }, []);

  function startGesture(event: ReactPointerEvent<SVGSVGElement>) {
    if (!enabled || blocked || readOnly || gestureRef.current || event.button !== 0 || viewport.width <= 0) return;
    activeRef.current = true;
    endEditGroup();
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const point = pointAt(event, bounds);
    const target = event.target as Element;
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') as DrawingHandle | null;
    const hitId = target.closest('[data-drawing-id]')?.getAttribute('data-drawing-id');
    const existing = presentRef.current.find((drawing) => drawing.id === (handle ? selectedId : hitId) && drawingFrame(drawing, resolvedFallback) === currentFrame);
    if (tool === 'select' && existing?.kind === 'text' && !handle) {
      const previous = lastTextTap.current, now = performance.now();
      lastTextTap.current = { id: existing.id, time: now, x: event.clientX, y: event.clientY };
      // Captured pointer gestures can suppress the browser's compatibility dblclick.
      if (previous?.id === existing.id && now - previous.time < 450 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 8) {
        event.preventDefault(); lastTextTap.current = null;
        setSelectedId(existing.id); setTextDraft(existing.text ?? '');
        setPopover({ anchor: new DOMRect(event.clientX, event.clientY, 0, 0), textId: existing.id });
        return;
      }
    } else lastTextTap.current = null;
    if (tool === 'text') {
      event.preventDefault();
      if (presentRef.current.length >= SHAPE_LIMIT) { setNotice('한 요청의 그림은 30개까지입니다.'); return; }
      setSelectedId(null); setTextDraft('');
      setPopover({ anchor: new DOMRect(event.clientX, event.clientY, 0, 0), textPoint: point });
      return;
    }
    if (tool === 'select' && !existing) {
      if (selectedId) setSelectedId(null);
      else onBackgroundClick();
      return;
    }
    if (tool !== 'select' && presentRef.current.length >= SHAPE_LIMIT) { setNotice('한 요청의 그림은 30개까지입니다. 새 요청으로 이어서 그려주세요.'); return; }
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    let drawing: Drawing, kind: Gesture['kind'];
    if (tool !== 'select') {
      drawing = { ...createDrawing(tool, point, point, defaults, crypto.randomUUID()), frame: currentFrame };
      if (tool === 'pen') drawing.points = [point];
      kind = 'create';
    } else { drawing = existing!; kind = handle ? 'resize' : 'move'; }
    setSelectedId(drawing.id);
    gestureRef.current = { kind, pointerId: event.pointerId, frame: currentFrame, original: drawing, bounds, draft: createOverlayGesture({ kind, original: drawing, start: point, width: bounds.width, height: bounds.height, ...(handle ? { handle } : {}) }) };
    setPreview(drawing);
    setPreviewOffset(kind === 'move' ? { x: 0, y: 0 } : null);
  }

  function updateGesture(event: ReactPointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (gesture.frame !== latestRef.current.currentFrame || !latestRef.current.enabled || latestRef.current.blocked || latestRef.current.readOnly) { cancelGesture(); return; }
    const point = pointAt(event, gesture.bounds);
    if (gesture.kind === 'create' && gesture.original.kind === 'pen') {
      const coalesced = event.nativeEvent.getCoalescedEvents?.() || [];
      gesture.draft.update(point, coalesced.map(sample => pointAt(sample, gesture.bounds)));
    } else gesture.draft.update(point);
    schedulePreview();
  }

  function finishGesture(event: ReactPointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.frame !== latestRef.current.currentFrame || !latestRef.current.enabled || latestRef.current.blocked || latestRef.current.readOnly) { cancelGesture(); return; }
    updateGesture(event);
    const drawing = gesture.draft.finish();
    if (gesture.kind === 'move' && drawing.kind === 'text') {
      const before = drawingBounds(gesture.original), after = drawingBounds(drawing);
      if (Math.hypot((after.x - before.x) * gesture.bounds.width, (after.y - before.y) * gesture.bounds.height) > 3) lastTextTap.current = null;
    }
    if (gesture.kind === 'move' || isDrawableSize(drawing, gesture.bounds.width, gesture.bounds.height)) {
      const next = gesture.kind === 'create' ? [...presentRef.current, drawing] : presentRef.current.map((item) => item.id === drawing.id && drawingFrame(item, latestRef.current.fallbackFrame) === gesture.frame ? drawing : item);
      if (gesture.kind === 'create') latestRef.current.onCreate?.(gesture.frame);
      commit(next);
      if (gesture.kind === 'create') {
        if (drawing.kind === 'pen') setSelectedId(null);
        else setTool('select');
      }
    } else if (gesture.kind === 'create') setSelectedId(null);
    cancelGesture();
  }

  function applyStyle(patch: Partial<EditorStyle>) {
    const nextDefaults = { ...defaults, ...patch };
    setDefaults(nextDefaults);
    if (!selected) return;
    const { fontSize, ...drawingPatch } = patch;
    const next = presentRef.current.map((drawing) => {
      if (drawing.id !== selected.id || drawingFrame(drawing, resolvedFallback) !== currentFrame) return drawing;
      const styled = normalizeDrawing({ ...drawing, ...drawingPatch });
      return fontSize !== undefined && styled.kind === 'text' ? scaleTextDrawing(styled, fontSize, logicalHeight) : styled;
    });
    if (editGroupRef.current?.kind === 'style') {
      const session = historySessionRef.current;
      if (session?.updateGroup(next)) emit(session.present);
    } else commit(next);
  }

  function beginStyleSession() {
    activeRef.current = true;
    if (editGroupRef.current?.kind !== 'style') { endEditGroup(); historySessionRef.current?.beginGroup(); editGroupRef.current = { kind: 'style' }; }
  }

  function submitText() {
    if (!popover || !textDraft.trim() || textDraft.length > MAX_DRAWING_TEXT || drawingTextLines(textDraft).length > MAX_DRAWING_TEXT_LINES || blocked || readOnly || !enabled) return;
    const existing = popover.textId ? presentRef.current.find(item => item.id === popover.textId && drawingFrame(item, resolvedFallback) === currentFrame) : undefined;
    if (!existing && !popover.textPoint || !existing && presentRef.current.length >= SHAPE_LIMIT) return;
    const point = existing ? drawingBounds(existing) : popover.textPoint!;
    const drawing = createTextDrawing({ id: existing?.id ?? crypto.randomUUID(), text: textDraft, point, style,
      fontSize: style.fontSize, logicalHeight, frame: currentFrame });
    if (!existing) onCreate?.(currentFrame);
    commit(existing ? presentRef.current.map(item => item.id === existing.id ? drawing : item) : [...presentRef.current, drawing]);
    setSelectedId(drawing.id); setTool('select'); closePopover(true);
  }

  function editTextAt(event: React.MouseEvent<SVGSVGElement>) {
    if (blocked || readOnly || !enabled || tool !== 'select') return;
    // Pointer capture retargets click/double-click to the SVG root; hit-test the released pointer.
    const target = document.elementFromPoint(event.clientX, event.clientY) ?? event.target as Element;
    const id = target.closest('[data-drawing-id]')?.getAttribute('data-drawing-id');
    const drawing = visibleDrawings.find(item => item.id === id && item.kind === 'text');
    if (!drawing) return;
    event.preventDefault(); event.stopPropagation(); cancelGesture();
    setSelectedId(drawing.id); setTextDraft(drawing.text ?? '');
    setPopover({ anchor: new DOMRect(event.clientX, event.clientY, 0, 0), textId: drawing.id });
  }

  const history = historySessionRef.current;
  const multipleFrames = frameGroups.length > 1;
  const sceneNavigation = <div className="oe-frame-context" data-overlay-owner={ownerId}>
    <div className="oe-frame-summary"><span>현재 {frameTime(currentFrame)} · 그림 {visibleDrawings.length}개</span><span>다른 프레임 {drawings.length - visibleDrawings.length}개 · 전체 {drawings.length}/{SHAPE_LIMIT}</span></div>
    {frameGroups.length > 0 ? <div className="oe-frame-scenes" role="group" aria-label="그림을 남긴 장면">{frameGroups.map(group => <button key={group.frame} className={group.frame === currentFrame ? 'oe-frame-scene active' : 'oe-frame-scene'} disabled={blocked || !onFrameSelect} aria-pressed={group.frame === currentFrame} aria-label={`${frameTime(group.frame)}, ${group.drawings.length}개 그림 장면으로 이동`} title={`${group.frame} 프레임 · 그림 ${group.drawings.length}개`} onClick={() => onFrameSelect?.(group.frame)}><span>{frameTime(group.frame)}</span><small>{group.drawings.length}</small></button>)}</div> : null}
    {historyFrameHint !== null && historyFrameHint !== currentFrame && onFrameSelect ? <button className="oe-history-frame-link" disabled={blocked} onClick={() => onFrameSelect(historyFrameHint)}>변경 장면 {frameTime(historyFrameHint)} 보기</button> : null}
  </div>;
  const canvasStyle: CSSProperties = { left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height, display: !enabled ? 'none' : undefined, pointerEvents: readOnly || blocked ? 'none' : undefined };
  const tools = <div className="oe-toolbar-main" data-overlay-owner={ownerId} data-history-revision={historyRevision}>
      <div className="oe-tool-group" role="group" aria-label="영상 위 그림 도구">{TOOL_OPTIONS.map(({ id, label, shortcut, icon: Icon }) => <button key={id} className={`oe-tool${tool === id ? ' oe-tool-active' : ''}`} disabled={blocked} onClick={event => {
        popoverTrigger.current = event.currentTarget;
        if (tool !== id) { chooseTool(id); return; }
        onPause(); onToolSelect?.(); endEditGroup(); cancelGesture();
        setTextDraft(selected?.kind === 'text' ? selected.text ?? '' : '');
        const anchor = event.currentTarget.getBoundingClientRect();
        setPopover(current => current ? null : { anchor, ...(selected?.kind === 'text' ? { textId: selected.id } : {}) });
      }} aria-haspopup="dialog" aria-expanded={tool === id && Boolean(popover)} aria-controls={tool === id && popover ? `${ownerId}-style` : undefined} aria-label={`${label} 도구`} aria-pressed={tool === id} title={`${label} (${shortcut}) · 한 번 더 눌러 스타일`}><Icon size={16} /><span>{label}</span></button>)}</div>
      <div className="oe-history-actions"><button disabled={blocked || !enabled || !history?.canUndo} onClick={undo} aria-label="그림 편집 되돌리기" title="전체 그림 기록 되돌리기 (⌘/Ctrl Z)"><CornerUpLeft size={16} /></button><button disabled={blocked || !enabled || !history?.canRedo} onClick={redo} aria-label="그림 편집 다시 실행" title="전체 그림 기록 다시 실행 (⌘/Ctrl Shift Z)"><CornerUpRight size={16} /></button><span className="oe-toolbar-divider" /><button disabled={blocked || !enabled || !selected} onClick={deleteSelected} aria-label="선택한 그림 삭제" title="선택 삭제 (Delete)"><Trash2 size={15} /></button><button disabled={blocked || !enabled || !visibleDrawings.length} onClick={clearCurrentFrame} aria-label="현재 프레임 그림 지우기" title="현재 프레임 그림만 지우기"><Eraser size={16} /></button></div>
      {onInsertDrawings ? <button className="oe-insert-button" disabled={blocked || !enabled || !drawings.length || multipleFrames} onClick={() => { endEditGroup(); if (!multipleFrames) onInsertDrawings(); }} title={multipleFrames ? '원하는 장면만 복사한 요청에서 영상에 넣어 주세요.' : '이 그림으로 영상 삽입 요청을 만듭니다. 승인 후 렌더에 적용됩니다.'}><Plus size={14} />영상에 넣기</button> : null}
    </div>;
  const stylePanel = popover && !readOnly ? <div ref={popoverRef} id={`${ownerId}-style`} className="oe-toolbar oe-style-popover" data-overlay-owner={ownerId} role="dialog" aria-label={editingText ? '텍스트 입력' : '그림 스타일'} tabIndex={-1}
    style={{ left: popoverPosition.left, top: popoverPosition.top }} onKeyDownCapture={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePopover(true); }
      else if (editingText && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); submitText(); }
    }}>
    <header><strong>{editingText ? popover.textId ? '텍스트 수정' : '텍스트 넣기' : `${TOOL_OPTIONS.find(item => item.id === tool)?.label ?? '그림'} 스타일`}</strong><button type="button" aria-label="스타일 팝업 닫기" onClick={() => closePopover(true)}><X size={14}/></button></header>
    {editingText ? <label className="oe-text-entry">내용<textarea ref={textInputRef} aria-label="영상 위 텍스트 내용" value={textDraft} maxLength={MAX_DRAWING_TEXT} rows={3} placeholder="영상 위에 남길 텍스트" onChange={event => setTextDraft(event.target.value)}/><small>{drawingTextLines(textDraft).length > MAX_DRAWING_TEXT_LINES ? '최대 8줄까지 입력할 수 있습니다.' : '최대 500자 · 8줄 · ⌘ / Ctrl + Enter 적용'}</small></label> : null}
    <div className="oe-style-controls" aria-label="그림 스타일">
      <span className="oe-style-target">{editingText ? popover?.textId ? '텍스트 수정' : '새 텍스트' : selected ? '선택한 그림' : '새 그림'}</span>
      <div className="oe-color-swatches" role="group" aria-label={textStyle ? '글자 색상' : '선 색상'}>{COLORS.map((color) => <button key={color} className={style.color.toLowerCase() === color ? 'oe-swatch oe-swatch-active' : 'oe-swatch'} style={{ '--oe-swatch': color } as CSSProperties} disabled={blocked || !enabled} onClick={() => applyStyle({ color })} aria-label={`${textStyle ? '글자' : '선'} 색상 ${color}`} aria-pressed={style.color.toLowerCase() === color} />)}<input type="color" aria-label={textStyle ? '사용자 글자 색상' : '사용자 선 색상'} title="사용자 색상" value={/^#[\da-f]{6}$/i.test(style.color) ? style.color : '#bcf7de'} disabled={blocked || !enabled} onPointerDown={beginStyleSession} onChange={(event) => applyStyle({ color: event.target.value })} onBlur={endEditGroup} /></div>
      {textStyle ? <label className="oe-range-style"><span>글자 크기</span><input type="range" aria-label="글자 크기, 폭 1000 기준" min="8" max="160" step="1" value={Math.max(8, Math.min(160, Math.round(style.fontSize)))} disabled={blocked || !enabled} onPointerDown={beginStyleSession} onPointerUp={endEditGroup} onBlur={endEditGroup} onChange={event => applyStyle({ fontSize: Number(event.target.value) })}/><output>{Math.round(style.fontSize)}</output></label> : <label className="oe-range-style"><span>선</span><input type="range" aria-label="선 굵기, 폭 1000 기준" min="0.25" max="64" step="0.25" value={style.strokeWidth ?? 3} disabled={blocked || !enabled} onPointerDown={beginStyleSession} onPointerUp={endEditGroup} onBlur={endEditGroup} onChange={(event) => applyStyle({ strokeWidth: Number(event.target.value) })} /><output>{style.strokeWidth ?? 3}</output></label>}
      <label className="oe-range-style oe-opacity-control"><span>불투명도</span><input type="range" aria-label="그림 불투명도" min="0" max="100" step="5" value={Math.round((style.opacity ?? 1) * 100)} disabled={blocked || !enabled} onPointerDown={beginStyleSession} onPointerUp={endEditGroup} onBlur={endEditGroup} onChange={(event) => applyStyle({ opacity: Number(event.target.value) / 100 })} /><output>{Math.round((style.opacity ?? 1) * 100)}%</output></label>
      {closedShape && !textStyle ? <label className="oe-fill-control"><input type="checkbox" aria-label="채움" checked={style.fill !== 'none' && Boolean(style.fill)} disabled={blocked || !enabled || !closedShape} onChange={(event) => applyStyle({ fill: event.target.checked ? style.color : 'none' })} /><span>채움</span>{style.fill && style.fill !== 'none' ? <input type="color" aria-label="채움 색상" value={/^#[\da-f]{6}$/i.test(style.fill) ? style.fill : '#bcf7de'} disabled={blocked || !enabled || !closedShape} onPointerDown={beginStyleSession} onChange={(event) => applyStyle({ fill: event.target.value })} onBlur={endEditGroup} /> : null}</label> : null}
      <button className="oe-style-reset" onClick={() => applyStyle({ ...DEFAULT_STYLE, fontSize: 32 })} disabled={blocked || !enabled} aria-label="그림 스타일 초기화" title="스타일 초기화"><RotateCcw size={13} /></button>
    </div>

    {editingText ? <button type="button" className="oe-text-apply" disabled={!textDraft.trim() || drawingTextLines(textDraft).length > MAX_DRAWING_TEXT_LINES || blocked || !enabled} onClick={submitText}>{popover.textId ? '텍스트 적용' : '텍스트 넣기'}</button> : null}
  </div> : null;
  const toolbar = <div className={`oe-toolbar${blocked ? ' oe-toolbar-blocked' : ''}`} data-overlay-owner={ownerId} data-history-revision={historyRevision}>
    {!toolsHost ? tools : null}
    {onInsertDrawings && multipleFrames ? <p className="oe-insert-frame-warning">여러 장면의 그림입니다. 선택한 장면만 복사한 새 요청에서 영상에 넣어 주세요.</p> : null}
    {frameGroups.length > 0 || historyFrameHint !== null ? sceneNavigation : null}
    <div className="oe-editor-status"><span>{blocked ? blockedLabel : !enabled ? '재생 중 · 위치 메모 숨김' : selected ? '드래그로 이동 · 핸들로 크기 조절 · 방향키로 1px 이동 · 길게 누른 이동은 한 번에 되돌리기' : onInsertDrawings ? '위치 메모 · 영상에 넣으려면 삽입 요청 후 승인' : '표시한 위치·그림은 피드백에 함께 저장됩니다.'}</span><span>{notice || (tool === 'pen' ? '펜 연속 그리기 · 도구를 다시 눌러 스타일' : tool === 'text' ? '영상을 클릭해 텍스트 입력 · T' : '도구를 다시 눌러 스타일 · Esc 선택 해제')}</span></div>
  </div>;

  return <>
    <svg ref={svgRef} className={`oe-canvas${readOnly ? ' oe-canvas-readonly' : ''}${blocked ? ' oe-canvas-blocked' : ''}${tool !== 'select' ? ' oe-canvas-drawing' : ''}${tool === 'select' && !visibleDrawings.length ? ' oe-canvas-empty' : ''}`} style={canvasStyle} viewBox={`0 0 1000 ${logicalHeight}`} preserveAspectRatio="none" data-overlay-owner={ownerId} data-tool={tool} tabIndex={readOnly || blocked ? -1 : 0} aria-label={readOnly ? '저장된 요청의 그림' : '영상 위 그림 편집 영역'} role="group"
      onDoubleClick={editTextAt} onPointerDown={startGesture} onPointerMove={updateGesture} onPointerUp={finishGesture} onPointerCancel={cancelPointerGesture} onLostPointerCapture={cancelPointerGesture}>
      <defs><clipPath id={`${ownerId}-clip`} clipPathUnits="userSpaceOnUse"><rect width="1000" height={logicalHeight} /></clipPath></defs>
      <g clipPath={`url(#${ownerId}-clip)`}><CommittedShapes drawings={visibleDrawings} hiddenId={hiddenId} logicalHeight={logicalHeight} displayScale={displayScale} />
        {visiblePreview ? <g transform={previewTransform}><Shape drawing={movingOriginal ?? visiblePreview} logicalHeight={logicalHeight} displayScale={displayScale} /></g> : null}
      </g>
      {!readOnly && !blocked && selection && tool === 'select' ? <g transform={previewTransform}><SelectionHandles drawing={selection} logicalHeight={logicalHeight} viewport={viewport} /></g> : null}
    </svg>
    {stylePanel && typeof document !== 'undefined' ? createPortal(stylePanel, document.fullscreenElement ?? document.body) : null}
    {!readOnly && toolsHost ? createPortal(tools, toolsHost) : null}
    {toolbarHost ? createPortal(readOnly ? <div className="oe-readonly-context">{sceneNavigation}<div className="oe-editor-status"><span>저장된 위치 표시 · 각 그림의 작성 프레임에서 표시</span><span>그림을 바꾸려면 새 요청으로 복사하세요.</span></div></div> : toolbar, toolbarHost) : null}
  </>;
});
