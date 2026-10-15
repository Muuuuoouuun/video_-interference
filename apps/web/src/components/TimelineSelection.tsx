import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, Clock3, X } from 'lucide-react';
import { commitTimecodeInput } from '../../../../packages/core/timecode-input.mjs';
import { time } from '../format';
import './TimelineSelection.css';

interface Props {
  frame: number; frameIn: number; frameOut: number; durationFrames: number;
  active: boolean; available: boolean; readOnly: boolean; locked: boolean; mediaError: boolean;
  onChange: (range: { in: number; out: number }) => void;
  onMark: (edge: 'in' | 'out') => void; onStart: () => void; onClear?: () => void;
}

function TimeField({ frame, edge, min, max, readOnly, locked, onCommit, onMark }: {
  frame: number; edge: 'in' | 'out'; min: number; max: number; readOnly: boolean; locked: boolean;
  onCommit: (frame: number) => void; onMark: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelCommit = useRef(false);
  // A boundary drag or mark can update the time while this input still owns focus.
  useLayoutEffect(() => { setDraft(null); cancelCommit.current = false; }, [frame]);
  const caption = edge === 'in' ? '시작' : '끝';
  const shortcut = edge === 'in' ? 'I' : 'O';
  function commit() {
    if (draft !== null && !cancelCommit.current && !locked && !readOnly) {
      const next = commitTimecodeInput(draft, frame, min, max);
      if (next !== frame) onCommit(next);
    }
    cancelCommit.current = false;
    setDraft(null);
  }
  return <div className="vi-time-field" role="group" aria-label={`구간 ${caption}`} data-readonly={readOnly}>
    {readOnly ? <span className="vi-time-field-caption">{caption}</span> : <button type="button" disabled={locked} className="vi-time-mark" onClick={onMark} aria-label={`현재 시점${edge === 'out' ? ' 다음' : ''}을 구간 ${caption} ${edge.toUpperCase()}으로`} title={`${edge.toUpperCase()} · 현재 시점${edge === 'out' ? ' 다음' : ''}으로 지정 (${shortcut})`}>{caption}<kbd>{shortcut}</kbd></button>}
    {readOnly ? <output className="vi-time-value" aria-label={`${caption} 시간`}>{time(frame)}</output> : <input
      aria-label={`구간 ${caption} 시간`} title="분:초 또는 초 단위 입력 · Enter 적용 · Esc 취소 · ↑↓ 1프레임, Shift 1초"
      type="text" inputMode="text" autoComplete="off" spellCheck={false} maxLength={24} disabled={locked}
      value={draft ?? time(frame)} onFocus={() => setDraft(time(frame))} onChange={event => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelCommit.current = true; event.currentTarget.blur(); }
        else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.altKey && !event.metaKey && !event.ctrlKey) {
          event.preventDefault(); event.stopPropagation();
          const current = commitTimecodeInput(draft ?? time(frame), frame, min, max);
          const next = Math.max(min, Math.min(max, current + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 30 : 1)));
          setDraft(time(next)); if (next !== frame) onCommit(next);
        }
      }}/>
    }
  </div>;
}

export function TimelineSelection({ frame, frameIn, frameOut, durationFrames, active, available, readOnly, locked, mediaError, onChange, onMark, onStart, onClear }: Props) {
  const length = frameOut - frameIn;
  return active ? <div className="vi-range-fields vi-selection" aria-label={readOnly ? '저장된 댓글 구간' : '피드백 구간 설정'}>
    <div className="vi-range-controls">
      <TimeField key={`in-${readOnly}`} frame={frameIn} min={0} max={frameOut - 1} edge="in" readOnly={readOnly} locked={locked} onCommit={next => onChange({ in: next, out: frameOut })} onMark={() => onMark('in')}/>
      <ArrowRight className="vi-range-direction" size={13} aria-hidden="true"/>
      <TimeField key={`out-${readOnly}`} frame={frameOut} min={frameIn + 1} max={durationFrames} edge="out" readOnly={readOnly} locked={locked} onCommit={next => onChange({ in: frameIn, out: next })} onMark={() => onMark('out')}/>
      <span className="vi-range-duration" title={`${length}프레임 · 끝 시점은 포함하지 않음`}><span>길이</span><strong>{(length / 30).toFixed(2)}</strong><span>초</span></span>
    </div>
    {onClear ? <button type="button" className="vi-range-clear" disabled={locked} onClick={onClear} title={readOnly ? '댓글 선택을 해제하고 작성 화면으로 돌아가기' : '선택 구간을 해제하고 현재 시점에 남기기'}><X size={13}/>{readOnly ? '선택 해제' : '구간 해제'}</button> : null}
  </div> : <div className="vi-point-fields vi-selection">
    <div><span className="vi-point-time"><Clock3 size={13} aria-hidden="true"/><span>현재 시점</span><strong>{time(frame)}</strong></span>{!available ? <small>선택한 피드백의 구간은 이 버전에 없습니다.</small> : null}</div>
    {readOnly ? onClear ? <button type="button" className="vi-range-clear" disabled={locked} onClick={onClear}><X size={13}/>선택 해제</button> : null : <button type="button" className="vi-range-start" disabled={locked || mediaError} onClick={onStart}>구간 지정 <span>I / O</span></button>}
  </div>;
}
