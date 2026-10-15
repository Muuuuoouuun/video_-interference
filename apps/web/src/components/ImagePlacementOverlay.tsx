import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Check, Image, X } from 'lucide-react';
import type { Region } from '../../../../packages/core/types';
import './ImagePlacementOverlay.css';

export interface ImageOverlayPreview {
  id: string;
  assetUrl: string;
  name: string;
  region: Region;
  editable: boolean;
  onRegionChange: (region: Region) => Promise<boolean>;
  onClose: () => void;
}
type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
type Drag = { handle: Handle; pointerId: number; x: number; y: number; width: number; height: number; region: Region; pending: Region };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Region coordinates are shared with the renderer. Image fitting preserves the source aspect ratio. */
export function ImagePlacementOverlay({ preview, onEditStart }: { preview: ImageOverlayPreview; onEditStart: () => void }) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const raf = useRef<number | null>(null);
  const pendingSave = useRef(0);
  const mounted = useRef(true);
  const latest = useRef(preview);
  latest.current = preview;
  const [region, setRegion] = useState(preview.region);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!drag.current) setRegion(preview.region); }, [preview.region]);
  useEffect(() => { setFailed(false); }, [preview.assetUrl]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (raf.current !== null) cancelAnimationFrame(raf.current); }; }, []);

  function start(event: ReactPointerEvent<HTMLElement>, handle: Handle) {
    if (!preview.editable || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = surface.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    onEditStart();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height, region, pending: region };
  }
  function move(event: ReactPointerEvent<HTMLElement>) {
    const active = drag.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const dx = (event.clientX - active.x) / active.width;
    const dy = (event.clientY - active.y) / active.height;
    const initial = active.region;
    let next: Region;
    if (active.handle === 'move') {
      next = { ...initial, x: clamp(initial.x + dx, 0, 1 - initial.w), y: clamp(initial.y + dy, 0, 1 - initial.h) };
    } else {
      const minWidth = Math.min(0.02, initial.w), minHeight = Math.min(0.02, initial.h);
      let left = initial.x, top = initial.y, right = initial.x + initial.w, bottom = initial.y + initial.h;
      if (active.handle.includes('w')) left = clamp(left + dx, 0, right - minWidth);
      else right = clamp(right + dx, left + minWidth, 1);
      if (active.handle.includes('n')) top = clamp(top + dy, 0, bottom - minHeight);
      else bottom = clamp(bottom + dy, top + minHeight, 1);
      next = { x: left, y: top, w: right - left, h: bottom - top };
    }
    active.pending = next;
    if (raf.current === null) raf.current = requestAnimationFrame(() => { raf.current = null; if (drag.current) setRegion(drag.current.pending); });
  }
  function finish(event: ReactPointerEvent<HTMLElement>, cancel = false) {
    if (!cancel) move(event);
    const active = drag.current;
    if (!active || event.pointerId !== active.pointerId) return;
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null; drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel) setRegion(active.region);
    else {
      setRegion(active.pending);
      if (Object.keys(active.pending).some(key => Math.abs(active.pending[key as keyof Region] - active.region[key as keyof Region]) > 0.00001)) {
        const generation = ++pendingSave.current;
        void preview.onRegionChange(active.pending).then(saved => {
          if (!saved && mounted.current && generation === pendingSave.current) setRegion(latest.current.region);
        }).catch(() => { if (mounted.current && generation === pendingSave.current) setRegion(latest.current.region); });
      }
    }
  }
  const events = { onPointerMove: move, onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finish(e), onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finish(e, true), onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => finish(e, true) };
  return <div className="image-placement" ref={surface} aria-label="삽입 이미지 배치 미리보기">
    <div className="image-placement-box" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` }} onPointerDown={e => start(e, 'move')} {...events}>
      {failed ? <div className="image-placement-failed"><Image size={18}/><span>이미지를 불러오지 못했습니다</span></div> : <img src={preview.assetUrl} alt={preview.name} draggable={false} onError={() => setFailed(true)}/>}
      {preview.editable ? (['nw', 'ne', 'sw', 'se'] as const).map(handle => <button key={handle} className={`image-placement-handle ${handle}`} aria-label={`이미지 ${handle} 크기 조절`} onPointerDown={e => start(e, handle)} {...events}/>) : null}
    </div>
    <div className="image-placement-caption"><Image size={13}/><span>{preview.editable ? '드래그로 이동 · 모서리로 크기 조절' : '이미지 배치 미리보기'}</span><button onClick={preview.onClose} aria-label="이미지 배치 미리보기 닫기"><Check size={14}/>완료</button></div>
    <button className="image-placement-close" aria-label="이미지 배치 닫기" onClick={preview.onClose}><X size={15}/></button>
  </div>;
}
