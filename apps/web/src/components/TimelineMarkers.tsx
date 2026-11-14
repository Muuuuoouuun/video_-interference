import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Brackets, Clock3, X } from 'lucide-react';
import type { Comment, ReviewMarker } from '../../../../packages/core/types';
import { layoutTimelineMarkers } from '../../../../packages/core/timeline-markers.mjs';
import { feedbackCategory, FEEDBACK_CATEGORY_LABELS } from '../../../../packages/core/feedback-category.mjs';
import { time } from '../format';
import './FeedbackCategory.css';
import './TimelineMarkers.css';

export interface FeedbackMarker {
  key: string; frame: number; frameOut: number; number: number;
  comment: Comment; rangeIndex: number; rangeCount: number;
}
interface Props {
  markers: FeedbackMarker[]; durationFrames: number; selectedId: string | null;
  disabled: boolean; onSelect: (marker: FeedbackMarker) => void;
}
interface PickerPlacement { left: number; top: number; width: number; maxHeight: number; choicesMaxHeight: number }
function kind(marker: FeedbackMarker) { return marker.comment.kind === 'note' ? '메모' : '피드백'; }
function summary(marker: FeedbackMarker) { return marker.comment.text || marker.comment.sceneDescription || '그림·첨부 자료'; }
function range(marker: FeedbackMarker) { return marker.frameOut - marker.frame === 1 ? time(marker.frame) : `${time(marker.frame)} – ${time(marker.frameOut)}`; }
function label(marker: FeedbackMarker) { return `${kind(marker)} ${marker.number}${marker.rangeCount > 1 ? ` 구간 ${marker.rangeIndex + 1}` : ''}: ${time(marker.frame)} ${summary(marker)}`; }

// Keep saved spans mounted independently of the draft/selected range. Exact
// projected endpoints remain separate even when nearby number badges cluster.
export const TimelineSavedRanges = memo(function TimelineSavedRanges({ markers, durationFrames, activeKey }: {
  markers: FeedbackMarker[]; durationFrames: number; activeKey: string | null;
}) {
  if (!(durationFrames > 0)) return null;
  return <div className="vi-saved-ranges" aria-hidden="true">
    {markers.map(marker => marker.frameOut - marker.frame > 1 && marker.key !== activeKey ? <span
      key={marker.key} className="vi-range-selection vi-saved-range" data-marker-key={marker.key} data-feedback-category={feedbackCategory(marker.comment)}
      style={{ left: `${marker.frame / durationFrames * 100}%`, width: `${(marker.frameOut - marker.frame) / durationFrames * 100}%` }}/>
      : null)}
  </div>;
});

// Re-renders only when markers change or the playhead enters/leaves one, not on every played frame.
export const TimelineReviewMarkers = memo(function TimelineReviewMarkers({ markers, durationFrames, activeFrame, disabled, onSeek, onRemove }: {
  markers: ReviewMarker[]; durationFrames: number; activeFrame: number | null; disabled: boolean;
  onSeek: (frame: number) => void; onRemove: (frame: number) => void;
}) {
  if (!(durationFrames > 0)) return null;
  return <>{/* Keyed by frame (unique per version) so a pending marker becoming saved keeps its element and does not replay the drop animation. */}
    {markers.map(marker => <button key={marker.frame} type="button" className={`vi-review-marker${marker.frame === activeFrame ? ' active' : ''}${marker.id.startsWith('pending:') ? ' pending' : ''}`}
    style={{ left: `${marker.frame / durationFrames * 100}%` }} disabled={disabled} aria-label={`검수 마커 ${time(marker.frame)}로 이동`} title={`검수 마커 ${time(marker.frame)} · 클릭 이동 · 우클릭 삭제`}
    onClick={() => onSeek(marker.frame)} onContextMenu={event => { event.preventDefault(); if (!disabled) onRemove(marker.frame); }}/>)}</>;
});

export const TimelineMarkers = memo(function TimelineMarkers({ markers, durationFrames, selectedId, disabled, onSelect }: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pickerId = useId();
  const [width, setWidth] = useState(640);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [pickerPlacement, setPickerPlacement] = useState<PickerPlacement | null>(null);
  const groups = useMemo(() => layoutTimelineMarkers(markers, durationFrames, width), [markers, durationFrames, width]);
  const openGroup = disabled ? undefined : groups.find(group => group.key === openKey && group.items.length > 1);
  const close = useCallback((restoreFocus = true) => {
    setOpenKey(null); setPickerPlacement(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    setWidth(Math.max(0, Math.round(rail.clientWidth)));
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(0, Math.round(entry.contentRect.width)));
    });
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (openKey && (pickerRef.current?.contains(document.activeElement) || document.activeElement === document.body)) triggerRef.current?.focus({ preventScroll: true });
    close(false);
  }, [markers, width, disabled]);
  useLayoutEffect(() => {
    const picker = pickerRef.current, trigger = triggerRef.current;
    if (!openGroup || !picker || !trigger) return;
    const margin = 8, gap = 8;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const popupWidth = Math.max(0, Math.min(280, viewportWidth - margin * 2));
    const anchor = trigger.getBoundingClientRect();
    const naturalHeight = picker.getBoundingClientRect().height;
    const choicesHeight = picker.querySelector<HTMLElement>('.vi-marker-choices')?.getBoundingClientRect().height ?? 0;
    const chromeHeight = naturalHeight - choicesHeight;
    const above = Math.max(0, anchor.top - gap - margin);
    const below = Math.max(0, viewportHeight - anchor.bottom - gap - margin);
    const placeAbove = above >= naturalHeight || above >= below;
    const maxHeight = Math.min(Math.max(0, viewportHeight - margin * 2), placeAbove ? above : below);
    const popupHeight = Math.min(naturalHeight, maxHeight);
    const proposedTop = placeAbove ? anchor.top - gap - popupHeight : anchor.bottom + gap;
    setPickerPlacement({
      left: Math.max(margin, Math.min(viewportWidth - popupWidth - margin, anchor.left + anchor.width / 2 - popupWidth / 2)),
      top: Math.max(margin, Math.min(viewportHeight - popupHeight - margin, proposedTop)),
      width: popupWidth, maxHeight, choicesMaxHeight: Math.max(0, Math.min(200, maxHeight - chromeHeight)),
    });
  }, [openGroup]);
  useLayoutEffect(() => {
    if (openGroup && pickerPlacement) pickerRef.current?.querySelector<HTMLButtonElement>('[data-marker-choice]')?.focus({ preventScroll: true });
  }, [openKey, pickerPlacement]);
  useEffect(() => {
    if (!openGroup) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!railRef.current?.contains(target) && !pickerRef.current?.contains(target)) close(false);
    };
    const scroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && pickerRef.current?.contains(target)) return;
      if (target === window || target === document || target instanceof Element && railRef.current && target.contains(railRef.current)) close(Boolean(pickerRef.current?.contains(document.activeElement)));
    };
    const resize = () => close(Boolean(pickerRef.current?.contains(document.activeElement)));
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [openGroup, close]);
  return <div className="vi-marker-rail" ref={railRef} role="group" aria-label="타임라인 댓글 마커"
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !pickerRef.current?.contains(event.relatedTarget)) close(false); }}
    onKeyDown={event => { if (openGroup && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    {groups.map(group => {
      const selected = group.items.find(marker => marker.comment.id === selectedId);
      const shown = selected ?? group.items[0];
      const grouped = group.items.length > 1;
      const category = feedbackCategory(shown.comment);
      const categories = [...new Set(group.items.map(marker => feedbackCategory(marker.comment)))];
      return <button key={group.key} type="button" disabled={disabled}
        className={`vi-comment-marker${selected ? ' vi-comment-selected' : ''}`}
        data-feedback-category={category} data-mixed={categories.length > 1}
        style={{ left: `${group.left}px`, width: group.width, '--marker-anchor': `${group.anchor - group.left + group.width / 2}px`, '--marker-stem': `${group.anchor - group.left + group.width / 2 - 1}px` } as CSSProperties}
        aria-label={grouped ? `가까운 마커 ${group.items.length}개 · ${group.items.map(marker => `${kind(marker)} ${marker.number}`).join(', ')}` : label(shown)}
        aria-pressed={grouped ? undefined : Boolean(selected)} aria-expanded={grouped ? openKey === group.key : undefined}
        aria-description={`${categories.map(item => FEEDBACK_CATEGORY_LABELS[item]).join('·')} 분야`}
        aria-controls={grouped && openKey === group.key ? pickerId : undefined}
        title={grouped ? `${categories.map(item => FEEDBACK_CATEGORY_LABELS[item]).join('·')} · ${group.items.length}개 마커 · 눌러서 선택` : `${kind(shown)} ${shown.number} · ${range(shown)} · ${summary(shown)} · ${FEEDBACK_CATEGORY_LABELS[category]}`}
        onClick={event => {
          if (!grouped) { close(false); onSelect(shown); return; }
          triggerRef.current = event.currentTarget;
          setPickerPlacement(null);
          setOpenKey(current => current === group.key ? null : group.key);
        }}>
        <span className="vi-marker-number">{shown.number}</span>{grouped ? <span className="vi-marker-count">+{group.items.length - 1}</span> : null}
      </button>;
    })}
    {openGroup && typeof document !== 'undefined' ? createPortal(<div id={pickerId} ref={pickerRef} className="vi-marker-picker" data-timeline-interactive role="group" aria-label="겹친 마커 선택"
      style={pickerPlacement ? { left: pickerPlacement.left, top: pickerPlacement.top, width: pickerPlacement.width, maxHeight: pickerPlacement.maxHeight } : { left: 0, top: 0, visibility: 'hidden' }}>
      <div className="vi-marker-picker-heading"><span>가까운 마커 <strong>{openGroup.items.length}</strong></span><button type="button" aria-label="마커 목록 닫기" onClick={() => close()}><X size={14}/></button></div>
      <div className="vi-marker-choices" style={pickerPlacement ? { maxHeight: pickerPlacement.choicesMaxHeight } : undefined} onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-marker-choice]'));
        const index = choices.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
        choices[next]?.focus();
      }}>{openGroup.items.map(marker => <button key={marker.key} type="button" data-marker-choice data-feedback-category={feedbackCategory(marker.comment)} aria-label={label(marker)} aria-pressed={marker.comment.id === selectedId}
        onClick={() => { close(); onSelect(marker); }}>
        <span className="vi-picker-number">{marker.number}</span><span className="vi-picker-copy"><span className="vi-picker-time">{marker.frameOut - marker.frame === 1 ? <Clock3 size={12}/> : <Brackets size={12}/>}<span>{range(marker)}</span>{marker.rangeCount > 1 ? <small>구간 {marker.rangeIndex + 1}</small> : null}<span className="feedback-category-label"><span className="feedback-category-dot" aria-hidden="true"/>{FEEDBACK_CATEGORY_LABELS[feedbackCategory(marker.comment)]}</span></span><span className="vi-picker-summary">{summary(marker)}</span></span>
      </button>)}</div>
    </div>, document.body) : null}
  </div>;
});
