import { useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { parseTimecodeInput } from '../../../../packages/core/timecode-input.mjs';
import { time } from '../format';

export interface TimecodeSeekHandle { open: () => void; show: (frame: number) => void }
export function TimecodeSeek({ frame, durationFrames, locked, onReadFrame, onSeek, controlRef }: {
  frame: number; durationFrames: number; locked: boolean; onReadFrame: () => number;
  onSeek: (frame: number) => void; controlRef?: Ref<TimecodeSeekHandle>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const shown = useRef<HTMLElement>(null);
  const skipBlur = useRef(false);
  const restoreFocus = useRef(false);
  const open = () => { if (!locked) { skipBlur.current = false; setError(''); setDraft(time(onReadFrame())); } };
  // Playback writes the same text node React owns; React's next differing value still replaces it.
  const show = (next: number) => { const node = shown.current?.firstChild; const text = time(next); if (node && node.nodeValue !== text) node.nodeValue = text; };
  useImperativeHandle(controlRef, () => ({ open, show }));
  useLayoutEffect(() => {
    if (draft !== null) { input.current?.focus(); input.current?.select(); }
    else if (restoreFocus.current) { restoreFocus.current = false; button.current?.focus({ preventScroll: true }); }
  }, [draft === null]);
  function commit(enter: boolean) {
    if (draft === null || skipBlur.current) return;
    const next = parseTimecodeInput(draft);
    if (next === null && enter) { setError('분:초 또는 초를 입력하세요.'); input.current?.select(); return; }
    skipBlur.current = true; restoreFocus.current = enter; setDraft(null); setError('');
    if (next !== null && !locked) onSeek(Math.min(next, durationFrames - 1));
  }
  return <div className="vi-timecode vi-seek-timecode">
    {draft === null ? <button ref={button} className="vi-current-time" disabled={locked} onClick={open} aria-label={`시간으로 이동 · 현재 ${time(frame)}`} title="클릭하여 시간 입력 (G) · 분:초 또는 초"><strong ref={shown}>{time(frame)}</strong></button>
      : <input ref={input} aria-label="재생 위치 시간 입력" aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} title="분:초 또는 초 · Enter 이동 · Esc 취소" value={draft} disabled={locked} maxLength={24} autoComplete="off" spellCheck={false}
        onChange={event => { setDraft(event.target.value); setError(''); }} onBlur={() => commit(false)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit(true); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); skipBlur.current = true; restoreFocus.current = true; setDraft(null); setError(''); }
        }}/>}<span>/ {time(durationFrames)}</span>
    {error ? <small id={errorId} className="vi-timecode-error" role="alert">{error}</small> : null}
  </div>;
}
