import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Paperclip, Mic, Square, Send, LoaderCircle, Clock3, Plus, ChevronUp, X, PencilLine } from 'lucide-react';
import type { Attachment, Drawing } from '../../../../packages/core/types';
import { time } from '../format';
import { upload } from '../api';
import { acquireMicrophone, stopMicrophone } from '../../../../packages/core/microphone-session.mjs';
import { createPendingVoiceUpload, type PendingVoiceSession, type PendingVoiceUpload } from '../../../../packages/core/pending-voice-upload.mjs';
import { drawingFrame, groupDrawings } from '../../../../packages/core/drawing-anchors.mjs';
import { IMAGE_ATTACHMENT_LIMIT, commentAttachmentInput } from '../../../../packages/core/comment-attachments.mjs';
import { AttachmentGallery } from './AttachmentGallery';
import './Composer.css';
export interface RequestAnchor { in: number; out: number; contextFrame?: number; drawings?: Drawing[] }
export interface RequestOptions { kind: 'request' | 'note'; interpretNow: boolean; sceneDescription?: string }
interface Props { range: { in: number; out: number }; currentFrame:number; drawingContextFrame?: number; drawings: Drawing[]; busy: boolean; editingMode?: boolean; anchorMode?: 'point' | 'range'; onAnchorModeChange?: (mode: 'point' | 'range') => void; onClearRange?: () => void; onBeginWriting?: () => number | undefined; textareaRef: React.RefObject<HTMLTextAreaElement | null>; onSubmit: (text: string, attachmentIds: string[], voiceId?: string, anchor?: RequestAnchor, options?: RequestOptions) => Promise<void>; onError: (message: string) => void; onActivityChange?: (active: boolean) => void; onAnchorLockChange?: (locked: boolean) => void; onDraftChange?: (hasContent: boolean) => void }
export function Composer({ range, currentFrame, drawingContextFrame, drawings, busy, editingMode = false, anchorMode = 'point', onAnchorModeChange, onClearRange, onBeginWriting, textareaRef, onSubmit, onError, onActivityChange, onAnchorLockChange, onDraftChange }: Props) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsId = useId();
  const [text, setText] = useState('');
  const [sceneDescription, setSceneDescription] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [role, setRole] = useState('reference');
  const [kind, setKind] = useState<'request'|'note'>('request');
  const [interpretNow, setInterpretNow] = useState(false);
  const [recording, setRecording] = useState(false);
  const [requestingMicrophone, setRequestingMicrophone] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [pendingVoice, setPendingVoice] = useState<PendingVoiceUpload<RequestAnchor> | null>(null);
  const [saving, setSaving] = useState(false);
  const [draggingImage, setDraggingImage] = useState(false);
  const imageUploadInFlight = useRef(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder|null>(null);
  const microphoneRequest = useRef<AbortController|null>(null);
  const mounted = useRef(true);
  const streamRef = useRef<MediaStream|null>(null);
  const voiceAnchor = useRef<RequestAnchor|undefined>(undefined);
  const voiceUpload = useRef<PendingVoiceSession<RequestAnchor> | null>(null);
  if (!voiceUpload.current) voiceUpload.current = createPendingVoiceUpload<RequestAnchor, Attachment>({
    upload: recording => upload<Attachment>('/api/attachments', recording.blob, recording.name, 'voice'),
    onChange: setPendingVoice,
    onSaved: (attachment, anchor) => {
      voiceAnchor.current = anchor;
      setAttachments(items => [...items.filter(item => item.role !== 'voice'), attachment]);
    },
  });
  const submitting = useRef(false);
  const uploading = uploadingImage || pendingVoice?.status === 'uploading';
  const hasContent = Boolean(text.trim() || drawings.length || attachments.length);
  const hasDraft = hasContent || Boolean(sceneDescription.trim()) || Boolean(pendingVoice);
  const canSubmit = hasContent || kind === 'note' && Boolean(sceneDescription.trim());
  const hasVoice = attachments.some(attachment => attachment.role === 'voice');
  const imageCount = attachments.filter(attachment => attachment.role !== 'voice').length;
  const usingPoint = anchorMode === 'point';
  const effectiveRange = usingPoint ? { in: currentFrame, out: currentFrame + 1 } : range;
  const displayedRange = pendingVoice?.anchor ?? (hasVoice && voiceAnchor.current ? voiceAnchor.current : effectiveRange);
  const displayPoint = hasVoice || pendingVoice ? displayedRange.out - displayedRange.in === 1 : usingPoint;
  const displayedContextFrame = pendingVoice?.anchor.contextFrame ?? (hasVoice ? voiceAnchor.current?.contextFrame : undefined) ?? currentFrame;
  const activeOptions = [sceneDescription.trim() ? '장면 설명' : '', kind === 'note' ? '메모로 저장' : '', editingMode && kind === 'request' && interpretNow ? '저장 후 해석' : '', editingMode && role === 'insert' ? '이미지 삽입' : ''].filter(Boolean);
  const anchorLocked = busy || saving || recording || requestingMicrophone || uploading || hasVoice || Boolean(pendingVoice);
  const fallbackDrawingFrame = drawingContextFrame ?? currentFrame;
  const drawingGroups = useMemo(() => groupDrawings(drawings, fallbackDrawingFrame), [drawings, fallbackDrawingFrame]);
  useEffect(() => { onDraftChange?.(hasDraft); }, [hasDraft, onDraftChange]);
  useEffect(() => { if (!editingMode) setInterpretNow(false); }, [editingMode]);
  useEffect(() => { onActivityChange?.(recording || requestingMicrophone || uploading || saving); }, [recording, requestingMicrophone, uploading, saving, onActivityChange]);
  useEffect(() => { onAnchorLockChange?.(hasVoice || Boolean(pendingVoice)); }, [hasVoice, pendingVoice, onAnchorLockChange]);
  useEffect(() => () => { onAnchorLockChange?.(false); }, [onAnchorLockChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; voiceUpload.current?.release(); microphoneRequest.current?.abort(); if (recorder.current?.state === 'recording') { recorder.current.onstop = null; recorder.current.stop(); } stopMicrophone(streamRef.current); onActivityChange?.(false); }; }, [onActivityChange]);
  function captureAnchor(): RequestAnchor {
    const contextFrame = onBeginWriting?.() ?? currentFrame;
    const captureRange = usingPoint ? { in: contextFrame, out: contextFrame + 1 } : range;
    return { ...captureRange, contextFrame, drawings: structuredClone(drawings.map(drawing => ({ ...drawing, frame: drawingFrame(drawing, drawingContextFrame ?? currentFrame) }))) };
  }
  async function attachFiles(files: File[]) {
    if (busy || saving || uploading || recording || requestingMicrophone || imageUploadInFlight.current) return;
    const images = files.filter(file => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type));
    if (!images.length) { onError('PNG, JPG, WebP 이미지를 선택해 주세요.'); return; }
    const available = Math.max(0, IMAGE_ATTACHMENT_LIMIT - imageCount);
    if (images.length > available) { onError(`이미지는 최대 ${IMAGE_ATTACHMENT_LIMIT}장까지 첨부할 수 있습니다. 현재 ${imageCount}장, 추가 가능 ${available}장입니다. 이번에 선택한 파일은 업로드하지 않았습니다.`); return; }
    if (images.length !== files.length) onError(`PNG, JPG, WebP 외의 파일 ${files.length - images.length}개는 제외됩니다.`);
    setOptionsOpen(true);
    onBeginWriting?.();
    const fileRole = editingMode ? role : 'reference';
    imageUploadInFlight.current = true;
    setUploadingImage(true);
    try {
      for (const file of images) {
        try {
          const attachment = await upload<Attachment>('/api/attachments', file, file.name || '참고 이미지.png', fileRole);
          if (!mounted.current) return;
          setAttachments(items => [...items, attachment]);
        } catch (error) { if (mounted.current) onError(`${file.name}: ${(error as Error).message}`); }
      }
    } finally { imageUploadInFlight.current = false; if (mounted.current) setUploadingImage(false); }
  }
  async function toggleRecording() {
    if (recording) { if (recorder.current?.state === 'recording') recorder.current.stop(); return; }
    if (microphoneRequest.current || busy || saving || submitting.current || uploading || voiceUpload.current?.pending) return;
    const control = new AbortController(); microphoneRequest.current = control; setRequestingMicrophone(true);
    try {
      const anchor = captureAnchor();
      const stream = await acquireMicrophone(constraints => navigator.mediaDevices.getUserMedia(constraints), control.signal);
      if (!stream) return;
      if (!mounted.current) { stopMicrophone(stream); return; }
      streamRef.current = stream;
      const chunks: BlobPart[] = []; const rec = new MediaRecorder(stream); recorder.current = rec;
      rec.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      rec.onstop = () => { stopMicrophone(stream); streamRef.current = null; if (mounted.current) { setRecording(false); if (voiceUpload.current?.stage(new Blob(chunks, { type: rec.mimeType }), `음성지시-${Date.now()}.webm`, anchor)) void voiceUpload.current.retry(); } };
      rec.start(); setRecording(true);
    } catch { stopMicrophone(streamRef.current); streamRef.current = null; if (mounted.current) onError('마이크를 사용할 수 없습니다. 텍스트로 요청을 남길 수 있습니다.'); }
    finally { if (microphoneRequest.current === control) microphoneRequest.current = null; if (mounted.current) setRequestingMicrophone(false); }
  }
  async function submit() {
    if (!canSubmit || busy || uploading || recording || requestingMicrophone || submitting.current || voiceUpload.current?.pending) return;
    submitting.current = true;
    setSaving(true);
    try { const { attachmentIds, voiceAssetId } = commentAttachmentInput(attachments); await onSubmit(text.trim(), attachmentIds, voiceAssetId, voiceAssetId ? voiceAnchor.current : captureAnchor(), {kind,interpretNow:editingMode && kind === 'request' && interpretNow,sceneDescription:sceneDescription.trim() || undefined}); setText(''); setSceneDescription(''); setAttachments([]); setOptionsOpen(false); setKind('request'); setInterpretNow(false); setRole('reference'); voiceAnchor.current = undefined; } catch { /* Keep the description, feedback and attachments available for retry. */ } finally { submitting.current = false; if (mounted.current) setSaving(false); }
  }
  return <div className="composer-wrap"><form className={`composer${draggingImage ? ' composer-dragging' : ''}`}
    onPaste={event => { const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); void attachFiles(images); } }}
    onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDraggingImage(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = busy || uploading || saving || recording || requestingMicrophone ? 'none' : 'copy'; } }}
    onDragLeave={event => { if (event.dataTransfer.types.includes('Files')) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDraggingImage(false); } }}
    onDrop={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); dragDepth.current = 0; setDraggingImage(false); void attachFiles(Array.from(event.dataTransfer.files)); }}
    onSubmit={e => { e.preventDefault(); void submit(); }}>
    <input hidden type="file" multiple accept="image/png,image/jpeg,image/webp" ref={inputRef} onChange={event => { const files = Array.from(event.target.files ?? []); if (files.length) void attachFiles(files); event.target.value = ''; }}/>
    <div className="composer-context">
      <span className="composer-time-chip"><Clock3 size={13}/><span>{hasVoice || pendingVoice ? '음성 기준' : '현재 시점'}</span><strong>{time(displayPoint ? displayedRange.in : displayedContextFrame)}</strong></span>
      {!displayPoint ? <span className="composer-range-chip"><span>구간</span><strong>{time(displayedRange.in)} – {time(displayedRange.out)}</strong><button type="button" aria-label="선택 구간 해제" title="구간을 해제하고 현재 시점에 남기기" disabled={anchorLocked || !onClearRange && !onAnchorModeChange} onClick={() => onClearRange ? onClearRange() : onAnchorModeChange?.('point')}><X size={13}/></button></span> : <button type="button" className="composer-select-range" disabled={anchorLocked || !onAnchorModeChange} onClick={() => onAnchorModeChange?.('range')}>구간 지정</button>}
    </div>
    {drawings.length > 0 ? <div className="composer-drawing-context"><PencilLine size={12}/><span>그림 {drawings.length}개 · {drawingGroups.length}개 장면{drawingGroups.some(group => group.frame < displayedRange.in || group.frame >= displayedRange.out) ? ' · 다른 시점의 참고 그림 포함' : ''}</span></div> : null}
    <label className="composer-feedback-field"><textarea disabled={busy || saving} ref={textareaRef} aria-label={kind === 'note' ? '메모 내용' : '피드백 내용'} placeholder={kind === 'note' ? '이 장면에 기억해 둘 내용을 적어 주세요.' : '이 장면에서 바꾸고 싶은 내용을 적어 주세요.'} maxLength={5000} value={text} onFocus={() => onBeginWriting?.()} onChange={event => setText(event.target.value)} onKeyDown={event => { if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !event.repeat && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void submit(); } }}/></label>
    <AttachmentGallery attachments={attachments} disabled={busy || saving || uploading || recording || requestingMicrophone || Boolean(pendingVoice)} onRemove={id => setAttachments(items => items.filter(item => item.id !== id))}/>
    {uploadingImage ? <div className="composer-upload-status" role="status"><LoaderCircle size={14} className="spinning"/>이미지를 첨부하고 있습니다…</div> : null}
    {recording || requestingMicrophone ? <div className={`composer-voice-active${recording ? ' is-recording' : ''}`} role="status"><span>{recording ? <Mic size={14}/> : <LoaderCircle size={14} className="spinning"/>}{recording ? '녹음 중 · 시작한 시간과 그림 고정' : '마이크 권한을 확인하고 있습니다…'}</span>{recording ? <button type="button" onClick={() => void toggleRecording()} aria-label="녹음 종료"><Square size={12}/>녹음 종료</button> : null}</div> : null}
    {pendingVoice ? <div className="composer-pending-voice" role={pendingVoice.status === 'failed' ? 'alert' : 'status'}><strong>{pendingVoice.status === 'uploading' ? '음성 피드백 저장 중…' : '녹음을 아직 저장하지 못했습니다.'}</strong><p>{pendingVoice.status === 'failed' ? `${pendingVoice.error} ` : ''}음성과 기준 장면을 이 화면에 보관하고 있습니다.{hasVoice ? ' 기존 음성 첨부도 유지됩니다.' : ''}</p><div><button type="button" className="secondary" disabled={busy || saving || uploading} onClick={() => void voiceUpload.current?.retry()}>다시 저장</button><button type="button" className="quiet" disabled={busy || saving || uploading} onClick={() => voiceUpload.current?.discard()}>이번 녹음 버리기</button></div></div> : hasVoice ? <p className="composer-voice-lock">음성의 시간·그림이 고정되어 있습니다. 바꾸려면 음성 첨부를 제거하세요.</p> : null}
    {!optionsOpen && activeOptions.length > 0 ? <div className="composer-option-summary" aria-label="설정된 추가 옵션">{activeOptions.map(option => <button key={option} type="button" onClick={() => setOptionsOpen(true)} title={option === '장면 설명' ? sceneDescription : '추가 옵션 열기'}>{option}</button>)}</div> : null}
    {optionsOpen ? <div id={optionsId} className="composer-options">
      <div className="composer-kind" role="group" aria-label="저장할 내용 종류"><span>저장 방식</span><button type="button" aria-pressed={kind === 'request'} className={kind === 'request' ? 'active' : ''} disabled={busy || saving || recording || requestingMicrophone || uploading} onClick={() => setKind('request')}>피드백</button><button type="button" aria-pressed={kind === 'note'} className={kind === 'note' ? 'active' : ''} disabled={busy || saving || recording || requestingMicrophone || uploading} onClick={() => setKind('note')}>메모</button></div>
      <label className="composer-scene-field"><span>장면 내용 <small>선택</small></span><input disabled={busy || saving} aria-label="장면 내용 (선택)" maxLength={500} value={sceneDescription} onFocus={() => onBeginWriting?.()} onChange={event => setSceneDescription(event.target.value)} placeholder="예: 제품을 들어 보이며 이름을 설명하는 장면" /></label>
      <div className="composer-attachment-options"><div className="attachment-actions"><button type="button" className="composer-add-attachment" aria-label={editingMode ? '이미지 첨부' : '참고 이미지 추가'} disabled={busy || saving || uploading || recording || requestingMicrophone} onClick={() => inputRef.current?.click()}><Paperclip size={15}/>이미지</button><button type="button" className="composer-add-attachment" disabled={busy || saving || uploading || recording || requestingMicrophone || Boolean(pendingVoice)} aria-label="음성 피드백 녹음" onClick={() => void toggleRecording()}><Mic size={15}/>음성</button></div>{editingMode ? <label className="composer-attachment-role"><span>이미지 용도</span><select aria-label="첨부 이미지 역할" disabled={busy || saving || uploading || recording || requestingMicrophone} value={role} onChange={event => setRole(event.target.value)}><option value="reference">참고</option><option value="insert">영상에 삽입</option></select></label> : null}</div>
      <div className="composer-input-hints"><span><strong className="composer-image-count" aria-live="polite">이미지 {imageCount}/{IMAGE_ATTACHMENT_LIMIT}</strong> · 음성 별도</span><span>이미지 끌어 놓기·붙여넣기 가능</span></div>
      {editingMode && kind === 'request' ? <label className="composer-interpret"><input type="checkbox" checked={interpretNow} disabled={busy || saving || recording || requestingMicrophone || uploading} onChange={event => setInterpretNow(event.target.checked)}/>저장 후 바로 해석</label> : null}
    </div> : null}
    {sceneDescription.trim() && !hasContent && !pendingVoice && kind === 'request' ? <p className="composer-scene-only">피드백을 더 적거나, 추가 옵션에서 메모를 선택해 장면 내용만 저장하세요.</p> : null}
    <div className="composer-actions"><button type="button" className={`composer-options-toggle${optionsOpen ? ' active' : ''}`} aria-expanded={optionsOpen} aria-controls={optionsId} onClick={() => setOptionsOpen(value => !value)}>{optionsOpen ? <ChevronUp size={14}/> : <Plus size={14}/>}추가 옵션</button><span className="composer-save-shortcut" title="⌘ 또는 Ctrl + Enter로 저장">⌘ / Ctrl ↵</span><button type="submit" className="primary" disabled={!canSubmit || busy || saving || uploading || recording || requestingMicrophone || Boolean(pendingVoice)}>{busy || saving || uploading ? <LoaderCircle size={15} className="spinning"/> : <Send size={15}/>} {kind === 'note' ? '메모 저장' : editingMode && interpretNow ? '저장하고 해석' : '피드백 저장'}</button></div>
  </form></div>;
}
