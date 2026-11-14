import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Download, FileText, LoaderCircle, X } from 'lucide-react';
import type { FeedbackExportResult } from '../../../../packages/core/types';
import './FeedbackExportDialog.css';

interface Props {
  open: boolean;
  busy: boolean;
  result: FeedbackExportResult | null;
  error: string;
  onClose: () => void;
  onRetry: () => void;
}

export function FeedbackExportDialog({ open, busy, result, error, onClose, onRetry }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [textError, setTextError] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [showText, setShowText] = useState(false);
  useLayoutEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => {
    setText(''); setTextError(false); setCopyStatus(''); setShowText(false);
    if (!open || !result) return;
    const controller = new AbortController();
    void fetch(result.markdownUrl, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('문서를 읽지 못했습니다.');
      const body = await response.text();
      if (!controller.signal.aborted) setText(body);
    }).catch(() => { if (!controller.signal.aborted) setTextError(true); });
    return () => controller.abort();
  }, [open, result]);
  async function copyText() {
    try { await navigator.clipboard.writeText(text); setCopyStatus('시간별 피드백을 복사했습니다.'); }
    catch { setShowText(true); setCopyStatus('아래 문서를 선택해 직접 복사할 수 있습니다.'); requestAnimationFrame(() => { textArea.current?.focus(); textArea.current?.select(); }); }
  }
  return <dialog ref={dialog} className="feedback-export-dialog" aria-labelledby="feedback-export-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClose={onClose} onKeyDown={event => event.stopPropagation()}>
    <header><div><span>시간별 내용과 피드백</span><h2 id="feedback-export-title">피드백 전달 자료</h2></div><button className="quiet" disabled={busy} aria-label="피드백 전달 자료 닫기" onClick={onClose}><X size={20} /></button></header>
    {busy ? <p className="feedback-export-status" role="status"><LoaderCircle size={19} className="spinning" />타임코드·스틸·그림·피드백을 묶고 있습니다.</p>
      : error ? <div className="feedback-export-status"><p role="alert">{error}</p><button className="secondary" onClick={onRetry}>다시 준비</button></div>
        : result ? <>
          <p className="feedback-export-summary">피드백·메모 <strong>{result.commentCount}개</strong>와 장면 스틸 <strong>{result.sceneCount}장</strong>을 준비했습니다.</p>
          <p className="feedback-export-description">각 시점의 장면 설명과 요청, 그림 위치 문장을 함께 전달합니다. 피드백마다 한 장 요약 이미지와 영상 전체 흐름 이미지, 그림이 표시된 스틸과 첨부 자료가 묶음에 들어갑니다. 원본·편집 영상 파일은 포함하지 않으며, 외부 전송은 없습니다.</p>
          <div className="feedback-export-actions"><a className="primary" href={`${result.archiveUrl}?download=1`} download><Download size={16} />피드백 묶음 받기</a><button className="secondary" disabled={!text} onClick={() => void copyText()}><Copy size={15} />텍스트 복사</button></div>
          <div className="feedback-export-links"><a href={`${result.markdownUrl}?download=1`} download><FileText size={13} />문서만 받기</a><a href={`${result.manifestUrl}?download=1`} download>구조화 데이터 받기</a><a href={`${result.jsonlUrl}?download=1`} download title="한 줄에 피드백 하나 · AI와 다른 도구가 먼저 읽는 글 자료">AI용 글 자료(JSONL)</a><a href={`${result.vttUrl}?download=1`} download title="기준 버전 영상 위에 피드백을 자막으로 띄웁니다">자막 형식(VTT)</a>{text ? <button className="quiet" onClick={() => setShowText(value => !value)} aria-expanded={showText}>{showText ? '문서 접기' : '문서 확인'}</button> : null}</div>
          {textError ? <p className="feedback-export-copy-status">텍스트 미리보기를 읽지 못했습니다. 문서나 묶음을 내려받아 확인할 수 있습니다.</p> : null}
          {copyStatus ? <p className="feedback-export-copy-status" role="status">{copyStatus}</p> : null}
          {showText ? <textarea ref={textArea} className="feedback-export-text" aria-label="전달할 시간별 피드백 문서" readOnly value={text} /> : null}
        </> : null}
  </dialog>;
}
