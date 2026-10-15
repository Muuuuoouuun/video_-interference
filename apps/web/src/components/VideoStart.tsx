import { useRef, useState } from 'react';
import { Clock3, FileText, Film, FolderOpen, LoaderCircle, ShieldCheck } from 'lucide-react';
import './VideoStart.css';

interface Props {
  busy: boolean;
  error: string;
  onImport: (file: File) => Promise<void>;
  onError: (message: string) => void;
}

const videoExtension = /\.(mp4|mov|webm|mkv|m4v)$/i;

/** First-run surface only; the parent owns project creation and media validation. */
export function VideoStart({ busy, error, onImport, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);
  const dragDepth = useRef(0);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const unavailable = busy || importing;

  async function importFiles(files: File[]) {
    if (busy || importingRef.current) return;
    if (files.length !== 1) { onError('영상은 한 번에 하나만 열 수 있습니다. 파일 하나를 선택해 주세요.'); return; }
    const file = files[0];
    if (!file.type.startsWith('video/') && !(file.type === '' && videoExtension.test(file.name))) {
      onError('영상 파일을 선택해 주세요. MP4, MOV, WebM, MKV, M4V 파일을 열 수 있습니다.');
      return;
    }
    importingRef.current = true;
    setImporting(true);
    onError('');
    try { await onImport(file); }
    catch (failure) { onError(failure instanceof Error ? failure.message : '영상을 열지 못했습니다. 다른 영상 파일로 다시 시도해 주세요.'); }
    finally { importingRef.current = false; setImporting(false); }
  }

  return <div className="video-start">
    <header className="video-start-header"><span className="wordmark">INTERFERENCE</span><span><ShieldCheck size={15}/>개인 작업 공간</span></header>
    <main className="video-start-main">
      <div className="video-start-intro"><h1>장면에 피드백을 남기세요</h1><p>바꾸고 싶은 순간을 짚고, 글과 그림으로 설명하세요.<br/>시간·장면·요청을 함께 담은 전달 자료로 정리합니다.</p></div>
      <section className={`video-start-dropzone${dragging && !unavailable ? ' video-start-dragging' : ''}`} aria-label="첫 영상 열기" aria-busy={unavailable}
        onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; if (!unavailable) setDragging(true); } }}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = unavailable ? 'none' : 'copy'; } }}
        onDragLeave={event => { if (event.dataTransfer.types.includes('Files')) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); } }}
        onDrop={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); dragDepth.current = 0; setDragging(false); void importFiles(Array.from(event.dataTransfer.files)); }}>
        <div className="video-start-file-icon">{unavailable ? <LoaderCircle size={30} className="spinning"/> : <Film size={30}/>}</div>
        <div className="video-start-drop-copy"><h2>{unavailable ? '영상을 준비하고 있습니다' : dragging ? '여기에 영상을 놓으세요' : '첫 영상을 열어볼까요'}</h2><p role={unavailable ? 'status' : undefined}>{unavailable ? '영상 정보와 미리보기를 준비하는 동안 잠시 기다려 주세요.' : 'PC의 영상 파일 하나를 끌어 놓거나 선택하세요.'}</p><small>지원 범위 · 최대 10분 / 2GB · 파일 형식은 가져올 때 확인합니다.</small></div>
        <input ref={inputRef} hidden type="file" accept="video/*" disabled={unavailable} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void importFiles(files); }}/>
        <button type="button" className="primary video-start-open" disabled={unavailable} onClick={() => inputRef.current?.click()}><FolderOpen size={18}/>{unavailable ? '준비 중' : '영상 열기'}</button>
      </section>
      {error ? <div className="video-start-error" role="alert">{error}</div> : null}
      <ol className="video-start-steps">
        <li><span className="video-start-step-number">01</span><div><strong><Film size={17}/>영상 열기</strong><p>PC의 영상을 보며<br/>수정할 장면을 찾으세요.</p></div></li>
        <li><span className="video-start-step-number">02</span><div><strong><Clock3 size={17}/>시점에 피드백 남기기</strong><p>한 순간이나 구간에<br/>글·그림·참고 이미지를 붙이세요.</p></div></li>
        <li><span className="video-start-step-number">03</span><div><strong><FileText size={17}/>전달 자료로 내보내기</strong><p>시간별 피드백과 장면 스틸을<br/>문서와 ZIP으로 정리하세요.</p></div></li>
      </ol>
      <p className="video-start-local"><ShieldCheck size={16}/><span>원본 영상은 이 PC에 보관됩니다. 전달 자료에는 피드백·스틸·그림·첨부를 담습니다.</span></p>
    </main>
  </div>;
}
