import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp, Image, Layers3, MessageSquare, Mic, PenTool } from 'lucide-react';
import type { Attachment, Comment, Version } from '../../../../packages/core/types';
import { buildTimelineDetails, layoutTimelineDetails } from '../../../../packages/core/timeline-details.mjs';
import type { TimelineDetailItem } from '../../../../packages/core/timeline-details.mjs';
import { AttachmentGallery } from './AttachmentGallery';
import { time } from '../format';
import './TimelineDetails.css';

interface Props {
  comments: Comment[];
  versions: Version[];
  version: Version;
  attachments: Attachment[];
  selectedId: string | null;
  selectedRangeIndex: number;
  disabled: boolean;
  onSelect: (commentId: string, rangeIndex?: number, frame?: number) => void;
}
const categories = [
  { kind: 'feedback', label: '댓글·구간', Icon: MessageSquare },
  { kind: 'drawing', label: '그림·도형', Icon: PenTool },
  { kind: 'reference', label: '시안·이미지', Icon: Image },
  { kind: 'voice', label: '음성', Icon: Mic },
] as const;
const detailTime = (item: TimelineDetailItem) => item.frameOut - item.frameIn > 1
  ? `${time(item.frameIn)} – ${time(item.frameOut)}` : time(item.frameIn);

/** Keep the normal timeline compact; detailed tracks and media mount only on demand. */
export const TimelineDetails = memo(function TimelineDetails(props: Props) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return <section className="vi-details" aria-label="타임라인 상세 정보">
    <button type="button" className="vi-details-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
      <Layers3 size={15}/><span>구간·시안 {expanded ? '접기' : '펼치기'}</span>
      <small>댓글 · 그림 · 첨부 위치</small>{expanded ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}
    </button>
    <div id={contentId} hidden={!expanded}>{expanded ? <DetailTracks key={props.version.id} {...props}/> : null}</div>
  </section>;
});

function DetailTracks({ comments, versions, version, attachments, selectedId, selectedRangeIndex, disabled, onSelect }: Props) {
  const model = useMemo(() => buildTimelineDetails(comments, versions, version, attachments), [comments, versions, version, attachments]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const tracksRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = tracksRef.current;
    if (!node) return;
    setWidth(Math.max(0, Math.round(node.clientWidth)));
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(0, Math.round(entry.contentRect.width)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const lanes = useMemo(() => categories.map(category => {
    const items = model.items.filter(item => item.kind === category.kind);
    return { ...category, count: items.length, ...layoutTimelineDetails(items, version.durationFrames, width) };
  }), [model, version.durationFrames, width]);
  const selected = model.items.find(item => item.id === activeId && item.commentId === selectedId && (item.rangeIndex === null || item.rangeIndex === selectedRangeIndex))
    ?? model.items.find(item => item.commentId === selectedId && item.kind === 'feedback' && item.rangeIndex === selectedRangeIndex);
  const selectedComment = comments.find(comment => comment.id === selected?.commentId);
  const selectedCategory = categories.find(category => category.kind === selected?.kind);
  const selectedAttachments = useMemo(() => {
    if (!selected) return [];
    const ids = new Set(selected.attachmentIds);
    return attachments.filter(attachment => ids.has(attachment.id));
  }, [selected, attachments]);

  function select(item: TimelineDetailItem) {
    if (disabled) return;
    setActiveId(item.id);
    onSelect(item.commentId, item.rangeIndex ?? undefined, item.frameIn);
  }
  function navigateLane(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
    buttons[next]?.focus({ preventScroll: true });
    buttons[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  return <div className="vi-details-content">
    <p className="vi-details-help">항목을 누르면 해당 시점과 오른쪽 댓글로 이동합니다.</p>
    <div className="vi-details-scroll">
      <div ref={tracksRef} className="vi-details-tracks">
        {model.items.length ? <div className="vi-details-ruler" aria-label="상세 시간축">{[0, .25, .5, .75, 1].map(fraction => <span key={fraction} style={{ left: `${fraction * 100}%`, transform: `translateX(${fraction === 0 ? 0 : fraction === 1 ? -100 : -50}%)` }}>{time(Math.round(version.durationFrames * fraction)).split('.')[0]}</span>)}</div> : null}
        {lanes.filter(lane => lane.count > 0).map(({ kind, label, Icon, count, entries, rows }) => <section className="vi-details-lane" key={kind} aria-label={label}>
          <header><Icon size={13}/><strong>{label}</strong><span>{count}</span></header>
          <div className="vi-details-track" style={{ height: Math.max(1, rows) * 36 + 4 }} onKeyDown={navigateLane}>
            {entries.map(({ item, left, width: itemWidth, anchorLeft, anchorWidth, row }) => <div key={item.id}>
              <span className={`vi-details-anchor${selected?.id === item.id ? ' is-selected' : ''}`} aria-hidden="true" style={{ left: anchorLeft, width: Math.max(1, anchorWidth), top: row * 36 + 31 }}/>
              <button type="button" className="vi-details-item" disabled={disabled} aria-pressed={selected?.id === item.id}
                style={{ left, width: itemWidth, top: row * 36 }} onClick={() => select(item)}
                title={`댓글 ${item.number} · ${label} · ${detailTime(item)}\n${item.label}`}
                aria-label={`댓글 ${item.number} · ${label} · ${detailTime(item)} · ${item.label}`}>
                <b>{item.number}</b>{itemWidth >= 64 ? <span>{item.label}</span> : null}
              </button>
            </div>)}
          </div>
        </section>)}
        {!model.items.length ? <p className="vi-details-empty">이 버전에 표시할 항목이 없습니다. 댓글을 저장하면 구간과 연결된 자료가 여기에 표시됩니다.</p> : null}
      </div>
    </div>
    {selected && selectedComment && selectedCategory ? <article className="vi-details-preview" aria-label={`댓글 ${selected.number} 상세`}>
      <header><span className="vi-details-number">{selected.number}</span><selectedCategory.Icon size={13}/><strong>{selectedCategory.label}</strong><time>{detailTime(selected)}</time></header>
      {selectedComment.sceneDescription ? <p className="vi-details-scene">{selectedComment.sceneDescription}</p> : null}
      <p>{selectedComment.text || selected.label}</p>
      {selected.kind === 'drawing' ? <small>이 시점에 그림·도형 {selected.drawingCount}개</small> : null}
      {selectedAttachments.length ? <AttachmentGallery key={selected.id} attachments={selectedAttachments} compact/> : null}
    </article> : model.items.length ? <p className="vi-details-legend">막대 아래의 얇은 선은 실제 구간입니다. 짧은 항목은 누르기 쉽도록 넓게 표시합니다.</p> : null}
    {model.unavailable.length ? <details className="vi-details-unavailable">
      <summary>현재 시간축에 없는 댓글 <span>{model.unavailable.length}</span></summary>
      <div>{model.unavailable.map(item => <button key={item.commentId} type="button" disabled={disabled} onClick={() => { setActiveId(null); onSelect(item.commentId); }}>
        <span>댓글 {item.number}</span><small>{item.reason === 'deleted' ? '편집으로 구간 삭제됨' : '위치 확인 필요'}</small>
      </button>)}</div>
    </details> : null}
  </div>;
}
