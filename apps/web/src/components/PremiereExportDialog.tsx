import { useLayoutEffect, useRef } from 'react';
import { Download, LoaderCircle, X } from 'lucide-react';
import './FeedbackExportDialog.css';

export interface PremiereExportResult {
  manifestUrl: string;
  archiveUrl: string;
  pluginUrl: string;
  commentCount: number;
  overlayCount: number;
  unplacedCount: number;
  timelineSegmentCount: number;
  skippedOverlayCount: number;
}

interface Props {
  open: boolean;
  busy: boolean;
  result: PremiereExportResult | null;
  error: string;
  onClose: () => void;
  onRetry: () => void;
}

export function PremiereExportDialog({ open, busy, result, error, onClose, onRetry }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return <dialog ref={dialog} className="feedback-export-dialog" aria-labelledby="premiere-export-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClose={onClose} onKeyDown={event => event.stopPropagation()}>
    <header><div><span>댓글 · 시간 · 마크업</span><h2 id="premiere-export-title">Premiere 연동</h2></div>
      <button className="quiet" disabled={busy} aria-label="Premiere 연동 닫기" onClick={onClose}><X size={20} /></button></header>
    {busy ? <p className="feedback-export-status" role="status"><LoaderCircle size={19} className="spinning" />댓글과 투명 배경 마크업을 준비하고 있습니다.</p>
      : error ? <div className="feedback-export-status"><p role="alert">{error}</p><button className="secondary" onClick={onRetry}>다시 준비</button></div>
        : result ? <>
          <p className="feedback-export-summary">댓글 <strong>{result.commentCount}개</strong> · 오버레이 <strong>{result.timelineSegmentCount}구간</strong></p>
          <p className="feedback-export-description">영상과 장면 스틸 없이 시간·좌표·그림만 전달합니다. 참고 이미지와 음성은 제외됩니다. AI 호출과 외부 전송은 없습니다.</p>
          <div className="feedback-export-actions">
            <a className="primary" href={`${result.archiveUrl}?download=1`} download><Download size={16} />영상 위 오버레이 묶음</a>
            <a className="secondary" href={`${result.manifestUrl}?download=1`} download>댓글 연결 파일만</a>
          </div>
          <p className="feedback-export-description">묶음의 압축을 풀고 Premiere 패널에서 폴더를 여세요. 같은 영상 버전의 시퀀스를 연결한 뒤 ‘파일·배치 확인 → 오버레이 적용’을 누르면 영상 위 빈 트랙에 배치됩니다. 댓글 IN–OUT 동안 표시하고 다음 그림 시점에 전환합니다. 시점 댓글은 한 프레임입니다.</p>
          <p className="feedback-export-copy-status">같은 해상도·정사각형 픽셀 시퀀스가 필요합니다. 적용 후 묶음 폴더를 이동하거나 삭제하지 마세요. 도형은 투명 PNG 클립으로 전달됩니다.</p>
          {result.skippedOverlayCount ? <p className="feedback-export-copy-status">삭제된 장면 또는 댓글 구간 밖의 그림 {result.skippedOverlayCount}묶음은 배치에서 제외하고 자료에 보존했습니다.</p> : null}
          <details className="premiere-setup"><summary>처음 연결하기 · Premiere 패널 설치</summary>
            <p className="feedback-export-description">Premiere 25.6 이상과 UXP Developer Tool 2.2 이상이 필요합니다. 패널 ZIP을 풀고, Premiere의 플러그인 개발자 모드를 켠 뒤 UXP Developer Tool에서 manifest.json을 추가해 Load를 누르세요.</p>
            <div className="feedback-export-links"><a href={`${result.pluginUrl}?download=1`} download>개발용 패널 ZIP 받기</a></div>
            <p className="feedback-export-copy-status">설치 후 Premiere의 Window → UXP Plugins → Video Interference에서 엽니다. 자세한 안내는 패널 묶음에 포함되어 있습니다.</p>
          </details>
          {result.unplacedCount ? <p className="feedback-export-copy-status" role="status">삭제되었거나 위치를 확정할 수 없는 댓글 {result.unplacedCount}개는 자료에 보존하고 마커로 배치하지 않습니다.</p> : null}
          {!result.commentCount ? <p className="feedback-export-copy-status">빈 자료입니다. 다시 가져와 갱신하면 이 프로젝트·버전에서 만든 연동 마커를 정리합니다.</p> : null}
        </> : null}
  </dialog>;
}
