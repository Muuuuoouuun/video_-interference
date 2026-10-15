import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileText, Image, LoaderCircle, Mic, X, ZoomIn } from 'lucide-react';
import type { Attachment } from '../../../../packages/core/types';
import './AttachmentGallery.css';

/** onTranscribe appears only when local speech-to-text is configured; it is always an explicit user action. */
interface Props { attachments: Attachment[]; onRemove?: (id: string) => void; disabled?: boolean; compact?: boolean; onTranscribe?: (id: string) => Promise<void>; transcribingId?: string | null }
const roleLabels = { reference: '참고 이미지', insert: '영상 삽입', voice: '음성 피드백' };

/** Same attachment treatment while composing and reviewing saved feedback. */
export function AttachmentGallery({ attachments, onRemove, disabled = false, compact = false, onTranscribe, transcribingId = null }: Props) {
  const galleryId = useId();
  const titleId = `${galleryId}-preview-title`, imageListId = `${galleryId}-images`;
  const [expanded, setExpanded] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const images = attachments.filter(item => item.role !== 'voice' && item.mimeType.startsWith('image/'));
  const otherAttachments = attachments.filter(item => item.role === 'voice' || !item.mimeType.startsWith('image/'));
  const previewIndex = images.findIndex(item => item.id === previewId);
  const preview = images[previewIndex];
  const collapsible = compact && !onRemove && images.length > 4;
  const visibleImages = collapsible && !expanded ? images.slice(0, 4) : images;
  const dialog = useRef<HTMLDialogElement>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const focusContainer = useRef<HTMLElement | null>(null);
  function returnFocus() {
    const trigger = previewTrigger.current, container = focusContainer.current;
    previewTrigger.current = null; focusContainer.current = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    else if (container?.isConnected) container.querySelector<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    if (preview && !dialog.current?.open) dialog.current?.showModal();
    if (!preview && dialog.current?.open) { dialog.current.close(); returnFocus(); }
    if (!preview && previewId !== null) setPreviewId(null);
  }, [preview, previewId]);
  useLayoutEffect(() => () => {
    if (dialog.current?.open) { dialog.current.close(); returnFocus(); }
  }, []);
  function openPreview(id: string, trigger: HTMLButtonElement) {
    previewTrigger.current = trigger;
    focusContainer.current = trigger.closest<HTMLElement>('article, form');
    setPreviewId(id);
  }
  function movePreview(offset: number) {
    const next = images[previewIndex + offset];
    if (next) setPreviewId(next.id);
  }
  const caption = (attachment: Attachment) => <figcaption><div><small>{roleLabels[attachment.role]}</small><strong title={attachment.name}>{attachment.name}</strong></div>{onRemove ? <button type="button" className="attachment-remove" disabled={disabled} aria-label={`${attachment.name} 첨부 제거`} title="첨부 제거" onClick={() => onRemove(attachment.id)}><X size={16}/></button> : null}</figcaption>;
  return <>
    {images.length > 0 ? <div className={`attachment-image-section${compact ? ' attachment-image-section-compact' : ''}`}>
      <div className="attachment-section-heading"><Image size={13}/><span>이미지 <strong>{images.length}</strong></span></div>
      <div id={imageListId} className={`attachment-gallery${compact ? ' attachment-gallery-compact' : ''}`} aria-label={`첨부 이미지 ${images.length}장`}>
        {visibleImages.map(attachment => <figure className="attachment-tile" key={attachment.id}>
          <button type="button" className="attachment-thumbnail" aria-label={`${attachment.name} 크게 보기`} onClick={event => openPreview(attachment.id, event.currentTarget)}><img src={attachment.mediaUrl} alt={attachment.name} loading="lazy" decoding="async"/><span><ZoomIn size={15}/>크게 보기</span></button>
          {caption(attachment)}
        </figure>)}
      </div>
      {collapsible ? <button type="button" className="attachment-expand" aria-expanded={expanded} aria-controls={imageListId} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}<span>{expanded ? '접기 · 4장만 보기' : `나머지 ${images.length - 4}장 더 보기`}</span><small>총 {images.length}장</small></button> : null}
    </div> : null}
    {otherAttachments.length > 0 ? <div className="attachment-audio-gallery" aria-label="음성 및 기타 첨부 자료">
      {otherAttachments.map(attachment => <figure className={`attachment-tile${attachment.role === 'voice' ? ' attachment-audio' : ''}`} key={attachment.id}>
        {attachment.role === 'voice' ? <div className="attachment-audio-icon"><Mic size={18}/><span>음성 피드백</span></div> : null}
        {caption(attachment)}
        {attachment.role === 'voice' ? <audio controls preload="none" src={attachment.mediaUrl} aria-label={`${attachment.name} 음성 재생`}/> : <a className="attachment-file-link" href={attachment.mediaUrl} target="_blank" rel="noreferrer">첨부 열기<ArrowUpRight size={13}/></a>}
        {attachment.role === 'voice' && attachment.transcript?.text ? <blockquote className="attachment-transcript"><small><FileText size={12}/>자동 받아쓰기 · {attachment.transcript.engine} · 원본 음성과 대조 필요</small><p>{attachment.transcript.text}</p></blockquote> : null}
        {attachment.role === 'voice' && attachment.transcript && !attachment.transcript.text ? <p className="attachment-transcript-empty">받아쓴 말이 없습니다. 음성을 직접 확인해 주세요.</p> : null}
        {attachment.role === 'voice' && onTranscribe ? <button type="button" className="quiet attachment-transcribe" disabled={disabled || transcribingId !== null} onClick={() => void onTranscribe(attachment.id)}>{transcribingId === attachment.id ? <><LoaderCircle size={13} className="spinning"/>받아쓰는 중</> : attachment.transcript ? '다시 받아쓰기' : '로컬 받아쓰기'}</button> : null}
      </figure>)}
    </div> : null}
    {images.length > 0 || previewId !== null ? createPortal(<dialog ref={dialog} className="attachment-preview" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); setPreviewId(null); }} onClose={() => { if (!dialog.current?.open) { setPreviewId(null); returnFocus(); } }} onClick={event => { if (event.target === event.currentTarget) setPreviewId(null); }} onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); movePreview(event.key === 'ArrowLeft' ? -1 : 1); }
    }}>
      {preview ? <><header><div><Image size={18}/><div><small>{roleLabels[preview.role]}</small><h2 id={titleId}>{preview.name}</h2></div></div><button className="quiet" type="button" autoFocus aria-label="이미지 미리보기 닫기" onClick={() => setPreviewId(null)}><X size={22}/></button></header><img className="attachment-full-image" src={preview.mediaUrl} alt={preview.name}/>
        {images.length > 1 ? <div className="attachment-preview-strip" aria-label="미리볼 이미지 선택">{images.map((attachment, index) => <button type="button" key={attachment.id} aria-label={`${index + 1}번째 이미지: ${attachment.name}`} aria-pressed={attachment.id === preview.id} onClick={() => setPreviewId(attachment.id)} title={attachment.name}><img src={attachment.mediaUrl} alt="" loading="lazy" decoding="async"/></button>)}</div> : null}
        <footer><nav className="attachment-preview-navigation" aria-label="이미지 이동"><button type="button" className="quiet" aria-label="이전 이미지" title="이전 이미지 (←)" disabled={previewIndex === 0} onClick={() => movePreview(-1)}><ChevronLeft size={18}/></button><span aria-live="polite">{previewIndex + 1}<small> / {images.length}</small></span><button type="button" className="quiet" aria-label="다음 이미지" title="다음 이미지 (→)" disabled={previewIndex === images.length - 1} onClick={() => movePreview(1)}><ChevronRight size={18}/></button></nav><span className="attachment-preview-help">← → 이동 · Esc 닫기</span><a href={preview.mediaUrl} target="_blank" rel="noreferrer">원본 크기로 열기<ArrowUpRight size={14}/></a></footer></> : null}
    </dialog>, document.body) : null}
  </>;
}
