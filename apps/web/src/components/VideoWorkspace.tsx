import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, Ref } from 'react';
import { Pause, Play, Plus, Repeat2, SkipBack, SkipForward, X } from 'lucide-react';
import type { Asset, Comment, Drawing, Version } from '../../../../packages/core/types';
import { mapFrameBetweenVersions, projectComment } from '../../../../packages/core/comment-projection.mjs';
import { createRangePlaybackController } from '../../../../packages/core/range-playback.mjs';
import type { PlaybackCommand } from '../../../../packages/core/range-playback.mjs';
import { markTimelineRange } from '../../../../packages/core/timeline-range.mjs';
import { OverlayEditor } from './OverlayEditor';
import { ImagePlacementOverlay } from './ImagePlacementOverlay';
import type { ImageOverlayPreview } from './ImagePlacementOverlay';
import { TimelineFilmstrip } from './TimelineFilmstrip';
import './VideoWorkspace.css';

const FPS = 30;
type Range = { in: number; out: number };
type Drag = 'seek' | 'in' | 'out';
type TimelineDrag = { kind: Drag; pointerId: number; target: HTMLElement };
type VideoRect = { left: number; top: number; width: number; height: number };

export interface VideoWorkspaceHandle { pauseAndReadFrame: () => number }

export interface VideoWorkspaceProps {
  version: Version;
  versions: Version[];
  asset: Asset;
  comments: Comment[];
  selectedCommentId: string | null;
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
  onSelectComment?: (comment: Comment, rangeIndex?: number) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function timecode(frame: number) {
  const seconds = Math.max(0, frame) / FPS;
  const wholeSeconds = Math.floor(seconds);
  const mins = Math.floor(wholeSeconds / 60).toString().padStart(2, '0');
  const secs = (wholeSeconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}.${Math.floor((seconds - wholeSeconds) * 100 + 0.00001).toString().padStart(2, '0')}`;
}

export function VideoWorkspace({ version, versions, asset, comments, selectedCommentId, currentFrame, focusFrameToken, playbackRef, onFrameChange, range, rangeAvailable = true, rangeActive = true, onRangeClear, onRangeStart, canCompose = true, composeLabel = '선택 구간에 피드백', onRangeChange, drawings, onDrawingsChange, onCompose, compareVersion, onInsertDrawings, onDrawingCreate, imageOverlay, annotationsReadOnly = false, editingLocked = false, editingLockLabel, annotationFrame, drawingHistoryKey, onDrawingHistoryChange, onSelectComment }: VideoWorkspaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const compareRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const lastEmittedFrame = useRef<number | null>(null);
  const currentFrameRef = useRef(currentFrame);
  const pointerDragRef = useRef<TimelineDrag | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loopRange, setLoopRange] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [playback] = useState(createRangePlaybackController);
  const playAttempt = useRef(0);
  const playbackCallbacks = useRef({ onFrameChange });
  playbackCallbacks.current = { onFrameChange };
  const [playbackRate, setPlaybackRate] = useState(1);
  const [overlayToolbarHost, setOverlayToolbarHost] = useState<HTMLDivElement | null>(null);
  const [videoRect, setVideoRect] = useState<VideoRect>({ left: 0, top: 0, width: 0, height: 0 });
  const [mediaError, setMediaError] = useState(false);
  const [playError, setPlayError] = useState('');
  const durationFrames = Math.max(1, version.durationFrames);
  const frame = clamp(currentFrame, 0, durationFrames - 1);
  const safeIn = clamp(range.in, 0, durationFrames - 1);
  const safeOut = clamp(range.out, safeIn + 1, durationFrames);
  const hasActiveRange = rangeAvailable && rangeActive;
  const visibleComments = useMemo(() => {
    const authoredVersions = new Map(versions.map(item => [item.id, item]));
    return comments.map((comment, index) => ({ comment, index, projection: projectComment(comment, authoredVersions.get(comment.versionId), version) })).filter(item => item.projection.ranges.length > 0);
  }, [comments, versions, version]);
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
    if (pointerDragRef.current?.kind !== 'seek' && (!hasActiveRange || annotationsReadOnly || editingLocked)) cancelTimelineDrag();
  }, [hasActiveRange, annotationsReadOnly, editingLocked]);
  useLayoutEffect(() => { cancelTimelineDrag(); }, [version.id]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing) return;
    let disposed = false, handle: number | null = null;
    const nativeFrames = typeof video.requestVideoFrameCallback === 'function';
    const tick = () => {
      handle = null;
      if (disposed || !playback.playingRequested || video.paused) return;
      samplePlayback(); schedule();
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
  }, [playing, version.id, version.mediaUrl, playback, samplePlayback]);

  useEffect(() => () => { playAttempt.current++; playback.requestPause(); }, [playback]);

  const measureVideo = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const video = videoRef.current;
    const ratio = (video?.videoWidth || asset.width) / (video?.videoHeight || asset.height);
    const width = Math.min(surface.clientWidth, surface.clientHeight * ratio);
    const height = width / ratio;
    setVideoRect({ left: (surface.clientWidth - width) / 2, top: (surface.clientHeight - height) / 2, width, height });
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
    lastEmittedFrame.current = null;
    if (videoRef.current && videoRef.current.readyState >= 1) videoRef.current.currentTime = next / FPS;
    onFrameChange(next);
  }, [durationFrames, onFrameChange, pauseVideo, editingLocked]);

  const markRange = useCallback((edge: 'in' | 'out') => {
    if (editingLocked || annotationsReadOnly) return;
    const next = markTimelineRange({ edge, frame: pauseAndReadFrame(), durationFrames, range: { in: safeIn, out: safeOut }, active: hasActiveRange });
    if (next) onRangeChange(next);
  }, [editingLocked, annotationsReadOnly, pauseAndReadFrame, durationFrames, safeIn, safeOut, hasActiveRange, onRangeChange]);
  const keyboardActionsRef = useRef({ frame, seekFrame, togglePlayback, markRange, onCompose, editingLocked, annotationsReadOnly: annotationsReadOnly || editingLocked });
  keyboardActionsRef.current = { frame, seekFrame, togglePlayback, markRange, onCompose, editingLocked, annotationsReadOnly: annotationsReadOnly || editingLocked };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || element?.closest('input, textarea, select, button, audio, video, summary, [contenteditable], dialog, [role="dialog"]') || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.repeat && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const actions = keyboardActionsRef.current;
      if (actions.editingLocked) return;
      if (event.code === 'Space') { event.preventDefault(); actions.togglePlayback(); }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); actions.seekFrame(actions.frame + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? FPS : 1));
      } else if (event.key.toLowerCase() === 'i' && !actions.annotationsReadOnly) {
        event.preventDefault(); actions.markRange('in');
      } else if (event.key.toLowerCase() === 'o' && !actions.annotationsReadOnly) {
        event.preventDefault(); actions.markRange('out');
      } else if (event.key.toLowerCase() === 'c') { event.preventDefault(); actions.onCompose(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  function dragTimeline(event: ReactPointerEvent<HTMLElement>, kind: Drag) {
    if (editingLocked || (annotationsReadOnly || !hasActiveRange) && kind !== 'seek') { event.stopPropagation(); return; }
    if (event.button !== 0 || pointerDragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragRef.current = { kind, pointerId: event.pointerId, target: event.currentTarget };
    updateTimeline(event, kind);
  }

  function updateTimeline(event: ReactPointerEvent<HTMLElement>, kind?: Drag) {
    const active = pointerDragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (editingLocked || active.kind !== 'seek' && (!hasActiveRange || annotationsReadOnly)) { cancelTimelineDrag(); return; }
    // IN/OUT handles share this handler with the timeline; consume each captured move once.
    event.stopPropagation();
    const bounds = timelineRef.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    const target = kind ?? active.kind;
    const next = clamp(Math.round((event.clientX - bounds.left) / bounds.width * durationFrames), 0, durationFrames);
    if (target === 'seek') seekFrame(Math.min(next, durationFrames - 1));
    else if (target === 'in') onRangeChange({ in: Math.min(next, safeOut - 1), out: safeOut });
    else onRangeChange({ in: safeIn, out: Math.max(next, safeIn + 1) });
  }

  function endTimelineDrag(event: ReactPointerEvent<HTMLElement>) {
    if (pointerDragRef.current?.pointerId !== event.pointerId) return;
    cancelTimelineDrag();
  }

  function cancelTimelineDrag() {
    const active = pointerDragRef.current;
    pointerDragRef.current = null;
    if (active?.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
  }

  function finishTimelineDrag(event: ReactPointerEvent<HTMLElement>) {
    updateTimeline(event);
    endTimelineDrag(event);
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

  const overlayStyle: CSSProperties = { left: videoRect.left, top: videoRect.top, width: videoRect.width, height: videoRect.height };

  return (
    <section className="vi-workspace" aria-label="영상과 시간별 피드백 작업 공간">
      <div className={`vi-viewer${compareVersion ? ' vi-viewer-comparing' : ''}`}>
        <div className="vi-video-surface" ref={surfaceRef}>
          <video ref={videoRef} src={version.mediaUrl} poster={version.thumbnailUrl || asset.thumbnailUrl} preload="metadata" playsInline
            onLoadedMetadata={() => { const video = videoRef.current; if (video) { video.currentTime = currentFrameRef.current / FPS; video.playbackRate = playbackRate; } measureVideo(); }}
            onLoadedData={() => setMediaReady(true)} onCanPlay={() => setMediaReady(true)}
            onTimeUpdate={() => samplePlayback(true)} onSeeked={() => { playback.observeSeeked(); samplePlayback(true); }}
            onPlay={() => { if (!playback.playingRequested) pauseVideo(); else setPlaying(true); }}
            onPause={() => { const state = mediaState(); if (!state.paused) return; setPlaying(false); applyPlayback(playback.observePause(state)); }}
            onEnded={() => { if (!mediaState().ended) return; setPlaying(false); samplePlayback(true); }}
            onError={() => { pauseVideo(); setMediaReady(false); setMediaError(true); }} onClick={togglePlayback} aria-label={`v${version.number} 영상`} />
          <OverlayEditor drawings={drawings} currentFrame={frame} fallbackFrame={annotationFrame} onFrameSelect={seekFrame} onChange={onDrawingsChange} viewport={videoRect} enabled={!playing && !imageOverlay} blocked={Boolean(imageOverlay) || editingLocked} blockedLabel={imageOverlay ? '이미지 배치 중' : editingLockLabel ?? '피드백 저장·녹음·첨부 중'} readOnly={annotationsReadOnly} onPause={pauseVideo} onBackgroundClick={togglePlayback} toolbarHost={overlayToolbarHost} resetKey={drawingHistoryKey ?? `${version.id}:draft`} onHistoryChange={onDrawingHistoryChange} onInsertDrawings={onInsertDrawings} onCreate={onDrawingCreate} />
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
      </div>

      <div className="vi-player-controls">
        <div className="vi-transport">
          <button className="vi-play-button" disabled={editingLocked || mediaError || !mediaReady} onClick={togglePlayback} aria-label={playing ? '일시 정지' : '영상 재생'} title={mediaReady ? '재생 / 일시 정지 (Space)' : '영상을 불러오는 중'}>{playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>
          <button className="vi-icon-button" disabled={editingLocked || mediaError} onClick={() => seekFrame(frame - 1)} aria-label="이전 프레임" title="이전 프레임 (←)"><SkipBack size={18} fill="currentColor" /></button>
          <button className="vi-icon-button" disabled={editingLocked || mediaError} onClick={() => seekFrame(frame + 1)} aria-label="다음 프레임" title="다음 프레임 (→)"><SkipForward size={18} fill="currentColor" /></button>
          <div className="vi-timecode"><strong>{timecode(frame)}</strong><span>/ {timecode(durationFrames)}</span></div>
        </div>
        <div className="vi-player-tools">
          {hasActiveRange ? <button className={`vi-loop-button${loopRange && hasActiveRange ? ' active' : ''}`} disabled={!hasActiveRange || editingLocked || mediaError} aria-pressed={loopRange && hasActiveRange} onClick={() => setLoopRange(enabled => !enabled)} title={hasActiveRange ? '보기용 IN–OUT 반복. 재생 버튼을 누르면 구간 밖에서는 IN부터 시작하며, 멈춘 상태에서는 자동 재생하지 않습니다.' : '구간을 지정하면 반복 재생할 수 있습니다.'}><Repeat2 size={15} />구간 반복</button> : null}
          <label className="vi-playback-speed"><span>보기</span><select aria-label="보기 배속 — 출력 영상에는 적용되지 않음" title="미리보기 재생 배속. 출력 영상에는 적용되지 않습니다." value={playbackRate} onChange={(event) => { const rate = Number(event.target.value); setPlaybackRate(rate); if (videoRef.current) videoRef.current.playbackRate = rate; }}>{[0.5, 1, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}</select></label>
        </div>
      </div>
      {loopRange && hasActiveRange ? <p className="vi-loop-hint">보기용 반복 · {timecode(safeIn)}–{timecode(safeOut)} · 구간 밖에서 재생하면 IN부터 시작</p> : null}
      <div className="vi-overlay-controls" ref={setOverlayToolbarHost} />
      {playError ? <p className="vi-inline-error" role="alert">{playError}</p> : null}

      <div className="vi-timeline-area">
        <div className="vi-timeline-ruler" aria-hidden="true">{[0, 0.25, 0.5, 0.75, 1].map((fraction) => <span key={fraction}>{timecode(Math.round(durationFrames * fraction)).slice(0, 5)}</span>)}</div>
        <div className="vi-timeline" ref={timelineRef} onPointerDown={(event) => dragTimeline(event, 'seek')} onPointerMove={updateTimeline} onPointerUp={finishTimelineDrag} onPointerCancel={endTimelineDrag} onLostPointerCapture={endTimelineDrag}>
          <TimelineFilmstrip version={version} />
          {hasActiveRange ? <div className="vi-range-selection" style={{ left: `${safeIn / durationFrames * 100}%`, width: `${(safeOut - safeIn) / durationFrames * 100}%` }} /> : null}
          {visibleComments.flatMap(({ comment, index, projection }) => projection.ranges.map((mapped, rangeIndex) => <button key={`${comment.id}-${rangeIndex}`} disabled={editingLocked} className={`vi-comment-marker${comment.id === selectedCommentId ? ' vi-comment-selected' : ''}`} style={{ left: `${clamp(mapped.frameIn / durationFrames * 100, 0, 100)}%` }} aria-label={`${comment.kind === 'note' ? '메모' : '피드백'} ${index + 1}${projection.ranges.length > 1 ? ` 구간 ${rangeIndex + 1}` : ''}: ${timecode(mapped.frameIn)} ${comment.text || comment.sceneDescription || '그림·첨부 자료'}`} title={`${comment.kind === 'note' ? '메모' : '피드백'} ${index + 1} · ${timecode(mapped.frameIn)}–${timecode(mapped.frameOut)} · ${comment.text || comment.sceneDescription || '그림·첨부 자료'}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => onSelectComment ? onSelectComment(comment, rangeIndex) : seekFrame(mapped.frameIn)}>{index + 1}</button>))}
          <div className="vi-playhead" style={{ left: `${frame / durationFrames * 100}%` }}><span /></div>
          {hasActiveRange ? <><button disabled={annotationsReadOnly || editingLocked} className="vi-range-handle vi-range-in" style={{ left: `${safeIn / durationFrames * 100}%` }} role="slider" aria-label="구간 시작 IN" aria-valuemin={0} aria-valuemax={safeOut - 1} aria-valuenow={safeIn} aria-valuetext={`${timecode(safeIn)}, ${safeIn} 프레임`} title="IN · 드래그 또는 방향키로 조절"
            onPointerDown={(event) => dragTimeline(event, 'in')} onPointerMove={updateTimeline} onPointerUp={finishTimelineDrag} onPointerCancel={endTimelineDrag} onLostPointerCapture={endTimelineDrag} onKeyDown={(event) => rangeKey(event, 'in')} />
          <button disabled={annotationsReadOnly || editingLocked} className="vi-range-handle vi-range-out" style={{ left: `${safeOut / durationFrames * 100}%` }} role="slider" aria-label="구간 끝 OUT" aria-valuemin={safeIn + 1} aria-valuemax={durationFrames} aria-valuenow={safeOut} aria-valuetext={`${timecode(safeOut)}, ${safeOut} 프레임`} title="OUT · 드래그 또는 방향키로 조절"
            onPointerDown={(event) => dragTimeline(event, 'out')} onPointerMove={updateTimeline} onPointerUp={finishTimelineDrag} onPointerCancel={endTimelineDrag} onLostPointerCapture={endTimelineDrag} onKeyDown={(event) => rangeKey(event, 'out')} /> </> : null}
        </div>
        {hasActiveRange ? <div className="vi-range-fields">
          <label><button disabled={annotationsReadOnly || editingLocked} title="현재 프레임을 IN으로 (I)" onClick={() => markRange('in')}>IN</button><input disabled={annotationsReadOnly || editingLocked} aria-label="IN 시간 초" type="number" min="0" max={(safeOut - 1) / FPS} step={1 / FPS} value={Number((safeIn / FPS).toFixed(3))} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) onRangeChange({ in: clamp(Math.round(value * FPS), 0, safeOut - 1), out: safeOut }); }} /><span>초</span></label>
          <span className="vi-range-duration">{((safeOut - safeIn) / FPS).toFixed(2)}초 선택</span>
          <label><button disabled={annotationsReadOnly || editingLocked} title="현재 프레임 다음을 OUT으로 (O)" onClick={() => markRange('out')}>OUT</button><input disabled={annotationsReadOnly || editingLocked} aria-label="OUT 시간 초" type="number" min={(safeIn + 1) / FPS} max={durationFrames / FPS} step={1 / FPS} value={Number((safeOut / FPS).toFixed(3))} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) onRangeChange({ in: safeIn, out: clamp(Math.round(value * FPS), safeIn + 1, durationFrames) }); }} /><span>초</span></label>
          {onRangeClear ? <button type="button" className="vi-range-clear" disabled={editingLocked} onClick={clearRange}><X size={13}/>{annotationsReadOnly ? '선택 해제' : '구간 해제'}</button> : null}
        </div> : <div className="vi-point-fields"><div><span>현재 시점</span><strong>{timecode(frame)}</strong>{!rangeAvailable ? <small>선택한 피드백의 구간은 이 버전에 없습니다.</small> : null}</div>{annotationsReadOnly ? onRangeClear ? <button type="button" className="vi-range-clear" disabled={editingLocked} onClick={clearRange}><X size={13}/>선택 해제</button> : null : <button type="button" className="vi-range-start" disabled={editingLocked || mediaError} onClick={startRange}>구간 지정 <span>I / O</span></button>}</div>}
      </div>

      <div className="vi-workspace-bottom">
        <span className="vi-drawing-contract">그림은 시간별 피드백에 함께 저장됩니다.</span>
        <button className="vi-compose-button" disabled={editingLocked || !canCompose} onClick={onCompose} title="현재 시점이나 선택 구간에 피드백 작성 (C)"><Plus size={16} />{composeLabel}</button>
      </div>
      <div className="vi-shortcut-note"><span><kbd>Space</kbd> 재생</span><span><kbd>←</kbd><kbd>→</kbd> 프레임</span><span><kbd>I</kbd><kbd>O</kbd> 구간</span><span><kbd>C</kbd> 피드백</span><span className="vi-frame-precision">30 fps 기준 · OUT 제외</span></div>
    </section>
  );
}
