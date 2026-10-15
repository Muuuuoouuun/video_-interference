import { memo, useEffect, useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import type { Version } from '../../../../packages/core/types';
import './TimelineFilmstrip.css';

interface Filmstrip {
  versionId: string;
  durationFrames: number;
  fps: 30;
  imageUrl: string;
  cellWidth: number;
  cellHeight: number;
  frames: number[];
}

function validFilmstrip(value: Filmstrip, version: Version): boolean {
  return value?.versionId === version.id && value.durationFrames === version.durationFrames && value.fps === 30
    && typeof value.imageUrl === 'string' && value.imageUrl.startsWith('/media/')
    && value.cellWidth === 160 && value.cellHeight === 90 && Array.isArray(value.frames)
    && value.frames.length > 0 && value.frames.length <= 12
    && value.frames.every((frame, index) => Number.isInteger(frame) && frame >= 0 && frame < version.durationFrames && (index === 0 || frame > value.frames[index - 1]));
}

function loadSprite(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const sprite = new Image();
    const cleanup = () => { sprite.onload = null; sprite.onerror = null; signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); sprite.removeAttribute('src'); reject(new DOMException('장면 미리보기 요청 취소', 'AbortError')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    sprite.onload = () => { cleanup(); resolve(); };
    sprite.onerror = () => { cleanup(); reject(new Error('장면 미리보기 이미지를 불러오지 못했습니다.')); };
    sprite.src = url;
  });
}

export const TimelineFilmstrip = memo(function TimelineFilmstrip({ version, enabled = true }: { version: Version; enabled?: boolean }) {
  const [loaded, setLoaded] = useState<{ key: string; strip: Filmstrip | null; error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([version.id, version.durationFrames, version.mediaUrl]);
  const strip = loaded?.key === key ? loaded.strip : null;
  const error = loaded?.key === key ? loaded.error : '';

  useEffect(() => {
    // The compact timeline never needs thumbnails. Keep a completed strip for
    // immediate expansion, but defer requests until the strip is visible.
    if (!enabled || strip) return;
    const controller = new AbortController();
    setLoaded({ key, strip: null, error: '' });
    void (async () => {
      const response = await fetch(`/api/versions/${encodeURIComponent(version.id)}/filmstrip`, { signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '장면 미리보기를 준비하지 못했습니다.');
      if (!validFilmstrip(body, version)) throw new Error('현재 버전의 장면 미리보기를 확인하지 못했습니다.');
      await loadSprite(body.imageUrl, controller.signal);
      if (!controller.signal.aborted) setLoaded({ key, strip: body, error: '' });
    })().catch(error => { if (!controller.signal.aborted) setLoaded({ key, strip: null, error: error instanceof Error ? error.message : '장면 미리보기를 준비하지 못했습니다.' }); });
    return () => controller.abort();
  }, [key, enabled, strip, attempt]);

  return <div className="vi-filmstrip" hidden={!enabled} aria-label={`v${version.number} 실제 장면 미리보기`} aria-busy={enabled && !strip && !error}>
    {strip ? <div className="vi-filmstrip-cells" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${strip.frames.length}, minmax(0, 1fr))` }}>
      {strip.frames.map((frame, index) => <svg key={frame} viewBox={`${index * strip.cellWidth} 0 ${strip.cellWidth} ${strip.cellHeight}`} preserveAspectRatio="xMidYMid slice" focusable="false">
        <image href={strip.imageUrl} width={strip.cellWidth * strip.frames.length} height={strip.cellHeight} />
      </svg>)}
    </div> : <div className={`vi-filmstrip-status${error ? ' vi-filmstrip-failed' : ''}`} role="status">
      {error ? <><span title={error}>장면 미리보기 준비 필요</span><button type="button" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setAttempt(value => value + 1); }} title={`${error} 재생과 구간 선택은 계속할 수 있습니다.`}><RotateCcw size={12} />다시 준비</button></>
        : <><LoaderCircle size={13} className="spinning" /><span>장면 미리보기 준비 중</span></>}
    </div>}
  </div>;
});
