import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, Video, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { api } from '../api';
import './VertexImageDialog.css';

type VideoJobStatus = 'submitting' | 'pending' | 'checking' | 'completed' | 'failed' | 'interrupted';
interface VideoJob { id: string; status: VideoJobStatus; createdAt: string; error?: string; videoUrl?: string }
interface VideoJobList { enabled: boolean; jobs: VideoJob[] }
interface Props { open: boolean; onClose: () => void }

const API_PATH = '/api/vertex-video/jobs';
const PENDING_KEY = 'vertex-video-pending-request-v1';
const STATUS: Record<VideoJobStatus, string> = { submitting: '제출 중', pending: '생성 중', checking: '상태 확인 중', completed: '완료', failed: '실패', interrupted: '결과 확인 필요' };

function pendingFromSession(): string | null {
  try { return sessionStorage.getItem(PENDING_KEY); } catch { return null; }
}

function rememberPending(id: string | null): void {
  try { if (id) sessionStorage.setItem(PENDING_KEY, id); else sessionStorage.removeItem(PENDING_KEY); } catch { /* The in-memory guard still prevents duplicate clicks. */ }
}

function safeVideoUrl(job: VideoJob): string | null {
  return job.videoUrl === `${API_PATH}/${job.id}/video` && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.id) ? job.videoUrl : null;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '시간 확인 불가' : date.toLocaleString('ko-KR');
}

export function VertexVideoDialog({ open, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const checkingRef = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<VideoJobList | null>(null);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  useLayoutEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    pendingRef.current = pendingRef.current || pendingFromSession();
    setPending(pendingRef.current);
    setLoading(true);
    const poll = async () => {
      try {
        const next = await api<VideoJobList>(API_PATH);
        if (stopped) return;
        setSnapshot(next);
        setError('');
        if (pendingRef.current && next.jobs.some(job => job.id === pendingRef.current)) {
          pendingRef.current = null; setPending(null); rememberPending(null);
        }
      } catch {
        if (!stopped) setError('작업 목록을 확인하지 못했습니다. 서버 연결을 확인해 주세요.');
      } finally {
        if (!stopped) { setLoading(false); timer = setTimeout(() => void poll(), 3000); }
      }
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [open, refreshTick]);

  async function submit() {
    if (inFlight.current || pendingRef.current || !snapshot?.enabled || snapshot.jobs.some(job => ['submitting', 'pending', 'checking'].includes(job.status)) || !prompt.trim() || prompt.length > 2000) return;
    let id: string;
    try { id = crypto.randomUUID(); } catch { setError('안전한 요청 ID를 만들 수 없습니다. 브라우저를 확인해 주세요.'); return; }
    inFlight.current = true; pendingRef.current = id; setPending(id); rememberPending(id); setSubmitting(true); setError('');
    try {
      const job = await api<VideoJob>(API_PATH, 'POST', { requestId: id, prompt: prompt.trim() });
      setSnapshot(current => current ? { ...current, jobs: [job, ...current.jobs.filter(item => item.id !== job.id)] } : current);
      if (job.id === id) { pendingRef.current = null; setPending(null); rememberPending(null); setPrompt(''); }
      else setError('요청 상태를 확인하지 못했습니다. 목록을 확인해 주세요.');
    } catch {
      setError('요청 결과를 확인하지 못했습니다. 중복 요청을 보내지 않고 작업 목록을 확인합니다.');
    } finally {
      inFlight.current = false; setSubmitting(false); setRefreshTick(value => value + 1);
    }
  }

  async function checkStatus(id: string) {
    if (checkingRef.current || inFlight.current || !snapshot?.enabled) return;
    checkingRef.current = true; setChecking(true); setError('');
    try {
      const job = await api<VideoJob>(`${API_PATH}/${id}/check`, 'POST', {});
      setSnapshot(current => current ? { ...current, jobs: current.jobs.map(item => item.id === id ? job : item) } : current);
    } catch { setError('상태 조회 결과를 확인하지 못했습니다. 목록을 다시 확인해 주세요.'); }
    finally { checkingRef.current = false; setChecking(false); setRefreshTick(value => value + 1); }
  }

  const running = snapshot?.jobs.some(job => ['submitting', 'pending', 'checking'].includes(job.status)) ?? false;
  const canSubmit = snapshot?.enabled === true && !loading && !error && !pending && !submitting && !running && prompt.trim().length > 0 && prompt.length <= 2000;

  return <dialog ref={dialog} className="vertex-image-dialog" aria-labelledby="vertex-video-title"
    onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose} onKeyDown={event => event.stopPropagation()}>
    <header><div><span>Google Vertex AI</span><h2 id="vertex-video-title"><Video size={20} />영상 생성</h2></div>
      <button className="quiet" aria-label="영상 생성 닫기" onClick={onClose}><X size={20} /></button></header>
    <p className="vertex-image-intro">설명 텍스트를 Google에 전송해 4초 영상을 생성합니다. 기존 영상·이미지·음성 파일은 전송하지 않습니다.</p>
    <p className="vertex-image-cost">생성 요청에는 비용이 발생할 수 있습니다. 결과나 실패 여부와 관계없이 요금이 발생할 수 있으며, 크레딧 적용과 금액은 청구 내역에서 확인하세요.</p>
    {snapshot && !snapshot.enabled ? <p className="vertex-image-disabled" role="status">영상 생성이 비활성화되어 있습니다. 서버의 Vertex 프로젝트와 인증 설정을 확인해 주세요.</p> : null}
    <label className="vertex-image-label" htmlFor="vertex-video-prompt">만들고 싶은 영상 설명</label>
    <textarea id="vertex-video-prompt" value={prompt} maxLength={2000} onChange={event => setPrompt(event.target.value)} placeholder="예: 숲 위로 천천히 떠오르는 아침 햇살" disabled={submitting} />
    <div className="vertex-image-entry"><small>{prompt.length.toLocaleString()} / 2,000자</small>
      <button className="primary" disabled={!canSubmit} onClick={() => void submit()}>{submitting ? <LoaderCircle size={16} className="spinning" /> : <Video size={16} />}영상 생성</button></div>
    <p className="vertex-image-note">생성된 영상은 재생과 다운로드로 제공됩니다. 영상이나 프로젝트 첨부에 자동으로 추가하지 않습니다.</p>
    {error ? <p className="vertex-image-error" role="alert">{error}</p> : null}
    {pending ? <div className="vertex-image-pending" role="status"><p>요청 결과가 확인되지 않았습니다. 자동 재시도하지 않습니다. 아래 작업 목록에서 먼저 확인해 주세요.</p>
      <button className="secondary" onClick={() => setRefreshTick(value => value + 1)}><RefreshCw size={14} />목록 확인</button>
      {!submitting && !loading && !snapshot?.jobs.some(job => job.id === pending) ? <button className="quiet" onClick={() => { pendingRef.current = null; setPending(null); rememberPending(null); }}>확인 후 새 요청 준비</button> : null}
      <small>새 요청을 보내면 별도 요금이 발생할 수 있습니다.</small></div> : null}
    <section className="vertex-image-jobs" aria-labelledby="vertex-video-jobs-title"><div className="vertex-image-jobs-heading"><h3 id="vertex-video-jobs-title">생성 작업</h3>{loading ? <span role="status">목록 확인 중</span> : null}</div>
      {snapshot && !snapshot.jobs.length ? <p className="vertex-image-empty">아직 생성한 영상이 없습니다.</p> : null}
      {snapshot?.jobs.map(job => { const video = safeVideoUrl(job); return <article key={job.id} className="vertex-image-job">
        <div className="vertex-image-job-heading"><strong>{STATUS[job.status] ?? '상태 확인 필요'}</strong><time dateTime={job.createdAt}>{formatTime(job.createdAt)}</time></div>
        {['submitting', 'checking'].includes(job.status) ? <p>생성 중입니다. 창을 닫아도 서버에서 진행합니다.</p> : null}
        {job.status === 'pending' ? <><p>생성이 진행 중일 수 있습니다. 상태 확인은 기존 작업을 조회하며 새 영상을 생성하지 않습니다.</p>{job.error ? <p role="status">{job.error}</p> : null}<button className="secondary" disabled={checking} onClick={() => void checkStatus(job.id)}><RefreshCw size={14}/>상태 확인</button></> : null}
        {job.status === 'interrupted' ? <p>앱이 중단되어 결과와 과금 여부를 확인해야 합니다. 자동으로 다시 요청하지 않습니다.</p> : null}
        {job.status === 'failed' ? <p>{job.error || '생성 결과를 확인하지 못했습니다. 요금이 발생했을 수 있습니다.'}</p> : null}
        {job.status === 'completed' && video ? <><video controls preload="none" src={video} aria-label="생성된 영상 재생" /><a className="secondary vertex-image-download" href={`${video}?download=1`} download><Download size={15} />영상 받기</a></> : null}
        {job.status === 'completed' && !video ? <p>생성 결과의 위치를 확인하지 못했습니다.</p> : null}
      </article>; })}
    </section>
  </dialog>;
}
