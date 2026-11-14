import { useCallback, useEffect, useImperativeHandle, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, Ref } from 'react';
import { Bookmark, ChevronDown, ChevronUp, Hand, Maximize, Minimize, Minus, MessageSquarePlus, Pause, Pencil, Play, Plus, Repeat2, SkipBack, SkipForward, Volume2, VolumeX, X } from 'lucide-react';
import type { Asset, Attachment, Comment, Drawing, ReviewMarker, Version } from '../../../../packages/core/types';
import { adjacentMarkerFrame, markerAt, markerLoopRange } from '../../../../packages/core/review-markers.mjs';
import { mapFrameBetweenVersions, projectComment } from '../../../../packages/core/comment-projection.mjs';
import { createRangePlaybackController } from '../../../../packages/core/range-playback.mjs';
import type { PlaybackCommand } from '../../../../packages/core/range-playback.mjs';
import { createTimelineRangeGesture, markTimelineRange } from '../../../../packages/core/timeline-range.mjs';
import type { TimelineRangeGesture } from '../../../../packages/core/timeline-range.mjs';
import { OverlayEditor } from './OverlayEditor';
import { ImagePlacementOverlay } from './ImagePlacementOverlay';
import type { ImageOverlayPreview } from './ImagePlacementOverlay';
import { TimelineFilmstrip } from './TimelineFilmstrip';
import { TimelineMarkers, TimelineReviewMarkers, TimelineSavedRanges, type FeedbackMarker } from './TimelineMarkers';
import { TimelineSelection } from './TimelineSelection';
import { TimelineDetails } from './TimelineDetails';
import { TimelineSeekSurface } from './TimelineSeekSurface';
import { VerticalWorkspaceLayout } from './VerticalWorkspaceLayout';
import { usePreviewViewport } from './usePreviewViewport';
import { TimecodeSeek, type TimecodeSeekHandle } from './TimecodeSeek';
import { feedbackCategory } from '../../../../packages/core/feedback-category.mjs';
import { time as timecode } from '../format';
import './VideoWorkspace.css';
import './DirectingLayout.css';

const FPS = 30;
const EMPTY_ATTACHMENTS: Attachment[] = [];
const EMPTY_MARKERS: ReviewMarker[] = [];
const SIMPLE_TIMELINE_KEY = 'interference.timeline-simple.v1';
const COMPACT_TIMELINE_KEY = 'interference.timeline-compact.v1';
const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
function readCompactTimeline() {
  try { return typeof window !== 'undefined' && window.localStorage.getItem(COMPACT_TIMELINE_KEY) === 'true'; }
  catch { return false; }
}
function readSimpleTimeline() {
  try { return typeof window !== 'undefined' && window.localStorage.getItem(SIMPLE_TIMELINE_KEY) === 'true'; }
  catch { return false; }
}
type Range = { in: number; out: number };
type Drag = 'in' | 'out';
type TimelineDrag = { pointerId: number; target: HTMLElement; gesture: TimelineRangeGesture };
type VideoRect = { left: number; top: number; width: number; height: number };

export interface VideoWorkspaceHandle { pauseAndReadFrame: () => number }

export interface VideoWorkspaceProps {
  version: Version;
  versions: Version[];
  asset: Asset;
  comments: Comment[];
  attachments?: Attachment[];
  selectedCommentId: string | null;
  selectedRangeIndex?: number;
  currentFrame: number;
  focusFrameToken?: number;
  playbackRef?: Ref<VideoWorkspaceHandle>;
  onFrameChange: (frame: number) => void;
  range: Range;
  rangeAvailable?: boolean;
  rangeActive?: boolean;
  onRangeClear?: () => void;
  onRangeStart?: () => void;
  canCompose?: boolean;
  composeLabel?: string;
  onRangeChange: (range: Range) => void;
  drawings: Drawing[];
  onDrawingsChange: (drawings: Drawing[]) => void;
  onCompose: () => void;
  compareVersion?: Version | null;
  onInsertDrawings?: () => void;
  onDrawingCreate?: (frame: number) => void;
  imageOverlay?: ImageOverlayPreview | null;
  annotationsReadOnly?: boolean;
  editingLocked?: boolean;
  editingLockLabel?: string;
  annotationFrame?: number;
  drawingHistoryKey?: string;
  onDrawingHistoryChange?: (available: boolean) => void;
  onSelectComment?: (comment: Comment, rangeIndex?: number, focusFrame?: number) => void;
  reviewMarkers?: ReviewMarker[];
  onToggleMarker?: (frame: number) => void;
  /** Returns false when the app cannot take the range, so the loop stays off. */
  onLoopMarkers?: (range: Range) => boolean;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function VideoWorkspace({ version, versions, asset, comments, attachments = EMPTY_ATTACHMENTS, reviewMarkers = EMPTY_MARKERS, onToggleMarker, onLoopMarkers, selectedCommentId, selectedRangeIndex = 0, currentFrame, focusFrameToken, playbackRef, onFrameChange, range, rangeAvailable = true, rangeActive = true, onRangeClear, onRangeStart, canCompose = true, composeLabel = '선택 구간에 피드백', onRangeChange, drawings, onDrawingsChange, onCompose, compareVersion, onInsertDrawings, onDrawingCreate, imageOverlay, annotationsReadOnly = false, editingLocked = false, editingLockLabel, annotationFrame, drawingHistoryKey, onDrawingHistoryChange, onSelectComment }: VideoWorkspaceProps) {
  const [compactTimeline, setCompactTimeline] = useState(readCompactTimeline);
  const [simpleTimeline, setSimpleTimeline] = useState(readSimpleTimeline);
  const [compactToolsOpen, setCompactToolsOpen] = useState(false);
  const timelineContentId = useId();
  const drawingToolsId = useId();
  const toolsToggleRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const timecodeRef = useRef<TimecodeSeekHandle>(null);
  const compareRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const lastEmittedFrame = useRef<number | null>(null);
  const currentFrameRef = useRef(currentFrame);
  const pointerDragRef = useRef<TimelineDrag | null>(null);
  const rangeAnimationRef = useRef<number | null>(null);
  const rangeChangeRef = useRef(onRangeChange);
  rangeChangeRef.current = onRangeChange;
  const [playing, setPlaying] = useState(false);
  const [loopRange, setLoopRange] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [playback] = useState(createRangePlaybackController);
  const playAttempt = useRef(0);
  const playbackCallbacks = useRef({ onFrameChange });
  playbackCallbacks.current = { onFrameChange };
  const [playbackRate, setPlaybackRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [overlayToolbarHost, setOverlayToolbarHost] = useState<HTMLDivElement | null>(null);
  const [overlayToolsHost, setOverlayToolsHost] = useState<HTMLDivElement | null>(null);
  const [videoRect, setVideoRect] = useState<VideoRect>({ left: 0, top: 0, width: 0, height: 0 });
  const [mediaError, setMediaError] = useState(false);
  const [playError, setPlayError] = useState('');
  const durationFrames = Math.max(1, version.durationFrames);
  const frame = clamp(currentFrame, 0, durationFrames - 1);
  const safeIn = clamp(range.in, 0, durationFrames - 1);
  const safeOut = clamp(range.out, safeIn + 1, durationFrames);
  const hasActiveRange = rangeAvailable && rangeActive;
  useEffect(() => {
    if (!compactTimeline || !compactToolsOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.oe-style-popover')) return;
      if (event.target instanceof Node && !overlayToolbarHost?.contains(event.target) && !toolsToggleRef.current?.contains(event.target)) setCompactToolsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      if (!(event.target instanceof Node) || (!overlayToolbarHost?.contains(event.target) && !toolsToggleRef.current?.contains(event.target))) return;
      event.preventDefault(); event.stopPropagation();
      setCompactToolsOpen(false); toolsToggleRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape, true); };
  }, [compactTimeline, compactToolsOpen, overlayToolbarHost]);
  const visibleComments = useMemo(() => {
    const authoredVersions = new Map(versions.map(item => [item.id, item]));
    return comments.map((comment, index) => ({ comment, index, projection: projectComment(comment, authoredVersions.get(comment.versionId), version) })).filter(item => item.projection.ranges.length > 0);
  }, [comments, versions, version]);
  const markers = useMemo(() => visibleComments.flatMap(({ comment, index, projection }) => projection.ranges.map((mapped, rangeIndex) => ({
    key: `${comment.id}-${rangeIndex}`, comment, number: index + 1, frame: mapped.frameIn, frameOut: mapped.frameOut, rangeIndex, rangeCount: projection.ranges.length,
  }))), [visibleComments]);
  const selectedCategory = useMemo(() => feedbackCategory(markers.find(marker => marker.comment.id === selectedCommentId)?.comment), [markers, selectedCommentId]);
  const comparisonFrame = compareVersion ? mapFrameBetweenVersions(version, compareVersion, frame) : null;
  currentFrameRef.current = frame;

  const mediaState = useCallback(() => {
    const video = videoRef.current;
    return { currentTime: video?.currentTime ?? 0, readyState: video?.readyState ?? 0, paused: video?.paused ?? true, ended: video?.ended ?? false, seeking: video?.seeking ?? false, error: Boolean(video?.error) };
  }, []);

  const publishFrame = useCallback((next: number) => {
    if (lastEmittedFrame.current === next) return;
    lastEmittedFrame.current = next; currentFrameRef.current = next;
    playbackCallbacks.current.onFrameChange(next);
  }, []);

  const applyPlayback = useCallback((command: PlaybackCommand | null) => {
    const video = videoRef.current;
    if (!video || !command) return;
    if (command.pause) { playAttempt.current++; video.pause(); setPlaying(false); }
    if (command.seekFrame !== undefined && video.readyState >= 1) {
      video.currentTime = command.seekFrame / FPS;
      publishFrame(command.seekFrame);
    }
    if (command.play) {
      const attempt = ++playAttempt.current;
      setPlayError('');
      void video.play().catch(() => {
        if (attempt !== playAttempt.current || !playback.playingRequested) return;
        playback.requestPause(); video.pause(); setPlaying(false);
        setPlayError('영상을 재생하지 못했습니다. 영상 파일을 확인한 뒤 다시 재생해 주세요.');
      });
    }
  }, [playback, publishFrame]);

  const samplePlayback = useCallback((publish = false) => {
    const state = mediaState();
    const command = playback.observeFrame(state);
    applyPlayback(command);
    // Frame callbacks watch loop boundaries only. App state follows timeupdate and explicit seeks.
    if (publish && command?.seekFrame === undefined && state.readyState >= 1 && !state.seeking) publishFrame(playback.frameAt(state.currentTime));
  }, [applyPlayback, mediaState, playback, publishFrame]);

  const pauseVideo = useCallback(() => applyPlayback(playback.requestPause()), [applyPlayback, playback]);
  const preview = usePreviewViewport(surfaceRef, videoRect, version.id, pauseVideo);
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === workspaceRef.current) await document.exitFullscreen();
      else await workspaceRef.current?.requestFullscreen();
    } catch { setPlayError('전체 화면을 열지 못했습니다. 전체 화면 버튼으로 다시 시도하세요.'); }
  }, []);
  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === workspaceRef.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  const composeFromViewer = useCallback(async () => {
    if (document.fullscreenElement === workspaceRef.current) {
      try { await document.exitFullscreen(); } catch { return; }
    }
    onCompose();
  }, [onCompose]);
  const changePlaybackRate = useCallback((rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, []);
  const stepPlaybackRate = useCallback((direction: number) => {
    const current = videoRef.current?.playbackRate ?? 1;
    const next = direction > 0 ? PLAYBACK_RATES.find(rate => rate > current) ?? 4 : PLAYBACK_RATES.filter(rate => rate < current).at(-1) ?? 0.25;
    changePlaybackRate(next);
  }, [changePlaybackRate]);

  const pauseAndReadFrame = useCallback(() => {
    pauseVideo();
    const video = videoRef.current;
    const next = video && video.readyState >= 1 && Number.isFinite(video.currentTime)
      ? playback.frameAt(video.currentTime) : currentFrameRef.current;
    publishFrame(next);
    return next;
  }, [pauseVideo, playback, publishFrame]);
  useImperativeHandle(playbackRef, () => ({ pauseAndReadFrame }), [pauseAndReadFrame]);

  useLayoutEffect(() => {
    applyPlayback(playback.configure({ versionId: version.id, durationFrames, frameIn: safeIn, frameOut: safeOut, loop: loopRange, rangeAvailable: hasActiveRange, locked: editingLocked }));
    samplePlayback();
  }, [applyPlayback, playback, version.id, durationFrames, safeIn, safeOut, loopRange, hasActiveRange, editingLocked, samplePlayback]);

  useLayoutEffect(() => {
    setLoopRange(false); setMediaReady(false);
    pauseVideo(); lastEmittedFrame.current = null;
    setMediaError(false); setPlayError('');
  }, [version.id, version.mediaUrl, pauseVideo]);

  useLayoutEffect(() => {
    if (!hasActiveRange) setLoopRange(false);
    if (!hasActiveRange || annotationsReadOnly || editingLocked) cancelTimelineDrag();
  }, [hasActiveRange, annotationsReadOnly, editingLocked]);
  useLayoutEffect(() => { cancelTimelineDrag(); }, [version.id, durationFrames]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    let width = timeline.clientWidth;
    const observer = new ResizeObserver(entries => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next !== width) { width = next; cancelTimelineDrag(); }
    });
    observer.observe(timeline);
    const cancel = () => cancelTimelineDrag();
    const scroll = (event: Event) => {
      if (event.target === window || event.target instanceof Node && event.target.contains(timeline)) cancel();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !pointerDragRef.current) return;
      event.preventDefault(); event.stopPropagation(); cancel();
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      observer.disconnect(); cancel();
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [version.id]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing) return;
    let disposed = false, handle: number | null = null;
    const nativeFrames = typeof video.requestVideoFrameCallback === 'function';
    // App state follows timeupdate (~4/s); the playhead alone follows every presented frame without a React render.
    const tick = () => {
      handle = null;
      if (disposed || !playback.playingRequested || video.paused) return;
      samplePlayback();
      if (playheadRef.current) playheadRef.current.style.left = `${playback.frameAt(video.currentTime) / durationFrames * 100}%`;
      schedule();
    };
    const schedule = () => {
      if (disposed || !playback.playingRequested || video.paused) return;
      handle = nativeFrames ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    schedule();
    return () => {
      disposed = true;
      if (handle !== null) { if (nativeFrames) video.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle); }
    };
  }, [playing, version.id, version.mediaUrl, playback, samplePlayback, durationFrames]);

  useEffect(() => () => { playAttempt.current++; playback.requestPause(); }, [playback]);

  const measureVideo = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const video = videoRef.current;
    const ratio = (video?.videoWidth || asset.width) / (video?.videoHeight || asset.height);
    const surfaceWidth = surface.clientWidth;
    const surfaceHeight = surface.clientHeight;
    const width = Math.min(surfaceWidth, surfaceHeight * ratio);
    const height = width / ratio;
    const left = (surfaceWidth - width) / 2;
    const top = (surfaceHeight - height) / 2;
    setVideoRect(previous => previous.left === left && previous.top === top && previous.width === width && previous.height === height
      ? previous : { left, top, width, height });
  }, [asset.width, asset.height]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const observer = new ResizeObserver(measureVideo);
    observer.observe(surface);
    measureVideo();
    return () => observer.disconnect();
  }, [measureVideo, compareVersion?.id]);

  useLayoutEffect(() => {
    const video = videoRef.current;
    if (video && video.readyState >= 1 && lastEmittedFrame.current !== frame) {
      pauseVideo();
      video.currentTime = frame / FPS;
    }
  }, [frame, pauseVideo]);

  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    pauseVideo();
    lastEmittedFrame.current = null;
    if (video.readyState >= 1) video.currentTime = currentFrameRef.current / FPS;
  }, [focusFrameToken, pauseVideo]);

  useEffect(() => {
    const video = compareRef.current;
    if (video && video.readyState >= 1 && comparisonFrame !== null) video.currentTime = comparisonFrame / FPS;
  }, [comparisonFrame, compareVersion?.id]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playback.playingRequested || !video.paused) pauseVideo();
    else applyPlayback(playback.requestPlay(mediaState()));
  }, [applyPlayback, mediaState, pauseVideo, playback]);

  const seekFrame = useCallback((nextFrame: number) => {
    if (editingLocked) return;
    const next = clamp(Math.round(nextFrame), 0, durationFrames - 1);
    pauseVideo();
    lastEmittedFrame.current = next;
    currentFrameRef.current = next;
    if (videoRef.current && videoRef.current.readyState >= 1) videoRef.current.currentTime = next / FPS;
    onFrameChange(next);
  }, [durationFrames, onFrameChange, pauseVideo, editingLocked]);
  const markerActionsRef = useRef({ editingLocked, onSelectComment, seekFrame, onToggleMarker });
  markerActionsRef.current = { editingLocked, onSelectComment, seekFrame, onToggleMarker };
  const selectMarker = useCallback((marker: FeedbackMarker) => {
    const actions = markerActionsRef.current;
    if (actions.editingLocked) return;
    if (actions.onSelectComment) actions.onSelectComment(marker.comment, marker.rangeIndex);
    else actions.seekFrame(marker.frame);
  }, []);
  const seekTimeline = useCallback((next: number) => markerActionsRef.current.seekFrame(next), []);
  const removeMarker = useCallback((markerFrame: number) => { if (!markerActionsRef.current.editingLocked) markerActionsRef.current.onToggleMarker?.(markerFrame); }, []);
  const commentsById = useMemo(() => new Map(comments.map(comment => [comment.id, comment])), [comments]);
  const selectDetail = useCallback((commentId: string, rangeIndex?: number, focusFrame?: number) => {
    const actions = markerActionsRef.current;
    const comment = commentsById.get(commentId);
    if (actions.editingLocked || !comment || comment.deletedAt) return;
    if (actions.onSelectComment) actions.onSelectComment(comment, rangeIndex, focusFrame);
    else if (focusFrame !== undefined) actions.seekFrame(focusFrame);
  }, [commentsById]);

  const versionMarkers = useMemo(() => reviewMarkers.filter(marker => marker.versionId === version.id), [reviewMarkers, version.id]);
  const markerHere = Boolean(markerAt(versionMarkers, frame));
  const markerLoop = onLoopMarkers ? markerLoopRange(versionMarkers, frame, durationFrames) : null;
  const markerLoopActive = Boolean(markerLoop && loopRange && hasActiveRange && safeIn === markerLoop.in && safeOut === markerLoop.out);
  function toggleMarker() {
    if (editingLocked || !onToggleMarker) return;
    onToggleMarker(pauseAndReadFrame());
  }
  function seekMarker(direction: -1 | 1) {
    const next = adjacentMarkerFrame(versionMarkers, currentFrameRef.current, direction);
    if (next !== null) seekFrame(next);
  }
  function loopMarkers() {
    if (editingLocked || !onLoopMarkers) return;
    const next = markerLoopRange(versionMarkers, pauseAndReadFrame(), durationFrames);
    if (next && onLoopMarkers(next)) setLoopRange(true);
  }

  const markRange = useCallback((edge: 'in' | 'out') => {
    if (editingLocked || annotationsReadOnly) return;
    const next = markTimelineRange({ edge, frame: pauseAndReadFrame(), durationFrames, range: { in: safeIn, out: safeOut }, active: hasActiveRange });
    if (next) onRangeChange(next);
  }, [editingLocked, annotationsReadOnly, pauseAndReadFrame, durationFrames, safeIn, safeOut, hasActiveRange, onRangeChange]);
  const keyboardActions = { frame, seekFrame, togglePlayback, markRange, onCompose: composeFromViewer, editingLocked, annotationsReadOnly: annotationsReadOnly || editingLocked, durationFrames, stepPlaybackRate, toggleFullscreen, previewZoom: preview.zoom, previewReset: preview.reset, toggleHand: preview.toggleHand, timecodeRef, toggleMarker, seekMarker };
  const keyboardActionsRef = useRef(keyboardActions);
  keyboardActionsRef.current = keyboardActions;

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || element?.closest('input, textarea, select, audio, video, [contenteditable], dialog, [role="dialog"]') || event.metaKey || event.ctrlKey || event.altKey) return;
      if (element?.closest('button, summary') && (event.code === 'Space' || event.key === 'Enter')) return;
      if (event.repeat && !['ArrowLeft', 'ArrowRight', '+', '=', '-', 'j', 'l'].includes(event.key)) return;
      const actions = keyboardActionsRef.current;
      if (actions.editingLocked) return;
      const key = event.key.toLowerCase();
      if (event.code === 'Space' || key === 'k') { event.preventDefault(); actions.togglePlayback(); }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); actions.seekFrame(currentFrameRef.current + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? FPS : 1));
      } else if (key === 'j' || key === 'l') { event.preventDefault(); actions.seekFrame(currentFrameRef.current + (key === 'j' ? -5 : 5) * FPS); }
      else if (key === 'home' || key === 'end') { event.preventDefault(); actions.seekFrame(key === 'home' ? 0 : actions.durationFrames - 1); }
      else if (key === '[' || key === ']') { event.preventDefault(); actions.stepPlaybackRate(key === ']' ? 1 : -1); }
      else if (key === 'm') { event.preventDefault(); setMuted(value => !value); }
      else if (key === 'f') { event.preventDefault(); void actions.toggleFullscreen(); }
      else if (key === 'escape' && document.fullscreenElement === workspaceRef.current) { event.preventDefault(); void actions.toggleFullscreen(); }
      else if (key === 'g') { event.preventDefault(); actions.timecodeRef.current?.open(); }
      else if (key === '+' || key === '=' || key === '-') { event.preventDefault(); actions.previewZoom(key === '-' ? -1 : 1); }
      else if (key === '0') { event.preventDefault(); actions.previewReset(); }
      else if (key === 'h') { event.preventDefault(); actions.toggleHand(); }
      else if (key === 'b') { event.preventDefault(); actions.toggleMarker(); }
      else if (key === ',' || key === '.') { event.preventDefault(); actions.seekMarker(key === '.' ? 1 : -1); }
      else if (key === 'i' && !actions.annotationsReadOnly) {
        event.preventDefault(); actions.markRange('in');
      } else if (event.key.toLowerCase() === 'o' && !actions.annotationsReadOnly) {
        event.preventDefault(); actions.markRange('out');
      } else if (event.key.toLowerCase() === 'c') { event.preventDefault(); actions.onCompose(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  function dragTimeline(event: ReactPointerEvent<HTMLElement>, kind: Drag) {
    if (editingLocked || annotationsReadOnly || !hasActiveRange) { event.stopPropagation(); return; }
    if (event.button !== 0 || pointerDragRef.current) return;
    const width = timelineRef.current?.getBoundingClientRect().width;
    if (!width) return;
    event.preventDefault();
    event.stopPropagation();
    pauseVideo();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragRef.current = { pointerId: event.pointerId, target: event.currentTarget,
      gesture: createTimelineRangeGesture({ edge: kind, range: { in: safeIn, out: safeOut }, startX: event.clientX, width, durationFrames }) };
  }

  function updateTimeline(event: ReactPointerEvent<HTMLElement>) {
    const active = pointerDragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (editingLocked || !hasActiveRange || annotationsReadOnly) { cancelTimelineDrag(); return; }
    // IN/OUT gestures belong to the handles, never the surrounding seek surface.
    event.stopPropagation();
    event.preventDefault();
    if (!(event.buttons & 1)) { cancelTimelineDrag(); return; }
    active.gesture.update(event.clientX);
    if (rangeAnimationRef.current !== null) return;
    rangeAnimationRef.current = requestAnimationFrame(() => {
      rangeAnimationRef.current = null;
      const next = pointerDragRef.current?.gesture.flush();
      if (next) rangeChangeRef.current(next);
    });
  }

  function endTimelineDrag(event: ReactPointerEvent<HTMLElement>) {
    if (pointerDragRef.current?.pointerId !== event.pointerId) return;
    cancelTimelineDrag();
  }

  function cancelTimelineDrag() {
    if (rangeAnimationRef.current !== null) cancelAnimationFrame(rangeAnimationRef.current);
    rangeAnimationRef.current = null;
    const active = pointerDragRef.current;
    pointerDragRef.current = null;
    if (active?.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
  }

  function finishTimelineDrag(event: ReactPointerEvent<HTMLElement>) {
    const active = pointerDragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (!editingLocked && hasActiveRange && !annotationsReadOnly) {
      active.gesture.update(event.clientX);
      const next = active.gesture.flush();
      if (next) rangeChangeRef.current(next);
    }
    cancelTimelineDrag();
  }

  function rangeKey(event: ReactKeyboardEvent<HTMLButtonElement>, kind: 'in' | 'out') {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || editingLocked || annotationsReadOnly || !hasActiveRange) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); event.stopPropagation();
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? FPS : 1);
    if (kind === 'in') onRangeChange({ in: clamp(safeIn + delta, 0, safeOut - 1), out: safeOut });
    else onRangeChange({ in: safeIn, out: clamp(safeOut + delta, safeIn + 1, durationFrames) });
  }

  function startRange() {
    if (editingLocked || annotationsReadOnly) return;
    const current = pauseAndReadFrame();
    if (onRangeStart) onRangeStart();
    else {
      const next = markTimelineRange({ edge: 'in', frame: current, durationFrames, range, active: false });
      if (next) onRangeChange(next);
    }
  }

  function clearRange() {
    if (editingLocked) return;
    cancelTimelineDrag(); setLoopRange(false); pauseVideo(); onRangeClear?.();
  }

  function toggleCompactTimeline() {
    cancelTimelineDrag();
    const next = !compactTimeline;
    setCompactTimeline(next); setCompactToolsOpen(false);
    try { window.localStorage.setItem(COMPACT_TIMELINE_KEY, String(next)); } catch { /* Layout still works without storage. */ }
  }

  function changeTimelineMode(mode: string) {
    cancelTimelineDrag(); setCompactToolsOpen(false);
    setCompactTimeline(mode === 'compact'); setSimpleTimeline(mode === 'simple');
    try {
      window.localStorage.setItem(COMPACT_TIMELINE_KEY, String(mode === 'compact'));
      window.localStorage.setItem(SIMPLE_TIMELINE_KEY, String(mode === 'simple'));
    } catch { /* Display mode remains available without storage. */ }
  }

  const overlayStyle: CSSProperties = { left: preview.rect.left, top: preview.rect.top, width: preview.rect.width, height: preview.rect.height };

  return (
    <section ref={workspaceRef} className="vi-workspace" data-timeline-compact={compactTimeline} data-timeline-simple={simpleTimeline && !compactTimeline} aria-label="영상과 시간별 피드백 작업 공간"
>
      <VerticalWorkspaceLayout compact={compactTimeline} simple={simpleTimeline} viewer={<div className={`vi-viewer${compareVersion ? ' vi-viewer-comparing' : ''}`}>
        <div className={`vi-video-surface${preview.hand && preview.rect.zoom > 1 ? ' vi-hand-mode' : ''}${preview.panning ? ' vi-panning' : ''}`} ref={surfaceRef} {...preview.events}>
          <video ref={videoRef} style={overlayStyle} muted={muted} src={version.mediaUrl} poster={version.thumbnailUrl || asset.thumbnailUrl} preload="metadata" playsInline
            onLoadedMetadata={() => { const video = videoRef.current; if (video) { video.currentTime = currentFrameRef.current / FPS; video.playbackRate = playbackRate; } measureVideo(); }}
            onLoadedData={() => setMediaReady(true)} onCanPlay={() => setMediaReady(true)}
            onTimeUpdate={() => samplePlayback(true)} onSeeked={() => { playback.observeSeeked(); samplePlayback(true); }}
            onPlay={() => { if (!playback.playingRequested) pauseVideo(); else setPlaying(true); }}
            onPause={() => { const state = mediaState(); if (!state.paused) return; setPlaying(false); applyPlayback(playback.observePause(state)); }}
            onEnded={() => { if (!mediaState().ended) return; setPlaying(false); samplePlayback(true); }}
            onError={() => { pauseVideo(); setMediaReady(false); setMediaError(true); }} onClick={togglePlayback} aria-label={`v${version.number} 영상`} />
          <OverlayEditor drawings={drawings} currentFrame={frame} fallbackFrame={annotationFrame} onFrameSelect={seekFrame} onChange={onDrawingsChange} viewport={preview.rect} enabled={!playing && !imageOverlay} blocked={Boolean(imageOverlay) || editingLocked} blockedLabel={imageOverlay ? '이미지 배치 중' : editingLockLabel ?? '피드백 저장·녹음·첨부 중'} readOnly={annotationsReadOnly} onToolSelect={preview.leaveHand} onPause={pauseVideo} onBackgroundClick={togglePlayback} toolbarHost={overlayToolbarHost} toolsHost={compactTimeline ? null : overlayToolsHost} resetKey={drawingHistoryKey ?? `${version.id}:draft`} onHistoryChange={onDrawingHistoryChange} onInsertDrawings={onInsertDrawings} onCreate={onDrawingCreate} />
          {imageOverlay ? <div className="vi-image-placement-layer" style={overlayStyle}><ImagePlacementOverlay key={imageOverlay.id} preview={imageOverlay} onEditStart={pauseVideo} /></div> : null}
          {compareVersion ? <span className="vi-viewer-label">v{version.number} · 현재 버전</span> : null}
          {mediaError ? <div className="vi-media-error">영상을 불러오지 못했습니다.<span>영상 파일과 로컬 서버 연결을 확인하세요.</span></div> : null}
        </div>
        {compareVersion ? <div className="vi-compare-surface">
          <video ref={compareRef} src={compareVersion.mediaUrl} poster={compareVersion.thumbnailUrl || asset.thumbnailUrl} preload="metadata" muted playsInline aria-label={`비교 버전 v${compareVersion.number}`}
            onLoadedMetadata={() => { if (compareRef.current && comparisonFrame !== null) compareRef.current.currentTime = comparisonFrame / FPS; }} />
          <span className="vi-viewer-label">v{compareVersion.number} · {compareVersion.label}</span>
          {comparisonFrame === null ? <div className="vi-compare-gap">이 원본 구간은 비교 버전에 없습니다.</div> : null}
          <span className="vi-compare-note">원본 위치에 대응하는 프레임 참조</span>
        </div> : null}
        <div className="vi-view-tools" role="group" aria-label="영상 보기 도구" onPointerDown={event => event.stopPropagation()}>
          <button className="vi-view-button" disabled={preview.rect.zoom <= 1} onClick={() => preview.zoom(-1)} aria-label="영상 축소" title="축소 (-)"><Minus size={16}/></button>
          <button className="vi-view-fit" onClick={preview.reset} aria-label="영상 화면에 맞추기" title="화면 맞춤 (0) · 보기 확대는 출력에 적용되지 않습니다">{preview.rect.zoom === 1 ? '맞춤' : `${Math.round(preview.rect.zoom * 100)}%`}</button>
          <button className="vi-view-button" disabled={preview.rect.zoom >= 4} onClick={() => preview.zoom(1)} aria-label="영상 확대" title="확대 (+) · Ctrl / ⌘ + 휠"><Plus size={16}/></button>
          <button className="vi-view-button" onClick={() => setMuted(value => !value)} aria-pressed={muted} aria-label={muted ? '영상 소리 켜기' : '영상 음소거'} title="보기용 음소거 (M)">{muted ? <VolumeX size={16}/> : <Volume2 size={16}/>}</button>
          <button className="vi-view-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? '전체 화면 종료' : '영상 전체 화면'} title="전체 화면 (F) · Esc 종료">{fullscreen ? <Minimize size={16}/> : <Maximize size={16}/>}</button>
        </div>
      </div>}>
      <div className="vi-directing-dock" data-compact={compactTimeline}>
      <div className="vi-review-toolbar" role="group" aria-label="영상 재생과 피드백 도구">
      <div className="vi-player-controls">
        <div className="vi-transport">
          <button className="vi-play-button" disabled={editingLocked || mediaError || !mediaReady} onClick={togglePlayback} aria-label={playing ? '일시 정지' : '영상 재생'} title={mediaReady ? '재생 / 일시 정지 (Space)' : '영상을 불러오는 중'}>{playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>
          <button className="vi-icon-button" disabled={editingLocked || mediaError} onClick={() => seekFrame(frame - 1)} aria-label="이전 프레임" title="이전 프레임 (←)"><SkipBack size={18} fill="currentColor" /></button>
          <button className="vi-icon-button" disabled={editingLocked || mediaError} onClick={() => seekFrame(frame + 1)} aria-label="다음 프레임" title="다음 프레임 (→)"><SkipForward size={18} fill="currentColor" /></button>
          <TimecodeSeek key={version.id} frame={frame} durationFrames={durationFrames} locked={editingLocked || mediaError} onReadFrame={pauseAndReadFrame} onSeek={seekFrame} controlRef={timecodeRef}/>
        </div>
        <div className="vi-player-tools">
          {hasActiveRange ? <button className={`vi-loop-button${loopRange && hasActiveRange ? ' active' : ''}`} disabled={!hasActiveRange || editingLocked || mediaError} aria-pressed={loopRange && hasActiveRange} onClick={() => setLoopRange(enabled => !enabled)} title={hasActiveRange ? '보기용 IN–OUT 반복. 재생 버튼을 누르면 구간 밖에서는 IN부터 시작하며, 멈춘 상태에서는 자동 재생하지 않습니다.' : '구간을 지정하면 반복 재생할 수 있습니다.'}><Repeat2 size={15} />구간 반복</button> : null}
          {onToggleMarker ? <button className={`vi-loop-button vi-marker-button${markerHere ? ' active' : ''}`} disabled={editingLocked || mediaError} aria-pressed={markerHere} onClick={toggleMarker} title="검수 마커 찍기 / 지우기 (B) · 이전 / 다음 마커 ( , / . )"><Bookmark size={15} />{markerHere ? '마커 지우기' : '마커'}</button> : null}
          {markerLoop ? <button className={`vi-loop-button${markerLoopActive ? ' active' : ''}`} disabled={editingLocked || mediaError} aria-pressed={markerLoopActive} onClick={loopMarkers} title={`${timecode(markerLoop.in)}–${timecode(markerLoop.out)} 보기용 반복 · 다음 마커가 없으면 영상 끝까지. 선택 구간도 이 범위로 바뀝니다.`}><Repeat2 size={15} />다음 마커까지 반복</button> : null}
          <label className="vi-playback-speed"><span>보기</span><select aria-label="보기 배속 — 출력 영상에는 적용되지 않음" title="미리보기 재생 배속 ([ / ]). 출력 영상에는 적용되지 않습니다." value={playbackRate} onChange={event => changePlaybackRate(Number(event.target.value))}>{PLAYBACK_RATES.map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></label>
          {!compactTimeline ? <button className="vi-dock-icon vi-pan-tool" disabled={preview.rect.zoom <= 1} aria-pressed={preview.hand && preview.rect.zoom > 1} onClick={preview.toggleHand} aria-label="확대한 영상 이동" title="이동 도구 (H) · 마우스 가운데 버튼으로도 이동"><Hand size={16}/></button> : null}
        </div>
      </div>
      <div className="vi-drawing-tools" ref={setOverlayToolsHost} hidden={compactTimeline || annotationsReadOnly}/>
      <div className="vi-directing-actions">
        <select className="vi-rail-mode" aria-label="타임 레일 표시" title="타임 레일 표시 방식" value={compactTimeline ? 'compact' : simpleTimeline ? 'simple' : 'detail'} onChange={event => changeTimelineMode(event.target.value)}>
          <option value="detail">상세</option><option value="simple">간단</option><option value="compact">한 줄</option>
        </select>
        {compactTimeline ? <>
          <button className="vi-dock-icon vi-pan-tool" disabled={preview.rect.zoom <= 1} aria-pressed={preview.hand && preview.rect.zoom > 1} onClick={preview.toggleHand} aria-label="확대한 영상 이동" title="이동 도구 (H)"><Hand size={16}/></button>
          {(hasActiveRange || annotationsReadOnly) && onRangeClear ? <button type="button" className="vi-dock-icon" disabled={editingLocked} aria-label={annotationsReadOnly ? '댓글 선택 해제' : '구간 해제'} title={annotationsReadOnly ? '댓글 선택 해제' : '구간 해제'} onClick={clearRange}><X size={15}/></button> : null}
          <button ref={toolsToggleRef} type="button" className="vi-dock-icon" aria-label="그림 도구" aria-expanded={compactToolsOpen} aria-controls={drawingToolsId} title="그림·도형 도구 열기" onClick={() => setCompactToolsOpen(value => !value)}><Pencil size={15}/></button>
          <button type="button" className="vi-dock-icon" disabled={editingLocked || !canCompose} aria-label={composeLabel} title={`${composeLabel} (C)`} onClick={() => void composeFromViewer()}><MessageSquarePlus size={16}/></button>
        </> : null}
        <button type="button" className="vi-timeline-toggle" aria-label={compactTimeline ? '타임라인 펼치기' : '타임라인 최소화 · 영상 집중'} aria-expanded={!compactTimeline} aria-controls={timelineContentId} title={compactTimeline ? '타임라인 펼치기 · 이전 높이로 복원' : '타임라인을 한 줄로 접고 영상 크게 보기'} onClick={toggleCompactTimeline}>
          {compactTimeline ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}{!compactTimeline ? <span>최소화</span> : null}
        </button>
      </div>
      </div>
      {!compactTimeline && loopRange && hasActiveRange ? <p className="vi-loop-hint">보기용 반복 · {timecode(safeIn)}–{timecode(safeOut)} · 구간 밖에서 재생하면 IN부터 시작</p> : null}
      <div id={drawingToolsId} className="vi-overlay-controls" ref={setOverlayToolbarHost} hidden={compactTimeline && !compactToolsOpen}/>
      {playError ? <p className="vi-inline-error" role="alert">{playError}</p> : null}

      <div className="vi-timeline-area">
        <TimelineSeekSurface key={version.id} compact={compactTimeline} durationFrames={durationFrames} frame={frame} disabled={editingLocked} onSeek={seekTimeline}>
        <TimelineMarkers key={version.id} markers={markers} durationFrames={durationFrames} selectedId={selectedCommentId} disabled={editingLocked} onSelect={selectMarker}/>
        <div className="vi-timeline" ref={timelineRef} data-feedback-category={selectedCategory}>
          <TimelineFilmstrip version={version} enabled={!compactTimeline && !simpleTimeline} />
          <TimelineSavedRanges markers={markers} durationFrames={durationFrames} activeKey={hasActiveRange && annotationsReadOnly && selectedCommentId ? `${selectedCommentId}-${selectedRangeIndex}` : null}/>
          {hasActiveRange ? <div className="vi-range-selection" data-readonly={annotationsReadOnly} style={{ left: `${safeIn / durationFrames * 100}%`, width: `${(safeOut - safeIn) / durationFrames * 100}%` }} /> : null}
          <TimelineReviewMarkers markers={versionMarkers} durationFrames={durationFrames} activeFrame={markerHere ? frame : null} disabled={editingLocked} onSeek={seekTimeline} onRemove={removeMarker}/>
          <div ref={playheadRef} className="vi-playhead" style={{ left: `${frame / durationFrames * 100}%` }}><span /></div>
          {hasActiveRange && annotationsReadOnly ? <><span className="vi-range-boundary vi-range-in" aria-hidden="true" style={{ left: `${safeIn / durationFrames * 100}%` }}/><span className="vi-range-boundary vi-range-out" aria-hidden="true" style={{ left: `${safeOut / durationFrames * 100}%` }}/></> : hasActiveRange ? <><button disabled={editingLocked} className="vi-range-handle vi-range-in" style={{ left: `${safeIn / durationFrames * 100}%` }} role="slider" aria-label="구간 시작 IN" aria-valuemin={0} aria-valuemax={safeOut - 1} aria-valuenow={safeIn} aria-valuetext={`${timecode(safeIn)}, ${safeIn} 프레임`} title="IN · 드래그 또는 방향키로 조절"
            onPointerDown={(event) => dragTimeline(event, 'in')} onPointerMove={updateTimeline} onPointerUp={finishTimelineDrag} onPointerCancel={endTimelineDrag} onLostPointerCapture={endTimelineDrag} onKeyDown={(event) => rangeKey(event, 'in')} />
          <button disabled={editingLocked} className="vi-range-handle vi-range-out" style={{ left: `${safeOut / durationFrames * 100}%` }} role="slider" aria-label="구간 끝 OUT" aria-valuemin={safeIn + 1} aria-valuemax={durationFrames} aria-valuenow={safeOut} aria-valuetext={`${timecode(safeOut)}, ${safeOut} 프레임`} title="OUT · 드래그 또는 방향키로 조절"
            onPointerDown={(event) => dragTimeline(event, 'out')} onPointerMove={updateTimeline} onPointerUp={finishTimelineDrag} onPointerCancel={endTimelineDrag} onLostPointerCapture={endTimelineDrag} onKeyDown={(event) => rangeKey(event, 'out')} /> </> : null}
        </div>
        </TimelineSeekSurface>
        <div id={timelineContentId} hidden={compactTimeline}>
        <TimelineSelection key={`${version.id}:${selectedCommentId ?? 'draft'}`} frame={frame} frameIn={safeIn} frameOut={safeOut} durationFrames={durationFrames} active={hasActiveRange} available={rangeAvailable} readOnly={annotationsReadOnly} locked={editingLocked} mediaError={mediaError} onChange={onRangeChange} onMark={markRange} onStart={startRange} onClear={onRangeClear ? clearRange : undefined}/>
        {!compactTimeline && !simpleTimeline ? <TimelineDetails comments={comments} versions={versions} version={version} attachments={attachments} selectedId={selectedCommentId} selectedRangeIndex={selectedRangeIndex} disabled={editingLocked} onSelect={selectDetail}/> : null}
        </div>
      </div>

      <div className="vi-workspace-bottom" hidden={compactTimeline || simpleTimeline}>
        <span className="vi-drawing-contract">그림은 시간별 피드백에 함께 저장됩니다.</span>
        <button className="vi-compose-button" disabled={editingLocked || !canCompose} onClick={() => void composeFromViewer()} title="현재 시점이나 선택 구간에 피드백 작성 (C)"><Plus size={16} />{composeLabel}</button>
      </div>
      <div className="vi-shortcut-note"><span><kbd>Space</kbd> 재생</span><span><kbd>←</kbd><kbd>→</kbd> 프레임</span><span><kbd>I</kbd><kbd>O</kbd> 구간</span><span><kbd>C</kbd> 피드백</span><span><kbd>B</kbd> 마커</span><span className="vi-frame-precision">30 fps 기준 · OUT 제외</span></div>
      </div>
      </VerticalWorkspaceLayout>
    </section>
  );
}
