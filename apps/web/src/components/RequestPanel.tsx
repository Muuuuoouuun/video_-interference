import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Clock3, FileText, MessageSquare, SlidersHorizontal, Type, Volume2, X, Image, Scissors, RotateCcw, PencilLine, LoaderCircle, Trash2, Plus, ChevronUp, ChevronDown, Search, LayoutList, StickyNote, ArrowDownWideNarrow } from 'lucide-react';
import type { Attachment, Comment, EditOp, Region, Version } from '../../../../packages/core/types';
import { projectComment } from '../../../../packages/core/comment-projection.mjs';
import { selectFeedbackList } from '../../../../packages/core/feedback-list.mjs';
import type { FeedbackSort } from '../../../../packages/core/feedback-list.mjs';
import { projectDrawings } from '../../../../packages/core/drawing-anchors.mjs';
import { time, duration } from '../format';
import { AttachmentGallery } from './AttachmentGallery';
import './RequestPanel.css';

const labels = { cut: '구간 삭제', trim: '구간만 유지', speed: '배속', subtitle: '자막 추가', overlay: '오버레이', audio: '음량', note: '메모' };
const filterIcons = { all: LayoutList, feedback: MessageSquare, notes: StickyNote, awaiting: Clock3, pending: SlidersHorizontal, applied: Check };
const icons = { cut: Scissors, trim: Scissors, speed: Clock3, subtitle: Type, overlay: Image, audio: Volume2, note: FileText };
export interface PreparedContextBundle { manifestUrl: string; archiveUrl?: string; sceneCount: number; drawingSceneCount: number; attachmentCount: number }
interface Props { headerActions?: ReactNode; keyboardEnabled?: boolean; editingMode?: boolean; revealToken?: number; comments: Comment[]; attachments: Attachment[]; ops: EditOp[]; versions: Version[]; currentVersion: Version; selectedId: string | null; busy: boolean; onSelect: (comment: Comment) => void; onSelectAuthored: (comment: Comment) => void; onOp: (id: string, patch: Record<string, unknown>) => Promise<boolean>; onInterpret: (id: string) => Promise<void>; onPrepareContextBundle: (id: string) => Promise<PreparedContextBundle | null>; onSupplement: (id: string, text: string) => Promise<boolean>; onEditComment: (id: string, patch: { text: string; sceneDescription: string }) => Promise<boolean>; onDeleteComment: (id: string) => Promise<boolean>; onDraftChange?: (hasContent: boolean) => void; previewOpId?: string|null; onPreviewOverlay?: (id: string) => void; onTranscribe?: (id: string) => Promise<void>; transcribingId?: string | null }

interface CommentDraft { text: string; sceneDescription: string; originalText: string; originalSceneDescription: string }
function isChangedDraft(draft: CommentDraft) { return draft.text !== draft.originalText || draft.sceneDescription !== draft.originalSceneDescription; }

function rangeLabel(frameIn: number, frameOut: number) { return frameOut - frameIn === 1 ? time(frameIn) : `${time(frameIn)} – ${time(frameOut)}`; }

function supplementTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' });
}

export const RequestPanel = memo(function RequestPanel({ headerActions, keyboardEnabled = true, editingMode = false, revealToken = 0, comments, attachments, ops, versions, currentVersion, selectedId, busy, onSelect, onSelectAuthored, onOp, onInterpret, onPrepareContextBundle, onSupplement, onEditComment, onDeleteComment, onDraftChange, previewOpId, onPreviewOverlay, onTranscribe, transcribingId }: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const localSelection = useRef<string|null>(null);
  const lastSelectedId = useRef(selectedId);
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useState<FeedbackSort>('timeline');
  const [pendingRevealId, setPendingRevealId] = useState<string|null>(null);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, CommentDraft>>({});
  const [editingCommentId, setEditingCommentId] = useState<string|null>(null);
  const [savingCommentId, setSavingCommentId] = useState<string|null>(null);
  const [deletingCommentId, setDeletingCommentId] = useState<string|null>(null);
  const [failedCommentId, setFailedCommentId] = useState<string|null>(null);
  const [resumeCommentId, setResumeCommentId] = useState<string|null>(null);
  const commentInFlight = useRef(false);
  const pendingCommentEdits = useMemo(() => comments.filter(comment => commentDrafts[comment.id] && isChangedDraft(commentDrafts[comment.id]) || savingCommentId === comment.id), [comments, commentDrafts, savingCommentId]);
  const [filter, setFilter] = useState<'all'|'feedback'|'notes'|'awaiting'|'pending'|'applied'>('all');
  useEffect(() => { setFilter('all'); }, [editingMode]);
  const [editing, setEditing] = useState<string|null>(null);
  const [editValue, setEditValue] = useState('');
  const [positioning, setPositioning] = useState<string|null>(null);
  const [supplementing, setSupplementing] = useState<string|null>(null);
  const [supplementDrafts, setSupplementDrafts] = useState<Record<string, string>>({});
  const [savingSupplementId, setSavingSupplementId] = useState<string|null>(null);
  const [failedSupplementId, setFailedSupplementId] = useState<string|null>(null);
  const [resumeSupplementId, setResumeSupplementId] = useState<string|null>(null);
  const supplementInFlight = useRef(false);
  const bundleInFlight = useRef(false);
  const lastRevealToken = useRef(0);
  const [preparingBundleId, setPreparingBundleId] = useState<string|null>(null);
  const [contextBundles, setContextBundles] = useState<Record<string, { revision: string; result: PreparedContextBundle }>>({});
  const pendingSupplements = useMemo(() => comments.filter(comment => Boolean(supplementDrafts[comment.id]?.trim()) || savingSupplementId === comment.id), [comments, supplementDrafts, savingSupplementId]);
  const hasUnsavedSupplement = pendingSupplements.length > 0;
  useEffect(() => { onDraftChange?.(hasUnsavedSupplement || pendingCommentEdits.length > 0); }, [hasUnsavedSupplement, pendingCommentEdits.length, onDraftChange]);
  useEffect(() => () => { onDraftChange?.(false); }, [onDraftChange]);
  useEffect(() => {
    if (!resumeSupplementId || supplementing !== resumeSupplementId || filter !== 'all' || searchQuery) return;
    const raf = requestAnimationFrame(() => {
      const textarea = document.getElementById(`supplement-${resumeSupplementId}`);
      textarea?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      textarea?.focus({ preventScroll: true });
      setResumeSupplementId(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [resumeSupplementId, supplementing, filter, searchQuery]);
  useEffect(() => {
    if (!resumeCommentId || editingCommentId !== resumeCommentId || filter !== 'all' || searchQuery) return;
    const raf = requestAnimationFrame(() => {
      const textarea = document.getElementById(`comment-text-${resumeCommentId}`);
      textarea?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      textarea?.focus({ preventScroll: true });
      setResumeCommentId(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [resumeCommentId, editingCommentId, filter, searchQuery]);
  const versionsById = useMemo(() => new Map(versions.map(version => [version.id, version])), [versions]);
  const projections = useMemo(() => new Map(comments.map(comment => {
    const authored = versionsById.get(comment.versionId);
    return [comment.id, authored ? projectComment(comment, authored, currentVersion) : { status: 'unavailable' as const, ranges: [], contextFrame: null, contextStatus: 'unavailable' as const }];
  })), [comments, versionsById, currentVersion]);
  const drawingStates = useMemo(() => new Map(comments.map(comment => {
    const drawings = projectDrawings(comment, versionsById.get(comment.versionId), currentVersion);
    return [comment.id, { scenes: new Set(drawings.filter(item => item.status === 'present').map(item => item.frame)).size, deleted: drawings.filter(item => item.status === 'deleted').length, unavailable: drawings.filter(item => item.status === 'unavailable').length }];
  })), [comments, versionsById, currentVersion]);
  const opsByComment = useMemo(() => {
    const groups = new Map<string, EditOp[]>();
    for (const op of ops) { const group = groups.get(op.commentId); if (group) group.push(op); else groups.set(op.commentId, [op]); }
    return groups;
  }, [ops]);
  const bundleRevisions = useMemo(() => new Map(comments.map(comment => [comment.id, comment.layerChange
    ? JSON.stringify({ change: comment.layerChange, operations: opsByComment.get(comment.id) ?? [] })
    : JSON.stringify({ text: comment.text, sceneDescription: comment.sceneDescription, supplement: comment.supplements?.at(-1)?.id, createdAt: comment.createdAt })])), [comments, opsByComment]);
  useEffect(() => {
    if (!revealToken || !selectedId || lastRevealToken.current === revealToken) return;
    lastRevealToken.current = revealToken;
    setFilter('all'); setSearchQuery(''); setPendingRevealId(selectedId);
  }, [revealToken, selectedId]);
  useEffect(() => {
    if (lastSelectedId.current === selectedId) return;
    lastSelectedId.current = selectedId;
    if (!selectedId) { localSelection.current = null; return; }
    if (localSelection.current === selectedId) { localSelection.current = null; return; }
    setFilter('all'); setSearchQuery(''); setPendingRevealId(selectedId);
  }, [selectedId]);
  const filtered = useMemo(() => comments.filter(comment => filter === 'all'
    || filter === 'feedback' && comment.kind !== 'note'
    || filter === 'notes' && comment.kind === 'note'
    || filter === 'awaiting' && comment.kind !== 'note' && !opsByComment.get(comment.id)?.length
    || filter === 'pending' && opsByComment.get(comment.id)?.some(op => op.type !== 'note' && (op.status === 'proposed' || op.status === 'needs_clarification'))
    || filter === 'applied' && opsByComment.get(comment.id)?.some(op => op.status === 'applied')), [comments, filter, opsByComment]);
  const visible = useMemo(() => selectFeedbackList(filtered, { query: searchQuery, sort, projections, attachments }), [filtered, searchQuery, sort, projections, attachments]);
  const numberById = useMemo(() => new Map(comments.map((comment, index) => [comment.id, index + 1])), [comments]);
  useEffect(() => {
    if (!pendingRevealId || searchQuery || filter !== 'all') return;
    const raf = requestAnimationFrame(() => {
      const card = document.getElementById(`request-${pendingRevealId}`);
      if (!card) return;
      card.scrollIntoView({ block: 'nearest' });
      setPendingRevealId(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingRevealId, searchQuery, filter, visible]);
  const selectedVisibleIndex = visible.findIndex(comment => comment.id === selectedId);
  const navigationBusy = busy || savingSupplementId !== null || savingCommentId !== null || deletingCommentId !== null;
  const previousComment = selectedVisibleIndex > 0 ? visible[selectedVisibleIndex - 1] : undefined;
  const nextComment = visible[selectedVisibleIndex + 1];
  function selectFromList(comment: Comment) { localSelection.current = comment.id; onSelect(comment); }
  function resetListFilters() { setSearchQuery(''); setFilter('all'); searchRef.current?.focus(); }
  function moveToComment(comment: Comment | undefined) {
    if (!comment || navigationBusy || commentInFlight.current || supplementInFlight.current) return;
    selectFromList(comment);
    requestAnimationFrame(() => {
      const card = document.getElementById(`request-${comment.id}`);
      card?.scrollIntoView({ block: 'nearest' });
      card?.querySelector<HTMLButtonElement>('.request-location')?.focus({ preventScroll: true });
    });
  }
  const filters = editingMode ? ([['all','전체'],['awaiting','해석 대기'],['pending','승인 대기'],['applied','적용됨']] as const) : ([['all','전체'],['feedback','피드백'],['notes','메모']] as const);
  const filterCounts = useMemo(() => {
    const counts = { all: comments.length, feedback: 0, notes: 0, awaiting: 0, pending: 0, applied: 0 };
    for (const comment of comments) {
      const related = opsByComment.get(comment.id) ?? [];
      if (comment.kind === 'note') counts.notes++; else counts.feedback++;
      if (comment.kind !== 'note' && related.length === 0) counts.awaiting++;
      if (related.some(op => op.type !== 'note' && (op.status === 'proposed' || op.status === 'needs_clarification'))) counts.pending++;
      if (related.some(op => op.status === 'applied')) counts.applied++;
    }
    return counts;
  }, [comments, opsByComment]);
  function startCommentEdit(comment: Comment) {
    if (busy || commentInFlight.current || comment.layerChange || comment.status === 'applied' || opsByComment.get(comment.id)?.some(op => op.status === 'applied')) return;
    selectFromList(comment);
    setCommentDrafts(drafts => drafts[comment.id] && isChangedDraft(drafts[comment.id]) ? drafts : { ...drafts, [comment.id]: { text: comment.text, sceneDescription: comment.sceneDescription ?? '', originalText: comment.text, originalSceneDescription: comment.sceneDescription ?? '' } });
    setEditingCommentId(comment.id); setFailedCommentId(null); setFilter('all'); setSearchQuery(''); setResumeCommentId(comment.id);
  }
  function cancelCommentEdit(id: string) {
    if (commentInFlight.current) return;
    setEditingCommentId(null); setFailedCommentId(null);
    requestAnimationFrame(() => document.getElementById(`edit-feedback-${id}`)?.focus({ preventScroll: true }));
    setCommentDrafts(drafts => { const next = { ...drafts }; delete next[id]; return next; });
  }
  async function saveCommentEdit(comment: Comment) {
    const draft = commentDrafts[comment.id];
    if (!draft || !isChangedDraft(draft) || busy || commentInFlight.current) return;
    commentInFlight.current = true; setSavingCommentId(comment.id); setFailedCommentId(null);
    try {
      if (await onEditComment(comment.id, { text: draft.text, sceneDescription: draft.sceneDescription })) {
        setEditingCommentId(null); setSearchQuery(''); setFilter('all'); setPendingRevealId(comment.id);
        requestAnimationFrame(() => document.getElementById(`edit-feedback-${comment.id}`)?.focus({ preventScroll: true }));
        setCommentDrafts(drafts => { const next = { ...drafts }; delete next[comment.id]; return next; });
      } else setFailedCommentId(comment.id);
    } catch { setFailedCommentId(comment.id); }
    finally { commentInFlight.current = false; setSavingCommentId(null); }
  }
  async function deleteComment(comment: Comment) {
    if (busy || commentInFlight.current || savingSupplementId || supplementDrafts[comment.id]?.trim() || commentDrafts[comment.id] && isChangedDraft(commentDrafts[comment.id])) return;
    commentInFlight.current = true; setDeletingCommentId(comment.id);
    try {
      if (await onDeleteComment(comment.id)) {
        if (editingCommentId === comment.id) setEditingCommentId(null);
        if (supplementing === comment.id) setSupplementing(null);
        setCommentDrafts(drafts => { const next = { ...drafts }; delete next[comment.id]; return next; });
      }
    } finally { commentInFlight.current = false; setDeletingCommentId(null); }
  }
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!keyboardEnabled || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.metaKey || event.ctrlKey || busy || commentInFlight.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target instanceof HTMLElement && target.isContentEditable || target?.closest('input, textarea, select, audio, video, [contenteditable="true"], [role="textbox"], dialog, [role="dialog"]') || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      if (event.altKey) {
        if (!event.shiftKey && panelRef.current?.contains(document.activeElement) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault(); moveToComment(event.key === 'ArrowUp' ? previousComment : nextComment);
        }
        return;
      }
      const focusedCard = target?.closest('article[data-feedback-id]');
      const focusedId = focusedCard && panelRef.current?.contains(focusedCard) ? focusedCard.getAttribute('data-feedback-id') : null;
      const comment = visible.find(item => item.id === (focusedId ?? selectedId));
      if (!comment) return;
      if (event.key === 'F2' && !event.shiftKey) {
        event.preventDefault(); startCommentEdit(comment);
      } else if (event.key === 'Delete' && event.shiftKey) {
        event.preventDefault(); void deleteComment(comment);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });
  function operationBlocked(op: EditOp) { return busy || commentInFlight.current || supplementInFlight.current || Boolean(supplementDrafts[op.commentId]?.trim()) || Boolean(commentDrafts[op.commentId] && isChangedDraft(commentDrafts[op.commentId])); }
  function startEdit(op: EditOp) { if (operationBlocked(op)) return; setEditing(op.id); setEditValue(String(op.params.factor ?? op.params.text ?? op.params.volume ?? '')); }
  async function prepareContext(comment: Comment) {
    if (busy || bundleInFlight.current) return;
    bundleInFlight.current = true; setPreparingBundleId(comment.id);
    const revision = bundleRevisions.get(comment.id)!;
    try {
      const result = await onPrepareContextBundle(comment.id);
      if (result) setContextBundles(previous => ({ ...previous, [comment.id]: { revision, result } }));
    } finally { bundleInFlight.current = false; setPreparingBundleId(null); }
  }
  async function saveEdit(op: EditOp) {
    if (operationBlocked(op)) return;
    const params = { ...op.params, ...(op.type === 'speed' ? { factor: Number(editValue) } : op.type === 'audio' ? { volume: Number(editValue) } : { text: editValue }) };
    if (await onOp(op.id, { params, status: 'proposed' })) setEditing(null);
  }
  function cancelSupplement(id: string) {
    setSupplementing(null);
    setFailedSupplementId(null);
    setSupplementDrafts(drafts => { const next = { ...drafts }; delete next[id]; return next; });
  }
  async function saveSupplement(comment: Comment, applied: boolean) {
    const text = supplementDrafts[comment.id]?.trim();
    if (!text || busy || applied || supplementInFlight.current) return;
    supplementInFlight.current = true;
    setSavingSupplementId(comment.id);
    setFailedSupplementId(null);
    try {
      if (await onSupplement(comment.id, text)) {
        setSupplementing(null);
        setFilter('all'); setSearchQuery(''); setPendingRevealId(comment.id);
        setSupplementDrafts(drafts => { const next = { ...drafts }; delete next[comment.id]; return next; });
      } else setFailedSupplementId(comment.id);
    } catch { setFailedSupplementId(comment.id); }
    finally { supplementInFlight.current = false; setSavingSupplementId(null); }
  }
  return <section ref={panelRef} className="request-panel" aria-label="시간별 피드백 목록">
    <div className="rq-list-toolbar">
    <div className="panel-heading rq-panel-heading"><div className="rq-heading-title"><h1>{editingMode ? '편집 요청' : '댓글'}</h1><span className="subtle">{comments.length}</span></div>{headerActions ? <div className="rq-header-actions">{headerActions}</div> : null}</div>
    {pendingCommentEdits.length > 0 ? <button className="rq-draft-summary" disabled={busy || savingCommentId !== null || deletingCommentId !== null} onClick={() => startCommentEdit(pendingCommentEdits[0])}><PencilLine size={13}/><span>수정 중인 피드백 {pendingCommentEdits.length}개 · 이어쓰기</span></button> : null}
    {pendingSupplements.length > 0 ? <button className="rq-draft-summary" disabled={busy || savingSupplementId !== null} onClick={() => { const first = pendingSupplements[0]; setFilter('all'); setSearchQuery(''); setSupplementing(first.id); setFailedSupplementId(null); setResumeSupplementId(first.id); }}><PencilLine size={13}/><span>작성 중인 보완 {pendingSupplements.length}개 · 이어쓰기</span></button> : null}
    <div className="request-tabs rq-filter-group" role="group" aria-label={editingMode ? '요청 상태 필터' : '댓글 종류 필터'} data-advanced={editingMode}>
      {filters.map(([key,label]) => { const Icon = filterIcons[key]; return <button type="button" key={key} aria-pressed={filter === key} aria-label={`${label} ${filterCounts[key]}개`} className={`rq-filter-button${filter === key ? ' active' : ''}`} onClick={() => setFilter(key)}><Icon size={14} aria-hidden="true"/><span className="rq-filter-label">{label}</span><span className="rq-filter-count" aria-hidden="true">{filterCounts[key]}</span></button>; })}
    </div>
    <div className="rq-list-controls">
      <div className="rq-search" role="search"><Search size={15} aria-hidden="true"/><input ref={searchRef} type="search" aria-label="피드백 검색" placeholder="댓글·장면·첨부 검색" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); setSearchQuery(''); } }}/>{searchQuery ? <button type="button" aria-label="검색어 지우기" title="검색어 지우기" onClick={() => { setSearchQuery(''); searchRef.current?.focus(); }}><X size={14}/></button> : null}</div>
      <div className="rq-list-meta"><label className="rq-sort"><span className="rq-sort-label">정렬</span><ArrowDownWideNarrow className="rq-sort-icon" size={14} aria-hidden="true"/><select aria-label="피드백 정렬" value={sort} onChange={event => setSort(event.target.value as FeedbackSort)} title={`영상 시간순은 현재 v${currentVersion.number} 기준입니다.`}><option value="timeline">영상 시간순</option><option value="newest">최근 작성순</option></select><ChevronDown className="rq-sort-chevron" size={13} aria-hidden="true"/></label><nav className="rq-navigation" aria-label="피드백 이동"><span>{selectedVisibleIndex < 0 ? '–' : selectedVisibleIndex + 1}<small> / {visible.length}</small></span><button type="button" disabled={navigationBusy || !previousComment} onClick={() => moveToComment(previousComment)} aria-label="이전 피드백" aria-keyshortcuts="Alt+ArrowUp" title="이전 피드백 · 목록에서 Alt + ↑"><ChevronUp size={16}/></button><button type="button" disabled={navigationBusy || !nextComment} onClick={() => moveToComment(nextComment)} aria-label="다음 피드백" aria-keyshortcuts="Alt+ArrowDown" title="다음 피드백 · 목록에서 Alt + ↓"><ChevronDown size={16}/></button></nav></div>
    </div>
    {searchQuery.trim() || filter !== 'all' ? <div className="rq-results-summary" role="status"><span>{visible.length}개 표시 · 전체 {comments.length}개</span><button type="button" onClick={resetListFilters}>전체 보기</button></div> : null}
    </div>
    <div className="request-list">
      {visible.length === 0 ? <div className="empty-requests"><MessageSquare size={24}/><p>{comments.length === 0 ? '아직 피드백이 없습니다.' : searchQuery.trim() ? '검색에 맞는 피드백이 없습니다.' : '이 분류의 피드백이 없습니다.'}</p>{searchQuery || filter !== 'all' ? <button type="button" className="outline-mint" onClick={resetListFilters}>검색·필터 초기화</button> : null}</div> : visible.map(comment => {
        const related = opsByComment.get(comment.id) ?? [];
        const supplements = comment.supplements ?? [];
        const isNote = comment.kind === 'note';
        const isLayerChange = Boolean(comment.layerChange);
        const hasApplied = comment.status === 'applied' || related.some(op => op.status === 'applied');
        const hasApproved = comment.status === 'approved' || related.some(op => op.status === 'approved');
        const needsClarification = Boolean(comment.clarification) || related.some(op => op.status === 'needs_clarification');
        const showInterpret = editingMode && !isNote && !isLayerChange && (related.length === 0 || needsClarification || supplements.length > 0);
        const supplementBusy = busy || savingSupplementId !== null || savingCommentId !== null || deletingCommentId !== null;
        const commentDraft = commentDrafts[comment.id];
        const unsavedEdit = Boolean(commentDraft && isChangedDraft(commentDraft));
        const commentEditorOpen = editingCommentId === comment.id && Boolean(commentDraft);
        const canSaveEdit = unsavedEdit && Boolean(commentDraft.text.trim() || comment.voiceAssetId || comment.drawings.length || comment.attachmentIds.length || isNote && commentDraft.sceneDescription.trim());
        const unsavedSupplement = Boolean(supplementDrafts[comment.id]?.trim());
        const opBusy = supplementBusy || unsavedEdit || unsavedSupplement;
        const authored = versionsById.get(comment.versionId);
        const projection = projections.get(comment.id)!;
        const drawingState = drawingStates.get(comment.id)!;
        const prepared = contextBundles[comment.id];
        const bundle = prepared?.revision === bundleRevisions.get(comment.id) ? prepared.result : undefined;
        const differentVersion = comment.versionId !== currentVersion.id;
        const mappedLabel = projection.status === 'deleted' ? '현재 버전에서 삭제된 구간' : projection.status === 'unavailable' ? '현재 버전에서 위치 확인 불가' : projection.ranges.map(range => rangeLabel(range.frameIn, range.frameOut)).join(', ');
        const index = numberById.get(comment.id)!;
        const showAuthoredPosition = differentVersion || !authored || projection.status !== 'present';
        return <article key={comment.id} id={`request-${comment.id}`} data-feedback-id={comment.id} className={`request-item ${selectedId === comment.id ? 'selected' : ''}`} tabIndex={0} aria-label={`피드백 ${index}`} onFocus={event => { if (event.target === event.currentTarget && !supplementBusy) selectFromList(comment); }}>
          <button className="request-location rq-projected-location" disabled={supplementBusy} onClick={() => selectFromList(comment)} aria-label={`요청 ${index}, 현재 버전 v${currentVersion.number}, ${mappedLabel}`}><span className={`request-number ${related.some(op => op.status === 'approved' || op.status === 'applied') ? 'approved' : ''}`}>{index}</span><span className="rq-location-content"><span className="rq-current-version">현재 v{currentVersion.number}</span>{projection.status === 'deleted' || projection.status === 'unavailable' ? <span className={`rq-projection-message ${projection.status}`}>{mappedLabel}</span> : <span className="rq-projected-ranges">{projection.ranges.map((range, rangeIndex) => <span key={rangeIndex}>{rangeLabel(range.frameIn, range.frameOut)}</span>)}</span>}</span></button>
          {showAuthoredPosition || comment.updatedAt ? <div className="rq-authored-position">{showAuthoredPosition ? <span>{authored ? `작성 v${authored.number}` : '작성 버전 정보 없음'} · {rangeLabel(comment.frameIn, comment.frameOut)}</span> : null}{comment.updatedAt ? <span className="rq-edited-label" title={supplementTime(comment.updatedAt)}>수정됨</span> : null}{differentVersion ? <button className="quiet" disabled={supplementBusy || !authored} onClick={() => onSelectAuthored(comment)} title={!authored ? '작성 버전 정보를 찾을 수 없습니다.' : '요청을 작성한 버전과 원래 프레임을 엽니다.'}>{authored ? `작성 v${authored.number} 보기` : '작성 버전 보기'}</button> : null}</div> : null}
          {projection.status === 'partial' ? <p className="rq-projection-note">현재 버전에 표시할 수 있는 일부 구간만 보입니다.</p> : null}
          {projection.contextStatus === 'deleted' ? <p className="rq-projection-note">요청을 남긴 기준 장면은 삭제됨</p> : null}
          {comment.drawings.length > 0 ? <p className="rq-projection-note">그림 {comment.drawings.length}개 · 현재 {drawingState.scenes}개 장면{drawingState.deleted ? ` · 삭제된 장면의 그림 ${drawingState.deleted}개` : ''}{drawingState.unavailable ? ` · 위치 확인 불가 ${drawingState.unavailable}개` : ''}</p> : null}
          {editingMode && !isNote ? <p className="rq-authored-target">{isLayerChange ? '수정·제거 승인은' : '해석·승인은'} {authored ? `작성 v${authored.number}` : '작성 버전'} 기준입니다.{differentVersion && authored ? ' 실행하려면 해당 버전을 여세요.' : ''}</p> : null}
          {comment.kind === 'note' ? <span className="request-kind-note"><FileText size={12}/>보관된 메모</span> : null}
          {!commentEditorOpen && comment.sceneDescription ? <div className="rq-scene-description"><span>장면 내용 · 직접 작성</span><p>{comment.sceneDescription}</p></div> : null}
          {!commentEditorOpen ? <p className="request-text" onDoubleClick={() => startCommentEdit(comment)} title={hasApplied || isLayerChange ? undefined : '두 번 클릭해서 수정'}>{comment.text || (comment.voiceAssetId ? '음성 지시가 저장되었습니다.' : comment.attachmentIds.length ? '첨부 자료가 저장되었습니다.' : comment.sceneDescription ? '장면 기록' : '그림으로 남긴 피드백')}</p> : <form className="rq-comment-editor" aria-label="저장된 피드백 수정" onSubmit={event => { event.preventDefault(); void saveCommentEdit(comment); }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (canSaveEdit) void saveCommentEdit(comment); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelCommentEdit(comment.id); } }}>
            <div className="rq-editor-heading"><PencilLine size={14}/><strong>피드백 수정</strong><span>시간·그림 유지</span></div>
            <label htmlFor={`comment-scene-${comment.id}`}>장면 내용 <span>선택</span></label>
            <textarea id={`comment-scene-${comment.id}`} className="rq-scene-editor" value={commentDraft.sceneDescription} maxLength={500} disabled={supplementBusy} placeholder="이때 영상에 어떤 내용이 나오나요?" onChange={event => { const sceneDescription = event.target.value; setCommentDrafts(drafts => ({ ...drafts, [comment.id]: { ...drafts[comment.id], sceneDescription } })); setFailedCommentId(null); }}/>
            <label htmlFor={`comment-text-${comment.id}`}>{isNote ? '메모 내용' : '편집 피드백'}</label>
            <textarea id={`comment-text-${comment.id}`} value={commentDraft.text} maxLength={5000} disabled={supplementBusy} placeholder="어떤 부분을 어떻게 바꿀까요?" onChange={event => { const text = event.target.value; setCommentDrafts(drafts => ({ ...drafts, [comment.id]: { ...drafts[comment.id], text } })); setFailedCommentId(null); }}/>
            {related.length > 0 ? <p className="rq-supplement-approval">수정하면 기존 해석과 승인을 해제합니다.</p> : null}
            {failedCommentId === comment.id ? <p className="rq-supplement-error" role="alert">저장하지 못했습니다. 수정한 내용은 유지됩니다.</p> : null}
            <div className="rq-editor-footer"><span>⌘ / Ctrl + Enter 저장</span><div><button type="button" className="quiet" disabled={supplementBusy} onClick={() => cancelCommentEdit(comment.id)}>취소</button><button type="submit" className="outline-mint" disabled={supplementBusy || !canSaveEdit}>{savingCommentId === comment.id ? <LoaderCircle size={13} className="spinning"/> : <Check size={13}/>}수정 저장</button></div></div>
          </form>}
          {supplements.length > 0 ? <ol className="rq-supplement-history" aria-label={isNote ? '메모 보완 기록' : '추가 지시 기록'}>{supplements.map((supplement, supplementIndex) => <li key={supplement.id}><div><span>{isNote ? '메모 보완' : '추가 지시'} {supplementIndex + 1}</span><time dateTime={supplement.createdAt}>{supplementTime(supplement.createdAt)}</time></div><p>{supplement.text}</p></li>)}</ol> : null}
          <AttachmentGallery compact disabled={busy} onTranscribe={onTranscribe} transcribingId={transcribingId} attachments={attachments.filter(attachment => comment.attachmentIds.includes(attachment.id) || comment.voiceAssetId === attachment.id)}/>
          {comment.clarification ? <p className="clarification">{comment.clarification}</p> : null}
          {(editingMode || isLayerChange ? related : []).map(op => {
            const Icon = icons[op.type];
            const removing = op.layerChange?.action === 'remove';
            const operationLabel = op.layerChange ? `${op.type === 'subtitle' ? '자막' : '그래픽'} ${removing ? '제거' : '수정'}` : labels[op.type];
            const canEdit = editingMode && !removing && (['speed','subtitle','audio'].includes(op.type) || op.type === 'overlay' && op.params.kind === 'text') && op.status !== 'applied';
            const canPosition = editingMode && !removing && op.type === 'overlay' && op.params.kind !== 'drawing' && op.status !== 'applied' && op.status !== 'needs_clarification';
            const status = op.type === 'note' ? '보관된 메모' : op.status === 'applied' ? '적용됨' : op.status === 'approved' ? '승인됨' : op.status === 'rejected' ? '제외됨' : op.status === 'needs_clarification' ? '보완 필요' : '승인 대기';
            return <div key={op.id} className={`op-area ${op.status === 'rejected' ? 'rejected' : ''}`}>
              <div className="op-description"><Icon size={17}/><span>{operationLabel}{op.type === 'speed' ? ` ${op.params.factor}× · ${duration(op.frameOut-op.frameIn)} → ${duration((op.frameOut-op.frameIn)/(op.params.factor || 1))}` : op.type === 'subtitle' && !removing ? ` · ${duration(op.frameOut-op.frameIn)}` : ''}</span></div>
              {op.type === 'speed' ? <small className="op-detail">원본 속도 기준</small> : null}
              {removing ? <small className="op-detail">다음 버전에서 이 그래픽 제거 · 이전 버전 유지</small> : null}
              {op.interpreter === 'manual' ? <small className="op-detail">직접 지정한 변경 · 기존 적용 구간 유지</small> : null}
              {!removing && op.type === 'subtitle' ? <small className="op-detail">“{op.params.text}”</small> : null}
              {!removing && op.type === 'overlay' ? <small className="op-detail">{op.params.kind === 'drawing' ? `그림·도형 ${op.params.drawings?.length ?? 0}개 · 지정 구간에 표시` : op.params.kind === 'image' ? '삽입 이미지 · 원본 비율 유지' : op.params.kind === 'box' ? '도형 표시' : `“${op.params.text}”`}</small> : null}
              {editingMode && editing === op.id ? <form className="op-editor" onSubmit={e => { e.preventDefault(); void saveEdit(op); }}><input disabled={opBusy} aria-label={`${operationLabel} 값 수정`} type={op.type === 'subtitle' || op.type === 'overlay' ? 'text' : 'number'} min={op.type === 'speed' ? 0.25 : 0} max={op.type === 'speed' ? 4 : 2} step="any" value={editValue} onChange={e => setEditValue(e.target.value)}/><button disabled={opBusy} className="outline-mint">저장</button></form> : <div className="op-actions"><span className={`op-status ${op.status}`}>{op.status === 'applied' || op.status === 'approved' ? <Check size={13}/> : null}{status}</span>
                {canEdit ? <button className="quiet" disabled={opBusy} onClick={() => startEdit(op)} aria-label={`${operationLabel} 값 수정`}><SlidersHorizontal size={14}/>수정</button> : null}
                {editingMode && op.type !== 'note' && op.status === 'proposed' ? <button disabled={opBusy} className="outline-mint" onClick={() => void onOp(op.id, { status: 'approved' })}>승인</button> : null}
                {editingMode && op.status === 'approved' ? <button className="quiet" disabled={opBusy} onClick={() => void onOp(op.id, { status: 'proposed' })} aria-label="승인 취소"><RotateCcw size={14}/></button> : null}
                {editingMode && op.status === 'proposed' ? <button className="quiet icon" disabled={opBusy} onClick={() => void onOp(op.id, { status: 'rejected' })} aria-label="요청 제외"><X size={14}/></button> : null}
              </div>}
              {canPosition ? <div className="overlay-placement-actions"><button className={`quiet ${previewOpId === op.id ? 'mint-text' : ''}`} disabled={opBusy} onClick={() => { setPositioning(positioning === op.id ? null : op.id); if (op.params.kind === 'image' && !op.layerChange) onPreviewOverlay?.(op.id); }}><SlidersHorizontal size={14}/>위치·크기</button>{previewOpId === op.id ? <small>영상 위에서 조절 중</small> : null}</div> : null}
              {canPosition && positioning === op.id ? <RegionEditor key={JSON.stringify(op.region)} op={op} busy={opBusy} onSave={region => operationBlocked(op) ? Promise.resolve(false) : onOp(op.id, { region, status: 'proposed' })}/> : null}
            </div>;
          })}
          {editingMode && related.length > 0 && (unsavedEdit || unsavedSupplement) ? <p className="rq-comment-guidance">피드백 수정을 먼저 저장하거나 취소한 뒤 편집 명령을 변경하세요.</p> : null}
          <div className="rq-comment-actions"><div className="rq-edit-actions"><button id={`edit-feedback-${comment.id}`} className="quiet rq-edit-button" disabled={supplementBusy || hasApplied || isLayerChange || commentEditorOpen} onClick={() => startCommentEdit(comment)} aria-label={`피드백 ${index} 수정`} title={hasApplied || isLayerChange ? '이미 적용된 요청과 그래픽 변경은 새 피드백으로 남겨 주세요.' : '피드백 수정 (F2)'}><PencilLine size={14}/>수정</button><button id={`delete-feedback-${comment.id}`} className="quiet rq-delete-button" disabled={supplementBusy || unsavedEdit || unsavedSupplement} onClick={() => void deleteComment(comment)} aria-label={`피드백 ${index} 삭제`} title={unsavedEdit || unsavedSupplement ? '작성 중인 내용을 먼저 저장하거나 취소하세요.' : '피드백 삭제 (Shift + Delete) · 삭제 후 되돌릴 수 있습니다.'}>{deletingCommentId === comment.id ? <LoaderCircle size={14} className="spinning"/> : <Trash2 size={14}/>}삭제</button></div>{!isLayerChange ? <button className="quiet rq-supplement-toggle" disabled={supplementBusy || hasApplied} aria-expanded={supplementing === comment.id} aria-controls={`supplement-form-${comment.id}`} onClick={() => { setSupplementing(comment.id); setFailedSupplementId(null); }} title={hasApplied ? '이미 적용된 요청입니다. 새 요청을 남겨 주세요.' : isNote ? '원문을 유지하고 메모를 덧붙입니다.' : '원문을 유지하고 편집 지시를 덧붙입니다.'}><Plus size={14}/>추가 지시</button> : null}
            {editingMode ? <button className="quiet" disabled={supplementBusy || unsavedSupplement || unsavedEdit || preparingBundleId !== null || !authored} onClick={() => void prepareContext(comment)} title={unsavedSupplement || unsavedEdit ? '작성 중인 내용을 먼저 저장한 뒤 자료를 준비하세요.' : '저장된 요청·그림·관련 장면·첨부를 이 PC에서 자료로 준비합니다. 외부 AI에 전송하지 않습니다.'}>{preparingBundleId === comment.id ? <LoaderCircle size={13} className="spinning"/> : <FileText size={13}/>}AI용 자료 준비</button> : null}
            {showInterpret ? <button className="outline-mint" disabled={supplementBusy || unsavedSupplement || unsavedEdit || hasApproved || hasApplied} onClick={() => void onInterpret(comment.id)} title={unsavedSupplement || unsavedEdit ? '작성 중인 내용을 먼저 저장한 뒤 해석하세요.' : hasApplied ? '적용된 요청은 다시 해석할 수 없습니다. 새 요청을 남겨 주세요.' : hasApproved ? '기존 승인을 취소하거나 지시를 보완한 뒤 해석하세요.' : '원문과 추가 지시를 함께 해석합니다.'}>요청 해석</button> : null}
          </div>
          {editingMode && bundle ? <div className="rq-context-bundle" role="status"><p>로컬 자료 준비됨 · 영상 {bundle.sceneCount}장 · 첨부 {bundle.attachmentCount}개</p><div>{bundle.archiveUrl ? <a className="quiet" href={bundle.archiveUrl} download>자료 묶음 받기</a> : null}<a className="quiet" href={bundle.manifestUrl} target="_blank" rel="noreferrer">자료 목록</a><span>외부 전송 없음</span></div></div> : null}
          {hasApplied ? <p className="rq-comment-guidance">{editingMode && related.some(op => op.type === 'overlay' || op.type === 'subtitle') ? '자막·그래픽 변경은 현재 버전의 ‘적용된 자막·그래픽’에서 요청하세요.' : '이미 적용된 요청입니다. 변경하려면 새 요청을 남겨 주세요.'}</p> : showInterpret && hasApproved ? <p className="rq-comment-guidance">승인된 명령이 있습니다. 승인을 취소하거나 지시를 보완한 뒤 다시 해석하세요.</p> : editingMode && supplements.length > 0 && !isNote && (comment.status === 'received' || related.length === 0) ? <p className="rq-comment-guidance">추가 지시가 저장되었습니다. 요청 해석을 눌러 편집 명령을 준비하세요.</p> : null}
          {!isLayerChange && supplementing === comment.id ? <form id={`supplement-form-${comment.id}`} className="rq-supplement-form" onSubmit={event => { event.preventDefault(); void saveSupplement(comment, hasApplied); }}>
            <label htmlFor={`supplement-${comment.id}`}>{isNote ? '메모 보완' : '피드백 보완'}</label>
            <textarea id={`supplement-${comment.id}`} autoFocus aria-label={isNote ? '메모 보완 내용' : '추가 편집 지시 내용'} value={supplementDrafts[comment.id] ?? ''} maxLength={5000} disabled={supplementBusy || hasApplied} placeholder={isNote ? '기존 메모에 덧붙일 내용을 입력하세요.' : '어떤 부분을 어떻게 바꿀지 더 알려주세요.'} onChange={event => { const value = event.target.value; setSupplementDrafts(drafts => ({ ...drafts, [comment.id]: value })); setFailedSupplementId(null); }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void saveSupplement(comment, hasApplied); } else if (event.key === 'Escape' && !supplementBusy) { event.preventDefault(); event.stopPropagation(); cancelSupplement(comment.id); } }} />
            {hasApproved ? <p className="rq-supplement-approval">추가 지시를 저장하면 이전 승인이 해제됩니다.</p> : null}
            {!hasApplied ? <p className="rq-supplement-help">{isNote ? '원문을 유지하고 보완 기록으로 저장합니다.' : editingMode ? '원문을 유지합니다. 저장 후 요청 해석을 눌러 주세요.' : '원문과 보완 내용을 함께 전달 자료에 담습니다.'}</p> : null}
            {failedSupplementId === comment.id ? <p className="rq-supplement-error" role="alert">보완 내용을 저장하지 못했습니다. 내용을 유지했으니 다시 시도해 주세요.</p> : null}
            <div className="rq-supplement-form-actions"><button type="button" className="quiet" disabled={supplementBusy} onClick={() => cancelSupplement(comment.id)}>취소</button><button type="submit" className="outline-mint" disabled={supplementBusy || hasApplied || !supplementDrafts[comment.id]?.trim()}>{savingSupplementId === comment.id ? <LoaderCircle size={13} className="spinning"/> : null}추가 저장</button></div>
          </form> : null}
        </article>;
      })}
    </div>
  </section>;
});

function RegionEditor({ op, busy, onSave }: { op: EditOp; busy: boolean; onSave: (region: Region) => Promise<unknown> }) {
  const [region, setRegion] = useState<Region>(op.region ?? { x: 0.12, y: 0.16, w: 0.76, h: 0.22 });
  const valid = Object.values(region).every(Number.isFinite) && region.x >= 0 && region.y >= 0 && region.w >= 0.02 && region.h >= 0.02 && region.x + region.w <= 1.000001 && region.y + region.h <= 1.000001;
  return <form className="region-editor" onSubmit={e => { e.preventDefault(); if (valid) void onSave(region); }}>
    <div className="region-presets"><button type="button" disabled={busy} onClick={() => setRegion({ x: 0.68, y: 0.05, w: 0.27, h: 0.27 })}>오른쪽 위</button><button type="button" disabled={busy} onClick={() => setRegion({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 })}>가운데</button><button type="button" disabled={busy} onClick={() => setRegion({ x: 0.1, y: 0.72, w: 0.8, h: 0.2 })}>아래쪽</button></div>
    <div className="region-fields">{([['x','왼쪽'],['y','위'],['w','너비'],['h','높이']] as const).map(([key,label]) => <label key={key}>{label}<div><input aria-label={`오버레이 ${label} 비율`} type="number" min={key === 'w' || key === 'h' ? 2 : 0} max="100" step="any" disabled={busy} value={Number.isFinite(region[key]) ? +(region[key] * 100).toFixed(2) : ''} onChange={e => setRegion(previous => ({ ...previous, [key]: e.target.value === '' ? NaN : Number(e.target.value) / 100 }))}/><span>%</span></div></label>)}</div>
    {!valid ? <p className="region-warning">영상 안에 들어오도록 위치와 크기를 조절하세요.</p> : null}
    <div className="region-save"><small>변경하면 다시 승인해야 합니다.</small><button className="outline-mint" disabled={busy || !valid}>배치 저장</button></div>
  </form>;
}
