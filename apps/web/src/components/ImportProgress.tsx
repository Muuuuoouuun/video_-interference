import { LoaderCircle, X } from 'lucide-react';
import { importProgressLabel, type ImportStage } from '../../../../packages/core/import-progress.mjs';
import './ImportProgress.css';

export interface ImportProgressState { name: string; stage: ImportStage; progress: number; sentBytes: number; totalBytes: number; stageStartedAt: number }

interface Props { state: ImportProgressState; onCancel?: () => void; now?: number; className?: string }

/** One line of import state: which step, how far, and a cancel that keeps the current project. */
export function ImportProgress({ state, onCancel, now = Date.now(), className = '' }: Props) {
  const label = importProgressLabel({ ...state, stageElapsedMs: now - state.stageStartedAt });
  return <div className={`import-progress ${className}`} role="status" aria-live="polite">
    <LoaderCircle size={16} className="spinning" aria-hidden="true"/>
    <div className="import-progress-copy">
      <strong><span className="import-progress-step">{label.step}/3</span>{label.title}{label.indeterminate ? null : <span className="import-progress-percent">{label.percent}%</span>}</strong>
      <span className="import-progress-detail" title={state.name}>{state.name}{label.detail ? ` · ${label.detail}` : ''}</span>
      <div className={`import-progress-track${label.indeterminate ? ' import-progress-indeterminate' : ''}`} role="progressbar" aria-label={label.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={label.indeterminate ? undefined : label.percent}><span style={label.indeterminate ? undefined : { width: `${label.percent}%` }}/></div>
    </div>
    {onCancel ? <button type="button" className="quiet import-progress-cancel" onClick={onCancel} title="가져오기를 취소합니다. 지금 작업 중인 프로젝트는 바뀌지 않습니다."><X size={14}/>취소</button> : null}
  </div>;
}
