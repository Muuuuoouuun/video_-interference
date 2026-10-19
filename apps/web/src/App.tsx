import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Play, ShieldCheck, Layers, Film, Download, Columns2, X, LoaderCircle, Info, Package, Square, Keyboard, Trash2, RotateCcw, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, SquarePen, CornerUpLeft, MoreHorizontal } from 'lucide-react';
import type { AppState, BootstrapState, Comment, Drawing, EditOp, FeedbackExportResult, FeedbackCategory, InterpretResult, LayerChangeInput, LayerChangeResult, Project, RenderJob, RenderLayer, Version } from '../../../packages/core/types';
import { confirmedMutation } from '../../../packages/core/confirmed-mutation.mjs';
import { projectComment } from '../../../packages/core/comment-projection.mjs';
import { createProjectedRequestDraft, planPlayerCompose } from '../../../packages/core/request-draft.mjs';
import { drawingFrame, groupDrawings, projectDrawings } from '../../../packages/core/drawing-anchors.mjs';
import { api, upload } from './api';
import { time } from './format';
import { FeedbackExportDialog } from './components/FeedbackExportDialog';
import { LayerPanel } from './components/LayerPanel';
import { RequestPanel } from './components/RequestPanel';
import type { PreparedContextBundle } from './components/RequestPanel';
import { Composer } from './components/Composer';
import type { RequestAnchor, RequestOptions } from './components/Composer';
import { VideoWorkspace } from './components/VideoWorkspace';
import { ResizableWorkspace } from './components/ResizableWorkspace';
import { VideoStart } from './components/VideoStart';
import type { VideoWorkspaceHandle } from './components/VideoWorkspace';
import { ShortcutDialog, FeedbackTrashDialog } from './components/WorkspaceDialogs';
import { SavedRequestContext } from './components/SavedRequestContext';
import type { ImageOverlayPreview } from './components/ImagePlacementOverlay';
import './components/RequestContext.css';

export function App() {
  const [data, setData] = useState<AppState|null>(null);
  const [empty, setEmpty] = useState(false);
  const [editingMode, setEditingMode] = useState(false);
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  const [feedbackPanelOpen, setFeedbackPanelOpen] = useState(true);
  const [feedbackAnchorMode, setFeedbackAnchorMode] = useState<'point'|'range'>('point');
  const [exportOpen, setExportOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [undoDeleteId, setUndoDeleteId] = useState<string | null>(null);
  const feedbackMutationInFlight = useRef(false);
  const [exportResult, setExportResult] = useState<FeedbackExportResult | null>(null);
  const [exportError, setExportError] = useState('');
  const exportInFlight = useRef(false);
  const initialized = useRef(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [composerActive, setComposerActive] = useState(false);
  const [voiceAnchorLocked, setVoiceAnchorLocked] = useState(false);
  const [draftContent, setDraftContent] = useState(false);
  const [supplementDraft, setSupplementDraft] = useState(false);
  const [layerDraftOpen, setLayerDraftOpen] = useState(false);
  const [feedbackRevealToken, setFeedbackRevealToken] = useState(0);
  const [loadingFile, setLoadingFile] = useState(false);
  const [selectedId, setSelectedId] = useState<string|null>(null);
  const [selectedRangeIndex, setSelectedRangeIndex] = useState(0);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [focusFrameToken, setFocusFrameToken] = useState(0);
  const [range, setRange] = useState({ in: 0, out: 1 });
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [drawingGeneration, setDrawingGeneration] = useState(0);
  const [drawingHistoryAvailable, setDrawingHistoryAvailable] = useState(false);
  const resetDrawingHistory = useCallback(() => { setDrawingGeneration(value => value + 1); setDrawingHistoryAvailable(false); }, []);
  const [previewOpId, setPreviewOpId] = useState<string|null>(null);
  const drawingContext = useRef(0);
  const draftFrame = useRef(0);
  const liveFrame = useRef(currentFrame);
  liveFrame.current = currentFrame;
  const [job, setJob] = useState<RenderJob|null>(null);
  const [compare, setCompare] = useState(false);
  const [showAssets, setShowAssets] = useState(false);
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const feedbackExpandRef = useRef<HTMLButtonElement>(null);
  const feedbackCollapseRef = useRef<HTMLButtonElement>(null);
  const workspacePlaybackRef = useRef<VideoWorkspaceHandle>(null);
  const load = useCallback(async () => {
    const state = await api<BootstrapState>('/api/state');
    if ('empty' in state) { setEmpty(true); setData(null); return state; }
    setEmpty(false); setData(state);
    setJob(state.jobs[state.jobs.length - 1] ?? null);
    if (!initialized.current) {
      setCurrentFrame(0); drawingContext.current = 0; draftFrame.current = 0;
      setRange({ in: 0, out: 1 }); setFeedbackAnchorMode('point'); setSelectedId(null);
      initialized.current = true;
    }
    return state;
  }, []);
  useEffect(() => { void load().catch(e => setError((e as Error).message)); }, [load]);
  useEffect(() => {
    if (!job || ['completed', 'failed', 'canceled'].includes(job.status)) return;
    const interval = setInterval(() => {
      void api<RenderJob>(`/api/jobs/${job.id}`).then(async updated => {
        setJob(updated);
        if (updated.status === 'completed') { await load(); setNotice('새 버전이 준비되었습니다. 버전 기록에서 확인하세요.'); }
        if (updated.status === 'canceled') { await load(); setNotice('렌더를 취소했습니다. 승인한 요청은 다시 실행할 수 있습니다.'); }
        if (updated.status === 'failed') setError(updated.error || '렌더를 완료하지 못했습니다.');
      }).catch(e => setError((e as Error).message));
    }, 900); return () => clearInterval(interval);
  }, [job?.id, job?.status, load]);
  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timeout); }, [notice]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || target?.closest('input, textarea, select, [contenteditable], dialog, [role="dialog"]')) return;
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey || event.key === '/' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault(); setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const version = data?.versions.find(v => v.id === data.project.activeVersionId) ?? data?.versions[0];
  const selectedComment = data?.comments.find(comment => comment.id === selectedId);
  const selectedOrigin = data?.versions.find(item => item.id === selectedComment?.versionId);
  const projection = useMemo(() => selectedComment && version ? projectComment(selectedComment, selectedOrigin, version) : null, [selectedComment, selectedOrigin, version]);
  const drawingProjections = useMemo(() => selectedComment && version ? projectDrawings(selectedComment, selectedOrigin, version) : [], [selectedComment, selectedOrigin, version]);
  const selectedDrawings = useMemo(() => drawingProjections.filter(item => item.status === 'present').map(item => item.drawing), [drawingProjections]);
  const savedDrawingGroups = useMemo(() => groupDrawings(selectedDrawings, 0), [selectedDrawings]);
  const selectedProjectedRange = projection?.ranges[selectedRangeIndex] ?? projection?.ranges[0];
  const draftPending = draftContent || drawings.length > 0;
  const draftReturnable = draftPending || drawingHistoryAvailable;
  const reviewRange = selectedComment ? selectedProjectedRange ? { in: selectedProjectedRange.frameIn, out: selectedProjectedRange.frameOut } : { in: 0, out: 1 } : range;
  const rangeActive = selectedComment ? Boolean(selectedProjectedRange && selectedProjectedRange.frameOut - selectedProjectedRange.frameIn > 1) : feedbackAnchorMode === 'range';
  const approved = data?.ops.filter(op => op.status === 'approved' && op.type !== 'note' && op.versionId === version?.id) ?? [];
  const rendering = job?.status === 'running' || job?.status === 'queued';
  const draftLocked = busy || loadingFile || composerActive || voiceAnchorLocked || layerDraftOpen;
  const mutate = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try {
      const result = await confirmedMutation(action, load);
      if (result.refreshError) setError(`작업은 저장했습니다. 화면을 갱신하려면 다시 연결하세요. ${(result.refreshError as Error).message}`);
    } catch (error) { setError((error as Error).message); throw error; }
    finally { setBusy(false); }
  }, [load]);
  const acceptInterpretation = useCallback((result: InterpretResult) => setData(state => state ? { ...state, comments: state.comments.map(comment => comment.id === result.comment.id ? result.comment : comment), ops: [...state.ops.filter(op => op.commentId !== result.comment.id), ...result.ops] } : state), []);
  const onOp = useCallback(async (id: string, patch: Record<string, unknown>) => { try { await mutate(async () => { const op = await api<EditOp>(`/api/ops/${id}`, 'PATCH', patch); setData(state => state ? { ...state, ops: state.ops.map(item => item.id === id ? op : item), comments: state.comments.map(comment => comment.id === op.commentId ? { ...comment, status: op.status === 'approved' ? 'approved' : 'interpreted' } : comment) } : state); }); return true; } catch { return false; } }, [mutate]);
  const onInterpret = useCallback(async (id: string) => { try { await mutate(async () => acceptInterpretation(await api<InterpretResult>(`/api/comments/${id}/interpret`, 'POST', {}))); } catch { /* displayed in app */ } }, [mutate, acceptInterpretation]);
  const onPrepareContextBundle = useCallback(async (id: string) => {
    setBusy(true); setError('');
    try { return await api<PreparedContextBundle>(`/api/comments/${id}/context-bundle`, 'POST', {}); }
    catch (error) { setError((error as Error).message); return null; }
    finally { setBusy(false); }
  }, []);
  async function exportFeedback() {
    if (!version || !data || !data.comments.length || busy || loadingFile || composerActive || rendering || exportInFlight.current) return;
    if (draftPending || supplementDraft || layerDraftOpen) { setError('작성 중인 피드백을 먼저 저장한 뒤 내보내 주세요.'); return; }
    exportInFlight.current = true; setExportOpen(true); setExportResult(null); setExportError(''); setBusy(true);
    try { setExportResult(await api<FeedbackExportResult>('/api/feedback-exports', 'POST', { versionId: version.id })); }
    catch (error) { setExportError(error instanceof Error ? error.message : '피드백 자료를 준비하지 못했습니다.'); }
    finally { exportInFlight.current = false; setBusy(false); }
  }
  const onLayerChange = useCallback(async (layer: RenderLayer, input: LayerChangeInput) => {
    if (!version || rendering) return false;
    try {
      await mutate(async () => {
        const result = await api<LayerChangeResult>(`/api/versions/${encodeURIComponent(version.id)}/layers/${encodeURIComponent(layer.id)}/changes`, 'POST', input);
        setData(state => state ? { ...state, comments: [...state.comments, result.comment], ops: [...state.ops, result.op] } : state);
        if (!selectedId) draftFrame.current = liveFrame.current;
        setSelectedId(result.comment.id); setSelectedRangeIndex(0); setPreviewOpId(null); setFeedbackRevealToken(value => value + 1);
        setCurrentFrame(result.comment.contextFrame ?? result.comment.frameIn); setFocusFrameToken(token => token + 1);
      });
      setNotice(`${input.action === 'remove' ? '제거' : '수정'} 요청을 저장했습니다. 요청 카드에서 승인한 뒤 실행하세요.`);
      return true;
    } catch { return false; }
  }, [version?.id, rendering, mutate, selectedId]);
  const onSupplement = useCallback(async (id: string, text: string) => {
    try { await mutate(async () => { const comment = await api<Comment>(`/api/comments/${id}/supplements`, 'POST', { text }); setData(state => state ? { ...state, comments: state.comments.map(item => item.id === id ? comment : item), ops: state.ops.filter(op => op.commentId !== id) } : state); }); setNotice('보완 내용을 저장했습니다. 내보낼 피드백에 함께 포함됩니다.'); return true; }
    catch { return false; }
  }, [mutate]);
  const onEditComment = useCallback(async (id: string, patch: { text: string; sceneDescription: string; category?: FeedbackCategory }) => {
    if (feedbackMutationInFlight.current) return false;
    feedbackMutationInFlight.current = true;
    try {
      await mutate(async () => {
        const comment = await api<Comment>(`/api/comments/${id}`, 'PATCH', patch);
        setData(state => state ? { ...state, comments: state.comments.map(item => item.id === id ? comment : item), ops: state.comments.find(item => item.id === id)?.updatedAt === comment.updatedAt ? state.ops : state.ops.filter(op => op.commentId !== id) } : state);
      });
      setNotice('피드백을 수정했습니다. 시간·그림·첨부는 유지됩니다.'); return true;
    } catch { return false; }
    finally { feedbackMutationInFlight.current = false; }
  }, [mutate]);
  const onDeleteComment = useCallback(async (id: string) => {
    if (feedbackMutationInFlight.current) return false;
    feedbackMutationInFlight.current = true;
    try {
      await mutate(async () => {
        const deleted = await api<Comment>(`/api/comments/${id}`, 'DELETE');
        setData(state => state ? { ...state, comments: state.comments.filter(item => item.id !== id), deletedComments: [...(state.deletedComments ?? []).filter(item => item.id !== id), deleted], ops: state.ops.filter(op => op.commentId !== id) } : state);
        if (selectedId === id) { setSelectedId(null); setSelectedRangeIndex(0); setPreviewOpId(null); setCurrentFrame(draftFrame.current); setFocusFrameToken(value => value + 1); }
      });
      setUndoDeleteId(id); setNotice('피드백을 휴지통으로 옮겼습니다.'); return true;
    } catch { return false; }
    finally { feedbackMutationInFlight.current = false; }
  }, [mutate, selectedId]);
  const onRestoreComment = useCallback(async (id: string) => {
    if (feedbackMutationInFlight.current) return false;
    feedbackMutationInFlight.current = true;
    try {
      await mutate(async () => {
        const comment = await api<Comment>(`/api/comments/${id}/restore`, 'POST', {});
        setData(state => state ? { ...state, comments: [...state.comments.filter(item => item.id !== id), comment].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), deletedComments: (state.deletedComments ?? []).filter(item => item.id !== id) } : state);
      });
      setUndoDeleteId(null); setNotice('피드백과 첨부 자료를 복구했습니다.'); return true;
    } catch { return false; }
    finally { feedbackMutationInFlight.current = false; }
  }, [mutate]);
  async function onSubmit(text: string, attachmentIds: string[], voiceAssetId?: string, anchor?: RequestAnchor, options: RequestOptions = { kind: 'request', interpretNow: false }) {
    if (!version) return;
    const target = anchor ?? range;
    await mutate(async () => {
      const anchoredDrawings = (anchor?.drawings ?? drawings).map(drawing => ({ ...drawing, frame: drawingFrame(drawing, anchor?.contextFrame ?? drawingContext.current) }));
      const comment = await api<Comment>('/api/comments', 'POST', { versionId: version.id, frameIn: target.in, frameOut: target.out, contextFrame: anchor?.contextFrame ?? currentFrame, kind: options.kind, category: options.category, sceneDescription: options.sceneDescription, text, drawings: anchoredDrawings, attachmentIds, voiceAssetId });
      setData(state => state ? { ...state, comments: [...state.comments, comment] } : state);
      setSelectedId(comment.id); setSelectedRangeIndex(0); setDrawings([]); resetDrawingHistory(); setRange({ in: comment.frameIn, out: comment.frameOut });
      drawingContext.current = comment.contextFrame ?? comment.frameIn; draftFrame.current = drawingContext.current; setCurrentFrame(drawingContext.current); setFocusFrameToken(token => token + 1);
      if (editingMode && options.interpretNow && options.kind === 'request') {
        try { acceptInterpretation(await api<InterpretResult>(`/api/comments/${comment.id}/interpret`, 'POST', {})); }
        catch (error) { setError(`요청은 저장했습니다. 카드의 ‘요청 해석’으로 다시 시도하세요. ${(error as Error).message}`); }
      } else setNotice(options.kind === 'note' ? '메모를 저장했습니다.' : '피드백을 저장했습니다. 내용을 모아 전달 자료로 내보낼 수 있습니다.');
    });
  }
  const selectVersion = useCallback(async (target: Version) => {
    if (layerDraftOpen || supplementDraft) return false;
    if (target.id === version?.id) return true;
    if (draftPending && target.id !== version?.id) { setError('작성 중인 요청을 먼저 저장하세요.'); return false; }
    try { await mutate(async () => { const project = await api<Project>('/api/project', 'PATCH', { activeVersionId: target.id }); setData(state => state ? { ...state, project } : state); }); const next = Math.min(liveFrame.current, target.durationFrames - 1); draftFrame.current = next; drawingContext.current = next; setCurrentFrame(next); setRange({ in: next, out: next + 1 }); setSelectedId(null); setDrawings([]); resetDrawingHistory(); setPreviewOpId(null); setFeedbackAnchorMode('point'); return true; } catch { return false; }
  }, [mutate, draftPending, version?.id, resetDrawingHistory, layerDraftOpen, supplementDraft]);
  const selectComment = useCallback((comment: Comment, rangeIndex?: number, reveal = false, focusFrame?: number) => {
    if (!data || !version || busy || loadingFile || composerActive || layerDraftOpen) return;
    setPreviewOpId(null);
    if (!selectedId) draftFrame.current = liveFrame.current;
    const origin = data.versions.find(v => v.id === comment.versionId);
    const projected = projectComment(comment, origin, version);
    const index = rangeIndex ?? Math.max(0, projected.ranges.findIndex(item => projected.contextFrame !== null && projected.contextFrame >= item.frameIn && projected.contextFrame < item.frameOut));
    setSelectedId(comment.id); setSelectedRangeIndex(index);
    if (reveal) { setFeedbackPanelOpen(true); setFeedbackRevealToken(value => value + 1); }
    // Detailed drawing tracks can point outside the comment's range, including a surviving drawing after a cut.
    const explicitFrame = focusFrame !== undefined && Number.isFinite(focusFrame) ? Math.max(0, Math.min(version.durationFrames - 1, Math.round(focusFrame))) : undefined;
    const targetFrame = explicitFrame ?? (projected.status === 'deleted' ? null : rangeIndex === undefined ? projected.contextFrame ?? projected.ranges[index]?.frameIn : projected.ranges[index]?.frameIn);
    if (targetFrame !== null && targetFrame !== undefined) { setCurrentFrame(targetFrame); setFocusFrameToken(token => token + 1); }
    if (projected.status === 'deleted') setNotice('이 요청의 구간은 현재 버전에서 삭제됐습니다. 작성 버전에서 확인할 수 있습니다.');
    else if (projected.status === 'unavailable') setNotice('현재 버전에 표시할 요청 구간을 확인할 수 없습니다. 작성 버전에서 확인하세요.');
  }, [data?.versions, version, selectedId, busy, loadingFile, composerActive, layerDraftOpen]);
  const selectAuthored = useCallback((comment: Comment) => {
    if (!data || busy || loadingFile || composerActive || layerDraftOpen) return;
    const origin = data.versions.find(item => item.id === comment.versionId);
    if (!origin) { setError('요청을 작성한 버전을 찾을 수 없습니다.'); return; }
    if (origin.id === version?.id) { selectComment(comment); return; }
    void selectVersion(origin).then(changed => {
      if (!changed) return;
      setSelectedId(comment.id); setSelectedRangeIndex(0); setPreviewOpId(null);
      setCurrentFrame(comment.contextFrame ?? comment.frameIn); setFocusFrameToken(token => token + 1);
    });
  }, [data?.versions, busy, loadingFile, composerActive, layerDraftOpen, version?.id, selectVersion, selectComment]);
  const composeAtPlayhead = useCallback((focus = true) => {
    if (!version || busy || loadingFile || composerActive || layerDraftOpen) return;
    const plan = planPlayerCompose({
      liveFrame: workspacePlaybackRef.current?.pauseAndReadFrame() ?? liveFrame.current,
      durationFrames: version.durationFrames,
      reviewing: Boolean(selectedComment), draftReturnable, draftFrame: draftFrame.current,
      range, anchorMode: feedbackAnchorMode,
    });
    if (!plan) return;
    if (plan.action === 'new') {
      setRange(plan.range); setFeedbackAnchorMode(plan.anchorMode);
      setDrawings([]); resetDrawingHistory(); drawingContext.current = plan.frame;
    }
    draftFrame.current = plan.frame;
    setFeedbackPanelOpen(true);
    setSelectedId(null); setPreviewOpId(null); setCurrentFrame(plan.frame); setFocusFrameToken(token => token + 1);
    if (focus) requestAnimationFrame(() => textareaRef.current?.focus());
    return plan.frame;
  }, [version, busy, loadingFile, composerActive, layerDraftOpen, selectedComment, draftReturnable, range, feedbackAnchorMode, resetDrawingHistory]);
  const toggleFeedbackPanel = useCallback(() => {
    const open = !feedbackPanelOpen;
    setFeedbackPanelOpen(open);
    requestAnimationFrame(() => (open ? feedbackCollapseRef.current : feedbackExpandRef.current)?.focus({ preventScroll: true }));
  }, [feedbackPanelOpen]);
  const feedbackHeaderActions = useMemo(() => <>
    <button type="button" className="feedback-compose-action" disabled={busy || loadingFile || composerActive || layerDraftOpen} onClick={() => composeAtPlayhead()} title={selectedComment && draftReturnable ? '작성 중인 초안으로 돌아가기 (C)' : '현재 시점에 댓글 쓰기 (C)'} aria-keyshortcuts="C">
      {selectedComment && draftReturnable ? <CornerUpLeft size={16}/> : <SquarePen size={16}/>}<span>{selectedComment && draftReturnable ? '초안으로' : '댓글 쓰기'}</span><kbd aria-hidden="true">C</kbd>
    </button>
    <button ref={feedbackCollapseRef} type="button" className="feedback-panel-toggle" aria-label="댓글 패널 접기" aria-expanded={feedbackPanelOpen} aria-controls="feedback-panel-content" disabled={composerActive || layerDraftOpen} title="댓글 패널 접기" onClick={toggleFeedbackPanel}><PanelRightClose size={18}/></button>
  </>, [busy, loadingFile, composerActive, layerDraftOpen, selectedComment, draftReturnable, composeAtPlayhead, feedbackPanelOpen, toggleFeedbackPanel]);
  function changeAnchorMode(mode: 'point' | 'range') {
    if (!version || draftLocked) return;
    const frame = selectedComment ? composeAtPlayhead(false) : workspacePlaybackRef.current?.pauseAndReadFrame() ?? liveFrame.current;
    if (frame === undefined) return;
    setRange({ in: frame, out: Math.min(frame + 1, version.durationFrames) });
    setFeedbackAnchorMode(mode);
  }
  function clearRange() {
    if (selectedComment) { composeAtPlayhead(false); return; }
    changeAnchorMode('point');
  }
  function composeFromSaved(copyDrawings = false, copyFrame?: number) {
    if (busy || loadingFile || composerActive || layerDraftOpen) return;
    if (selectedComment && (!draftReturnable || copyDrawings && !draftPending)) {
      if (!selectedProjectedRange) { setNotice('작성 버전에서 요청 구간을 확인한 뒤 새 요청을 남겨 주세요.'); return; }
      const copyGroup = copyDrawings ? savedDrawingGroups.find(group => group.frame === copyFrame) : undefined;
      if (copyDrawings && !copyGroup) { setNotice('복사할 그림의 장면을 선택해 주세요. 삭제된 그림은 작성 버전에서 확인할 수 있습니다.'); return; }
      const draft = createProjectedRequestDraft(selectedComment, projection, selectedRangeIndex, copyDrawings, copyGroup ? { drawings: copyGroup.drawings, contextFrame: copyGroup.frame } : undefined);
      if (!draft) { setNotice('현재 버전에서 요청 구간과 그림 위치를 확인해 주세요.'); return; }
      setRange({ in: draft.in, out: draft.out });
      setFeedbackAnchorMode(draft.out - draft.in > 1 ? 'range' : 'point');
      setDrawings(draft.drawings);
      resetDrawingHistory();
      drawingContext.current = draft.contextFrame;
      draftFrame.current = drawingContext.current;
    }
    if (!selectedComment && !draftReturnable) draftFrame.current = currentFrame;
    setFeedbackPanelOpen(true); setSelectedId(null); setPreviewOpId(null); setCurrentFrame(draftFrame.current); setFocusFrameToken(token => token + 1);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }
  const closeOverlayPreview = useCallback(() => setPreviewOpId(null), []);
  const previewOp = data?.ops.find(op => op.id === previewOpId && op.versionId === version?.id);
  const previewAsset = data?.attachments.find(asset => asset.id === previewOp?.params.assetRef);
  const imageOverlay = useMemo<ImageOverlayPreview|null>(() => previewOp?.params.kind === 'image' && !previewOp.layerChange && previewAsset ? {
    id: previewOp.id, assetUrl: previewAsset.mediaUrl, name: previewAsset.name,
    region: previewOp.region ?? { x: 0.12, y: 0.16, w: 0.76, h: 0.22 },
    editable: !busy && !rendering && !layerDraftOpen && !supplementDraft && previewOp.status !== 'applied',
    onRegionChange: region => supplementDraft ? Promise.resolve(false) : onOp(previewOp.id, { region, status: 'proposed' }), onClose: closeOverlayPreview,
  } : null, [previewOp, previewAsset, busy, rendering, layerDraftOpen, supplementDraft, onOp, closeOverlayPreview]);
  const previewOverlay = useCallback((id: string) => {
    if (busy || loadingFile || composerActive || rendering || layerDraftOpen) return;
    const op = data?.ops.find(item => item.id === id);
    const comment = data?.comments.find(item => item.id === op?.commentId);
    const target = data?.versions.find(item => item.id === op?.versionId);
    if (!op || !comment || !target || op.layerChange) return;
    const openPreview = () => { if (!selectedId) draftFrame.current = liveFrame.current; setSelectedId(comment.id); setSelectedRangeIndex(0); setCurrentFrame(comment.contextFrame ?? comment.frameIn); setFocusFrameToken(token => token + 1); setPreviewOpId(id); };
    if (op.versionId !== version?.id) void selectVersion(target).then(changed => { if (changed) openPreview(); });
    else openPreview();
  }, [data?.ops, data?.comments, data?.versions, version?.id, selectVersion, selectedId, busy, loadingFile, composerActive, rendering, layerDraftOpen]);
  async function insertDrawings() {
    if (!drawings.length || busy || rendering || composerActive || voiceAnchorLocked || layerDraftOpen) return;
    if (groupDrawings(drawings, drawingContext.current).length > 1) { setNotice('그림을 요청으로 저장한 뒤, 영상에 넣을 장면의 그림을 새 요청으로 복사하세요.'); return; }
    try { await onSubmit('이 그림과 도형을 그대로 영상에 넣어줘', [], undefined, undefined, { kind: 'request', interpretNow: true }); setNotice('그림 삽입 요청을 저장했습니다. 카드에서 해석 결과를 확인하세요.'); } catch { /* displayed */ }
  }
  async function render() {
    if (!version || approved.length === 0 || rendering || composerActive || layerDraftOpen || supplementDraft || draftPending) return;
    setBusy(true); setError('');
    try { const result = await api<RenderJob>('/api/render', 'POST', { parentVersionId: version.id, opIds: approved.map(op => op.id) }); setJob(result); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function cancelRender() {
    if (!job || !rendering || job.cancelRequested) return;
    setBusy(true); setError('');
    try { setJob(await api<RenderJob>(`/api/jobs/${job.id}/cancel`, 'POST', {})); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function importFile(file: File) {
    if (draftPending || supplementDraft || layerDraftOpen) { setError('작성 중인 요청과 그래픽 수정을 먼저 저장하거나 취소하세요.'); return; }
    setLoadingFile(true); setError('');
    try { await upload('/api/assets', file, file.name); setData(null); setEmpty(false); initialized.current = false; const imported = await load(); if ('empty' in imported) return; setCurrentFrame(0); setRange({ in: 0, out: 1 }); setSelectedId(null); setDrawings([]); resetDrawingHistory(); setPreviewOpId(null); setCompare(false); setFeedbackAnchorMode('point'); setExportResult(null); setNotice('영상을 가져왔습니다. 구간을 선택하고 요청을 남겨보세요.'); } catch (e) { setError((e as Error).message); } finally { setLoadingFile(false); }
  }
  const previous = data?.versions.find(v => v.id === version?.parentVersionId) ?? data?.versions.find(v => v.id !== version?.id && v.status === 'ready');
  if (empty) return <VideoStart busy={loadingFile} error={error} onImport={importFile} onError={setError}/>;
  if (!data || !version) return <div className="boot"><span className="wordmark">INTERFERENCE</span><LoaderCircle className="spinning"/><p>{error || '로컬 영상을 준비하고 있습니다.'}</p>{error ? <button className="primary" onClick={() => void load().catch(e => setError((e as Error).message))}>다시 연결</button> : null}</div>;
  return <div className="app-shell">
    <header className="app-header">
      <div className="brand-block"><span className="wordmark">INTERFERENCE</span></div>
      <div className="breadcrumb"><span>시간별 피드백</span><span>/</span><span title={data.project.name}>{data.project.name}</span></div>
      <div className="header-actions">
        <input type="file" accept="video/*" hidden ref={fileRef} onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file); e.target.value = ''; }}/>
        <details className="workspace-more"><summary aria-label="추가 작업 옵션"><MoreHorizontal size={18}/><span>더 보기</span></summary><div><button className="quiet" aria-pressed={editingMode} disabled={busy || loadingFile || composerActive || layerDraftOpen || rendering} onClick={() => { setEditingMode(value => !value); setPreviewOpId(null); setCompare(false); }} title="명령 해석·승인·영상 렌더 기능 표시">{editingMode ? '편집 기능 닫기' : '편집 기능'}</button></div></details>
        <button className="secondary" onClick={() => fileRef.current?.click()} disabled={loadingFile || rendering || busy || composerActive || draftPending || supplementDraft || layerDraftOpen}>{loadingFile ? <LoaderCircle size={16} className="spinning"/> : <FolderOpen size={16}/>}영상 열기</button>
        {editingMode ? <button className="secondary render-button" disabled={!approved.length || rendering || busy || loadingFile || composerActive || layerDraftOpen || supplementDraft || draftPending} onClick={() => void render()}>{rendering ? <LoaderCircle size={16} className="spinning"/> : <Play size={15} fill="currentColor"/>}{rendering ? job?.cancelRequested ? '취소 중' : `렌더 중 ${Math.round(job?.progress ?? 0)}%` : '승인한 요청 실행'}{approved.length && !rendering ? <span className="button-count">{approved.length}</span> : null}</button> : null}
        {rendering ? <button className="secondary" disabled={busy || job?.cancelRequested} onClick={() => void cancelRender()}><Square size={13}/>{job?.cancelRequested ? '취소 중' : '렌더 취소'}</button> : null}
        <button className="primary" disabled={!data.comments.length || busy || loadingFile || composerActive || rendering || draftPending || supplementDraft || layerDraftOpen} onClick={() => void exportFeedback()} title={draftPending || supplementDraft ? '작성 중인 피드백을 먼저 저장하세요.' : '저장한 피드백 전체를 타임코드·스틸·그림과 묶습니다. 영상 파일은 포함하지 않습니다.'}><Package size={16}/>피드백 내보내기</button>
      </div>
    </header>
    <ResizableWorkspace projectOpen={projectPanelOpen} feedbackOpen={feedbackPanelOpen}>
      <aside className="version-rail" aria-label="프로젝트 패널">
        <div className="rail-collapse-heading"><button type="button" className="rail-collapse-toggle" aria-label={projectPanelOpen ? '프로젝트 패널 접기' : '프로젝트 패널 펼치기'} aria-expanded={projectPanelOpen} aria-controls="project-panel-content" title={projectPanelOpen ? '프로젝트 접기' : '프로젝트 펼치기'} onClick={() => setProjectPanelOpen(value => !value)}>{projectPanelOpen ? <PanelLeftClose size={19}/> : <PanelLeftOpen size={19}/>}</button>{projectPanelOpen ? <span>프로젝트</span> : null}</div>
        {!projectPanelOpen ? <nav className="collapsed-project-tools" aria-label="프로젝트 빠른 메뉴"><button type="button" title="버전 기록" aria-label="버전 기록 펼치기" onClick={() => setProjectPanelOpen(true)}><Layers size={18}/></button><button type="button" title="첨부 보관함" aria-label="첨부 보관함" onClick={() => setShowAssets(true)}><Package size={18}/></button><button type="button" title="휴지통" aria-label="피드백 휴지통" onClick={() => setTrashOpen(true)}><Trash2 size={18}/></button></nav> : null}
        <div id="project-panel-content" className="version-rail-content" hidden={!projectPanelOpen}><div className="project-selected"><Film size={18}/><span>{data.project.name}</span></div><div className="rail-heading version-heading"><Layers size={18}/><span>버전 기록</span></div><div className="version-list">{data.versions.filter(v => v.status === 'ready').map(v => <button key={v.id} className={`version-card ${v.id === version.id ? 'active' : ''}`} onClick={() => void selectVersion(v)} disabled={busy || loadingFile || composerActive || draftPending || supplementDraft || layerDraftOpen}><div><strong>v{v.number} {v.number === 1 ? '원본' : '편집본'}</strong><span>{time(v.durationFrames).split('.')[0]}</span></div><img src={v.thumbnailUrl} alt={`버전 ${v.number} 미리보기`}/><small>{v.number === 1 ? '원본 보존' : v.appliedOpIds ? `이번 변경 ${v.appliedOpIds.length}개` : `편집 ${v.opIds.length}개`}</small></button>)}</div><button className="rail-link" onClick={() => setShowAssets(!showAssets)}><Package size={17}/>에셋<span>{data.attachments.length || ''}</span></button><button className="rail-link" onClick={() => setTrashOpen(true)}><Trash2 size={17}/>휴지통<span>{data.deletedComments?.length || ''}</span></button><div className="rail-bottom"><ShieldCheck size={15}/><span>로컬 프로젝트</span></div></div></aside>
      <section className="workspace-shell"><div className="workspace-heading"><div><strong>v{version.number} {version.number === 1 ? '원본' : '편집본'}</strong><span>{data.asset.width} × {data.asset.height} · 30 fps</span></div><div className="workspace-actions">{editingMode ? <button className={`quiet ${compare ? 'mint-text' : ''}`} disabled={!previous} onClick={() => setCompare(!compare)}><Columns2 size={15}/>{compare ? '비교 닫기' : '비교'}</button> : null}{editingMode ? <a className="quiet" aria-label="현재 버전 MP4 다운로드" href={`${version.mediaUrl}${version.mediaUrl.includes('?') ? '&' : '?'}download=1`} download><Download size={15}/><span>영상 받기</span></a> : null}</div></div><VideoWorkspace playbackRef={workspacePlaybackRef} version={version} versions={data.versions} asset={data.asset} comments={data.comments} attachments={data.attachments} selectedCommentId={selectedId} selectedRangeIndex={selectedRangeIndex} currentFrame={currentFrame} focusFrameToken={focusFrameToken} onFrameChange={frame => { setCurrentFrame(frame); if (!selectedComment) draftFrame.current = frame; }} range={reviewRange} rangeActive={rangeActive} onRangeClear={clearRange} onRangeStart={() => changeAnchorMode('range')} rangeAvailable={!selectedComment || Boolean(selectedProjectedRange)} composeLabel={draftReturnable && selectedComment ? '초안으로 돌아가기' : selectedComment || feedbackAnchorMode === 'point' ? '현재 시점에 피드백' : '선택 구간에 피드백'} onRangeChange={next => { if (!selectedComment && !draftLocked) { setRange(next); setFeedbackAnchorMode('range'); } }} drawings={selectedComment ? selectedDrawings : drawings} onDrawingsChange={next => { if (!selectedComment && !draftLocked) setDrawings(next); }} editingLocked={busy || loadingFile || composerActive || layerDraftOpen || (!selectedComment && voiceAnchorLocked)} editingLockLabel={voiceAnchorLocked ? '음성의 구간·그림 고정 · 작성창에서 녹음 저장 상태를 확인하세요' : undefined} drawingHistoryKey={`${version.id}:draft:${drawingGeneration}`} onDrawingHistoryChange={setDrawingHistoryAvailable} annotationsReadOnly={Boolean(selectedComment)} annotationFrame={selectedComment ? projection?.contextFrame ?? undefined : drawingContext.current} onSelectComment={(comment, rangeIndex, frame) => selectComment(comment, rangeIndex, true, frame)} onDrawingCreate={frame => {drawingContext.current=frame;}} onCompose={() => composeAtPlayhead()} onInsertDrawings={!editingMode || selectedComment ? undefined : () => void insertDrawings()} imageOverlay={imageOverlay} compareVersion={compare ? previous : null}/></section>
      <aside className="request-rail" aria-label="댓글 패널">
        {!feedbackPanelOpen ? <div className="request-rail-tools"><button ref={feedbackExpandRef} type="button" className="rail-collapse-toggle feedback-panel-toggle" aria-label="댓글 패널 펼치기" aria-expanded={false} aria-controls="feedback-panel-content" disabled={composerActive || layerDraftOpen} title="댓글 패널 펼치기" onClick={toggleFeedbackPanel}><PanelRightOpen size={18}/></button></div> : null}
        <div id="feedback-panel-content" className="request-rail-content" hidden={!feedbackPanelOpen}>{editingMode ? <LayerPanel version={version} originalVersion={data.versions.find(item => item.parentVersionId === null) ?? data.versions[0]} asset={data.asset} attachments={data.attachments} busy={busy || loadingFile || composerActive || Boolean(rendering)} onChange={onLayerChange} onDraftChange={setLayerDraftOpen} pendingChanges={data.ops} onSelectChange={op => { const comment = data.comments.find(item => item.id === op.commentId); if (comment) { selectComment(comment); setFeedbackRevealToken(value => value + 1); } }} onSeek={frame => { if (!selectedComment) draftFrame.current = frame; setCurrentFrame(frame); setFocusFrameToken(token => token + 1); }}/> : null}<RequestPanel headerActions={feedbackHeaderActions} keyboardEnabled={feedbackPanelOpen} editingMode={editingMode} revealToken={feedbackRevealToken} comments={data.comments} versions={data.versions} currentVersion={version} onSelectAuthored={selectAuthored} onDraftChange={setSupplementDraft} ops={data.ops} selectedId={selectedId} busy={busy || !!rendering || loadingFile || composerActive || layerDraftOpen} onSelect={selectComment} onOp={onOp} onInterpret={onInterpret} onPrepareContextBundle={onPrepareContextBundle} onSupplement={onSupplement} onEditComment={onEditComment} onDeleteComment={onDeleteComment} attachments={data.attachments} previewOpId={previewOpId} onPreviewOverlay={previewOverlay}/>{selectedComment ? <details className="saved-context-details" key={selectedComment.id}><summary>선택한 댓글 · 구간·마크업 재사용</summary><SavedRequestContext comment={selectedComment} projection={projection} drawingGroups={savedDrawingGroups} deletedDrawingCount={drawingProjections.filter(item => item.status === 'deleted').length} unavailableDrawingCount={drawingProjections.filter(item => item.status === 'unavailable').length} currentVersionNumber={version.number} selectedRangeIndex={selectedRangeIndex} hasDraft={draftPending} hasDrawingHistory={drawingHistoryAvailable} busy={busy || loadingFile || composerActive || layerDraftOpen} onRangeSelect={index => selectComment(selectedComment, index, true)} onCompose={composeFromSaved}/></details> : null}
        <Composer onBeginWriting={() => selectedComment ? composeAtPlayhead(false) : workspacePlaybackRef.current?.pauseAndReadFrame()} anchorMode={selectedComment && !draftReturnable ? 'point' : feedbackAnchorMode} onAnchorModeChange={changeAnchorMode} onClearRange={() => changeAnchorMode('point')} editingMode={editingMode} key={version.id} range={range} currentFrame={selectedComment && draftReturnable ? draftFrame.current : currentFrame} drawingContextFrame={drawingContext.current} drawings={drawings} busy={busy || loadingFile || layerDraftOpen} textareaRef={textareaRef} onSubmit={onSubmit} onError={setError} onActivityChange={setComposerActive} onAnchorLockChange={setVoiceAnchorLocked} onDraftChange={setDraftContent}/>
        <div className="interpreter-note"><Info size={14}/><span>{editingMode ? data.capabilities.interpreterLabel : '타임코드와 마크업을 댓글에 함께 저장합니다.'}</span></div></div></aside>
    </ResizableWorkspace>
    <footer className="status-bar"><div><ShieldCheck size={17}/>원본 보존<button className="quiet shortcut-trigger" title="단축키 (?)" onClick={() => setShortcutsOpen(true)}><Keyboard size={15}/>단축키</button></div><div>{rendering ? <><span className="render-progress"><span style={{ width: `${job?.progress ?? 0}%` }}/></span>새 버전 렌더 중</> : <><span>피드백·메모 {data.comments.length}개</span>{editingMode ? <span>승인 {approved.length}개</span> : <span>로컬 자료 준비</span>}</>}</div></footer>
    <ShortcutDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)}/>
    <FeedbackTrashDialog open={trashOpen} comments={data.deletedComments ?? []} busy={busy || loadingFile || !!rendering} onClose={() => setTrashOpen(false)} onRestore={onRestoreComment}/>
    <FeedbackExportDialog open={exportOpen} busy={busy && exportInFlight.current} result={exportResult} error={exportError} onClose={() => { if (!exportInFlight.current) setExportOpen(false); }} onRetry={() => void exportFeedback()}/>
    {error ? <div className="feedback error" role="alert"><span>{error}</span><button className="quiet" onClick={() => void load().then(() => setError('')).catch(e => setError((e as Error).message))}>다시 연결</button><button onClick={() => setError('')} aria-label="오류 메시지 닫기"><X size={16}/></button></div> : null}
    {notice ? <div className="feedback notice" role="status"><span>{notice}</span>{undoDeleteId && notice === '피드백을 휴지통으로 옮겼습니다.' ? <button className="feedback-undo" disabled={busy} onClick={() => void onRestoreComment(undoDeleteId)}><RotateCcw size={14}/>되돌리기</button> : null}<button onClick={() => setNotice('')} aria-label="알림 닫기"><X size={16}/></button></div> : null}
    {showAssets ? <div className="drawer-scrim" onClick={() => setShowAssets(false)}><section className="asset-drawer" role="dialog" aria-modal="true" aria-label="에셋 보관함" onClick={e => e.stopPropagation()}><div className="panel-heading"><h2>에셋 보관함</h2><button className="quiet" onClick={() => setShowAssets(false)} aria-label="에셋 보관함 닫기"><X size={18}/></button></div><p className="subtle">참고 자료와 영상에 넣을 에셋을 구분합니다.</p>{data.attachments.length === 0 ? <p>요청 작성 영역에서 이미지를 첨부하거나 음성을 녹음하세요.</p> : data.attachments.map(a => <a className="asset-row" href={a.mediaUrl} target="_blank" rel="noreferrer" key={a.id}>{a.mimeType.startsWith('image/') ? <img src={a.mediaUrl} alt=""/> : <FileIcon/>}<div><strong>{a.name}</strong><small>{a.role === 'reference' ? '스타일 참고' : a.role === 'insert' ? '영상에 삽입' : '편집 지시 음성'}</small></div></a>)}</section></div> : null}
  </div>;
}
function FileIcon() { return <Package size={24}/>; }
