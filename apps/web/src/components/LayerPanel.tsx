import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, Image as ImageIcon, Layers, LoaderCircle, Pencil, RotateCcw, Trash2, Type, X } from 'lucide-react';
import type { Asset, Attachment, Drawing, EditOp, LayerChangeInput, Region, RenderLayer, Version } from '../../../../packages/core/types';
import { mapFrameBetweenVersions } from '../../../../packages/core/comment-projection.mjs';
import { api } from '../api';
import { time } from '../format';
import { OverlayEditor } from './OverlayEditor';
import './LayerPanel.css';

interface LayerPanelProps {
  version: Version;
  originalVersion: Version;
  asset: Asset;
  attachments: Attachment[];
  busy: boolean;
  refreshKey?: number;
  onChange: (layer: RenderLayer, input: LayerChangeInput) => Promise<boolean>;
  onDraftChange?: (active: boolean) => void;
  onSeek?: (frame: number) => void;
  pendingChanges?: EditOp[];
  onSelectChange?: (op: EditOp) => void;
}

type RegionFields = Record<keyof Region, string>;
type LayerDraft = { layer: RenderLayer; frame: number; params: EditOp['params']; region: Region; fields: RegionFields; regionDirty: boolean };
const REGION_FIELDS: { key: keyof Region; label: string }[] = [{ key: 'x', label: '왼쪽' }, { key: 'y', label: '위쪽' }, { key: 'w', label: '너비' }, { key: 'h', label: '높이' }];
const EMPTY_OPS: EditOp[] = [];
const noop = () => {};
const defaultRegion = (op: EditOp): Region => op.region ?? (op.type === 'subtitle' ? { x: 0.1, y: 0.78, w: 0.8, h: 0.15 } : { x: 0.12, y: 0.16, w: 0.76, h: 0.22 });
const regionFields = (region: Region): RegionFields => Object.fromEntries(REGION_FIELDS.map(({ key }) => [key, String(Number((region[key] * 100).toFixed(3)))])) as RegionFields;
const kindLabel = (op: EditOp) => op.type === 'subtitle' ? '자막' : ({ text: '글자 그래픽', image: '삽입 이미지', box: '박스 그래픽', drawing: '그림·도형' }[op.params.kind ?? 'text']);
const layerIcon = (op: EditOp) => op.type === 'subtitle' || op.params.kind === 'text' ? Type : op.params.kind === 'image' ? ImageIcon : Layers;

export function LayerPanel({ version, originalVersion, asset, attachments, busy, refreshKey = 0, onChange, onDraftChange, onSeek, pendingChanges = EMPTY_OPS, onSelectChange }: LayerPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<{ versionId: string; layers: RenderLayer[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState<LayerDraft | null>(null);
  const [removeLayer, setRemoveLayer] = useState<RenderLayer | null>(null);
  const [mutationError, setMutationError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingRef = useRef(false);
  const draftChangeRef = useRef(onDraftChange);
  const titleId = useId();
  const guidanceId = useId();
  const listId = useId();
  draftChangeRef.current = onDraftChange;
  const locked = busy || submitting;
  const navigationLocked = locked || Boolean(removeLayer);
  const layers = result?.versionId === version.id ? result.layers : [];
  const insertImages = useMemo(() => attachments.filter(item => item.role === 'insert' && item.mimeType.startsWith('image/')), [attachments]);
  const isDrawing = draft?.params.kind === 'drawing';
  const isText = draft?.layer.op.type === 'subtitle' || draft?.params.kind === 'text';
  const sourceFrame = draft ? mapFrameBetweenVersions(version, originalVersion, draft.frame) : null;
  const selectedImage = draft ? insertImages.find(item => item.id === draft.params.assetRef) : undefined;
  const pendingByLayer = useMemo(() => {
    const values = new Map<string, EditOp[]>();
    for (const op of pendingChanges) {
      if (op.versionId !== version.id || !op.layerChange || !['proposed', 'approved'].includes(op.status)) continue;
      const id = op.layerChange.targetLayerId;
      values.set(id, [...(values.get(id) ?? []), op]);
    }
    return values;
  }, [pendingChanges, version.id]);

  useEffect(() => {
    let active = true;
    setLoading(true); setLoadError(''); setResult(null);
    void api<{ layers: RenderLayer[] }>(`/api/versions/${encodeURIComponent(version.id)}/layers`).then(value => {
      if (active) setResult({ versionId: version.id, layers: value.layers });
    }).catch(error => { if (active) setLoadError(error instanceof Error ? error.message : '적용된 그래픽을 불러오지 못했습니다.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [version.id, refreshKey, retry]);

  useEffect(() => {
    draftChangeRef.current?.(Boolean(draft || removeLayer));
    return () => draftChangeRef.current?.(false);
  }, [Boolean(draft), Boolean(removeLayer)]);

  useEffect(() => {
    setDraft(null); setRemoveLayer(null); setMutationError('');
  }, [version.id]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (draft && !dialog.open) dialog.showModal();
    else if (!draft && dialog.open) dialog.close();
  }, [Boolean(draft)]);

  const measure = useCallback(() => {
    const surface = stageRef.current;
    if (!surface) return;
    const ratio = asset.width / asset.height;
    const width = Math.min(surface.clientWidth, surface.clientHeight * ratio), height = width / ratio;
    setViewport({ left: (surface.clientWidth - width) / 2, top: (surface.clientHeight - height) / 2, width, height });
  }, [asset.width, asset.height]);

  useLayoutEffect(() => {
    const surface = stageRef.current;
    if (!surface || !draft) return;
    const observer = new ResizeObserver(measure);
    observer.observe(surface); measure();
    return () => observer.disconnect();
  }, [Boolean(draft), measure]);

  const pauseReference = useCallback(() => { videoRef.current?.pause(); }, []);
  const seekReference = useCallback(() => {
    const video = videoRef.current;
    if (!video || sourceFrame === null || video.readyState < 1) return;
    video.pause();
    if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - sourceFrame / 30) < 0.5 / 30) setMediaReady(true);
    else { setMediaReady(false); video.currentTime = sourceFrame / 30; }
  }, [sourceFrame]);
  const verifyReference = useCallback(() => {
    const video = videoRef.current;
    if (video && sourceFrame !== null && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - sourceFrame / 30) < 0.5 / 30) setMediaReady(true);
  }, [sourceFrame]);
  useEffect(seekReference, [seekReference, asset.mediaUrl]);

  const updateDrawings = useCallback((drawings: Drawing[]) => setDraft(current => current ? { ...current, params: { ...current.params, drawings } } : current), []);
  const openEditor = (layer: RenderLayer) => {
    if (navigationLocked || pendingRef.current || !layer.outputRanges.length || pendingByLayer.has(layer.id)) return;
    const frame = layer.outputRanges[0].frameIn;
    const params = structuredClone(layer.op.params), region = structuredClone(defaultRegion(layer.op));
    if (params.drawings) params.drawings = params.drawings.map(drawing => ({ ...drawing, frame }));
    setMutationError(''); setMediaError(false); setMediaReady(false); setRemoveLayer(null);
    setDraft({ layer, frame, params, region, fields: regionFields(region), regionDirty: false });
  };

  const closeEditor = () => { if (!pendingRef.current && !busy) { setDraft(null); setMutationError(''); } };
  const submit = async (layer: RenderLayer, input: LayerChangeInput) => {
    if (pendingRef.current || busy) return;
    pendingRef.current = true; setSubmitting(true); setMutationError('');
    try {
      if (await onChange(layer, input)) { setDraft(null); setRemoveLayer(null); }
      else setMutationError('변경 요청을 저장하지 못했습니다. 입력은 유지했습니다. 다시 시도해 주세요.');
    } catch (error) { setMutationError(error instanceof Error ? error.message : '변경 요청을 저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally { pendingRef.current = false; setSubmitting(false); }
  };

  const saveEdit = () => {
    if (!draft || locked) return;
    const params = structuredClone(draft.params);
    let region = draft.region;
    if (isText && (!params.text?.trim() || params.text.length > 300)) { setMutationError('표시 문구는 1~300자로 적어 주세요.'); return; }
    if (isDrawing && !params.drawings?.length) { setMutationError('그림을 하나 이상 남겨 주세요. 전체를 없애려면 목록의 제거 요청을 이용하세요.'); return; }
    if (params.kind === 'image' && !selectedImage) { setMutationError('삽입 용도로 등록된 이미지를 선택해 주세요.'); return; }
    if (!isDrawing && draft.regionDirty) {
      if (REGION_FIELDS.some(({ key }) => !draft.fields[key].trim())) { setMutationError('화면 위치와 크기를 모두 입력해 주세요.'); return; }
      region = Object.fromEntries(REGION_FIELDS.map(({ key }) => [key, Number(draft.fields[key]) / 100])) as unknown as Region;
      if (![region.x, region.y, region.w, region.h].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.w < 0.002 || region.h < 0.002 || region.x + region.w > 1 + 1e-9 || region.y + region.h > 1 + 1e-9) {
        setMutationError('너비·높이는 0.2% 이상이며, 그래픽 전체가 영상 안에 있어야 합니다.'); return;
      }
    }
    void submit(draft.layer, { action: 'replace', targetOpId: draft.layer.op.id, params, ...(!isDrawing ? { region } : {}) });
  };

  return <section className="layer-panel" aria-label="현재 버전의 자막과 그래픽">
    <h2 className="layer-panel-heading"><button aria-expanded={expanded} aria-controls={listId} disabled={locked} onClick={() => { setExpanded(value => !value); setRemoveLayer(null); setMutationError(''); }}><Layers size={15} /><span>적용된 자막·그래픽</span><small>v{version.number} · {loading ? '…' : layers.length}</small><ChevronDown size={14} className={expanded ? 'layer-expanded' : ''} /></button></h2>
    <div id={listId} hidden={!expanded}>
      <p className="layer-panel-guide">수정·제거 요청을 승인하면 다음 버전에 반영됩니다.</p>
      {loading ? <p className="layer-empty" role="status"><LoaderCircle className="spinning" size={14} />불러오는 중</p>
      : loadError ? <div className="layer-load-error" role="alert"><p>{loadError}</p><button className="quiet" onClick={() => setRetry(value => value + 1)} disabled={busy}><RotateCcw size={13} />다시 불러오기</button></div>
        : !layers.length ? <p className="layer-empty">이 버전에 적용된 자막·그래픽이 없습니다.</p>
          : <ol className="layer-list">{layers.map(layer => {
            const Icon = layerIcon(layer.op), image = attachments.find(item => item.id === layer.op.params.assetRef), visible = layer.outputRanges.length > 0;
            const changes = pendingByLayer.get(layer.id) ?? [];
            const label = layer.op.params.text || (layer.op.params.kind === 'drawing' ? `도형 ${layer.op.params.drawings?.length ?? 0}개` : layer.op.params.kind === 'image' ? image?.name ?? '삽입 이미지' : '박스 그래픽');
            return <li className="layer-item" key={layer.id}>
              <div className="layer-item-label"><Icon size={14} /><strong>{kindLabel(layer.op)}</strong><span>{layer.outputRanges.length > 1 ? `${layer.outputRanges.length}개 구간` : ''}</span></div>
              <p className="layer-item-content" title={label}>{label}</p>
              <div className="layer-ranges">{visible ? layer.outputRanges.map((range, index) => <button key={`${range.frameIn}-${range.frameOut}-${index}`} onClick={() => onSeek?.(range.frameIn)} disabled={!onSeek || navigationLocked} title="해당 구간 보기">{time(range.frameIn)}–{time(range.frameOut)}</button>) : <span>이 구간이 남아 있는 이전 버전에서 변경하세요.</span>}</div>
              {changes.length ? <div className="layer-pending-changes">{changes.map(op => <button key={op.id} disabled={navigationLocked || !onSelectChange} onClick={() => onSelectChange?.(op)}>{op.layerChange?.action === 'remove' ? '제거' : '수정'} 요청 · {op.status === 'approved' ? '승인됨' : '승인 대기'} <span>카드 보기 →</span></button>)}</div> : <div className="layer-item-actions"><button className="quiet" disabled={navigationLocked || !visible} onClick={() => openEditor(layer)}><Pencil size={12} />수정</button><button className="quiet" disabled={navigationLocked || !visible} onClick={() => { setRemoveLayer(layer); setMutationError(''); }}><Trash2 size={12} />제거 요청</button></div>}
              {removeLayer?.id === layer.id ? <div className="layer-remove-confirm"><p>이 {kindLabel(layer.op)}을 다음 버전에서 없애는 요청을 추가합니다. 현재 영상은 그대로 유지됩니다.</p>{mutationError ? <p className="layer-error" role="alert">{mutationError}</p> : null}<div><button className="quiet" disabled={locked} onClick={() => { setRemoveLayer(null); setMutationError(''); }}>취소</button><button className="secondary" disabled={locked} onClick={() => void submit(layer, { action: 'remove', targetOpId: layer.op.id })}>{submitting ? <LoaderCircle size={13} className="spinning" /> : <Trash2 size={13} />}제거 요청 추가</button></div></div> : null}
            </li>;
          })}</ol>}
    </div>

    <dialog ref={dialogRef} className={`layer-dialog${isDrawing ? ' layer-dialog-drawing' : ''}`} aria-labelledby={titleId} aria-describedby={guidanceId}
      onCancel={event => { event.preventDefault(); closeEditor(); }} onClose={closeEditor} onKeyDown={event => event.stopPropagation()}>
      {draft ? <>
        <header className="layer-dialog-header"><div><span>v{version.number} · {kindLabel(draft.layer.op)}</span><h2 id={titleId}>다음 버전에 적용할 수정</h2></div><button className="quiet" aria-label="수정창 닫기" disabled={locked} onClick={closeEditor}><X size={20} /></button></header>
        <p id={guidanceId} className="layer-dialog-guidance">적용 구간과 종류는 유지됩니다. 수정 요청을 추가한 뒤 요청 카드에서 승인해 주세요.</p>
        <div className="layer-dialog-body">
          <div className="layer-reference-column">
            <div className="layer-reference-caption"><span>원본 장면 · {sourceFrame === null ? '연결할 수 없음' : time(sourceFrame)}</span><span>v{version.number} {time(draft.frame)} 위치</span></div>
            <div ref={stageRef} className="layer-stage">
              {sourceFrame !== null ? <video ref={videoRef} src={asset.mediaUrl} preload="auto" muted playsInline onLoadedMetadata={() => { seekReference(); measure(); }} onLoadedData={verifyReference} onSeeked={verifyReference} onError={() => { setMediaError(true); setMediaReady(false); }} onPlay={pauseReference} /> : null}
              {mediaError || sourceFrame === null ? <div className="layer-media-error"><AlertCircle size={20} /><p>원본 장면을 불러오지 못했습니다.</p><span>영상 파일을 확인한 뒤 창을 다시 열어 주세요.</span></div> : null}
              {!mediaError && sourceFrame !== null && !mediaReady ? <div className="layer-media-loading" role="status"><LoaderCircle size={17} className="spinning" />원본 장면 불러오는 중</div> : null}
              {isDrawing ? <OverlayEditor drawings={draft.params.drawings ?? []} currentFrame={draft.frame} fallbackFrame={draft.frame} onChange={updateDrawings} viewport={viewport} enabled blocked={locked || !mediaReady || mediaError || sourceFrame === null} blockedLabel={locked ? '변경 요청 저장 중' : '원본 장면을 확인해 주세요'} onPause={pauseReference} onBackgroundClick={noop} toolbarHost={toolbarHost} resetKey={`layer-${version.id}-${draft.layer.id}-${draft.layer.op.id}`} /> : null}
            </div>
            <p className="layer-reference-note">{isDrawing ? '원본 위에서 이 그래픽 수정 · 다른 그래픽은 최종 결과에서 함께 표시됩니다.' : '위 영상은 위치를 확인하는 원본 장면입니다. 수정 내용은 승인·렌더 후 결과에 표시됩니다.'}</p>
            {isDrawing ? <><div ref={setToolbarHost} className="layer-drawing-toolbar" /><p className="layer-drawing-help">드래그로 이동 · 핸들로 크기 조절 · 방향키로 1px 이동 · 새 그림도 이 그래픽의 수정에 포함됩니다.</p></> : null}
          </div>
          {!isDrawing ? <div className="layer-fields">
            {isText ? <label className="layer-field">표시 문구<textarea autoFocus rows={4} maxLength={300} value={draft.params.text ?? ''} disabled={locked} onChange={event => setDraft(current => current ? { ...current, params: { ...current.params, text: event.target.value } } : current)} /><span>{draft.params.text?.length ?? 0} / 300</span></label> : null}
            {isText || draft.params.kind === 'box' ? <label className="layer-color-field">{draft.params.kind === 'box' ? '테두리 색' : '글자 색'}<input type="color" value={draft.params.color || (draft.params.kind === 'box' ? '#dfff00' : '#ffffff')} disabled={locked} onChange={event => setDraft(current => current ? { ...current, params: { ...current.params, color: event.target.value } } : current)} /><span>{draft.params.color || (draft.params.kind === 'box' ? '#dfff00' : '#ffffff')}</span></label> : null}
            {draft.params.kind === 'image' ? <label className="layer-field">삽입 이미지<select autoFocus value={draft.params.assetRef ?? ''} disabled={locked || !insertImages.length} onChange={event => setDraft(current => current ? { ...current, params: { ...current.params, assetRef: event.target.value } } : current)}>{!selectedImage ? <option value={draft.params.assetRef ?? ''}>삽입 이미지를 선택하세요</option> : null}{insertImages.map(attachment => <option key={attachment.id} value={attachment.id}>{attachment.name}</option>)}</select>{selectedImage ? <img className="layer-image-preview" src={selectedImage.mediaUrl} alt={selectedImage.name} /> : <span>먼저 자료실에 삽입 용도의 이미지를 등록해 주세요.</span>}</label> : null}
            <fieldset className="layer-region-fields" disabled={locked}><legend>위치와 크기 · 영상 대비 %</legend>{REGION_FIELDS.map(({ key, label }) => <label key={key}>{label}<div><input type="number" inputMode="decimal" min={key === 'w' || key === 'h' ? 0.2 : 0} max={100} step="any" value={draft.fields[key]} onChange={event => setDraft(current => current ? { ...current, regionDirty: true, fields: { ...current.fields, [key]: event.target.value } } : current)} /><span>%</span></div></label>)}</fieldset>
          </div> : null}
        </div>
        <footer className="layer-dialog-footer">{mutationError ? <p className="layer-error" role="alert">{mutationError}</p> : <p>현재 버전의 결과와 원본은 보존됩니다.</p>}<div><button className="secondary" disabled={locked} onClick={closeEditor}>취소</button><button className="primary" disabled={locked || (isDrawing && (!draft.params.drawings?.length || !mediaReady || mediaError || sourceFrame === null))} onClick={saveEdit}>{submitting ? <LoaderCircle className="spinning" size={15} /> : <Pencil size={15} />}수정 요청 추가</button></div></footer>
      </> : null}
    </dialog>
  </section>;
}
