const ppro = require('premierepro');
const { storage } = require('uxp');
const bridge = require('./bridge.js');
const overlays = require('./overlays.js');
const byId = id => document.getElementById(id);
let bundle = null, file = null, folder = null, binding = null, placement = null, busy = false;
const say = message => { byId('status').textContent = message; };
const clock = frame => `${(frame / 30).toFixed(3)}초`;
const statusLabels = { present: '', partial: '일부 구간 삭제', deleted: '현재 버전에서 삭제됨', unavailable: '현재 위치 확인 필요' };

function controls() {
  for (const id of ['load', 'load-folder', 'offset']) byId(id).disabled = busy;
  byId('reload').disabled = busy || !file;
  byId('bind').disabled = busy || !bundle;
  byId('sync').disabled = busy || !binding;
  byId('inspect-overlays').disabled = busy || !binding || !folder || !bundle?.timelineOverlays;
  byId('apply-overlays').disabled = busy || !placement;
  for (const button of document.querySelectorAll('#feedback button')) button.disabled = busy || (button.getAttribute('data-seek') === 'true' && !binding);
}
async function run(task) {
  if (busy) return;
  busy = true; controls();
  try { await task(); } catch (error) { say(error.message || String(error)); }
  finally { busy = false; controls(); }
}
function clearBinding() {
  binding = null;
  placement = null;
  byId('placement').textContent = '오버레이 묶음 폴더를 열면 영상 위 배치를 준비할 수 있습니다.';
  byId('binding').textContent = '동일한 영상 버전인지 확인한 뒤 현재 시퀀스를 연결하세요.';
  controls();
}
async function activeSequence() {
  const project = await ppro.Project.getActiveProject();
  const sequence = project && await project.getActiveSequence();
  if (!sequence) throw new Error('Premiere에서 시퀀스를 열어 주세요.');
  return { project, sequence, info: await bridge.readSequenceInfo(project, sequence) };
}
async function seek(frame) {
  const { sequence, info } = await activeSequence();
  try { bridge.assertBinding(binding, info); } catch (error) { clearBinding(); throw error; }
  const ok = await sequence.setPlayerPosition(ppro.TickTime.createWithSeconds(bridge.sequenceSeconds(frame, binding)));
  if (ok === false) throw new Error('해당 위치로 이동하지 못했습니다.');
  say(`${clock(frame)} 위치로 이동했습니다.`);
}
function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}
function seekButton(parent, label, frame) {
  const button = element('button', label);
  button.setAttribute('data-seek', 'true');
  button.addEventListener('click', () => run(() => seek(frame)));
  parent.appendChild(button);
}
function render() {
  const list = byId('feedback');
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!bundle) return;
  byId('source').textContent = `${bundle.project.name} · v${bundle.version.number}\n${bundle.canvas.width} × ${bundle.canvas.height} · ${clock(bundle.version.durationFrames)} · 댓글 ${bundle.feedback.length}개`;
  if (bundle.timelineOverlays) byId('source').textContent += `\n오버레이 ${bundle.timelineOverlays.segments.length}구간 · 제외 ${bundle.timelineOverlays.skippedGroups}묶음`;
  if (!bundle.feedback.length) list.appendChild(element('p', '빈 피드백 자료입니다. 마커 갱신 시 이 자료의 기존 연동 마커를 정리합니다.', 'muted'));
  for (const entry of bundle.feedback) {
    const card = element('div', undefined, 'card');
    if (entry.sceneDescription) card.appendChild(element('p', entry.sceneDescription, 'muted'));
    card.appendChild(element('p', entry.text || '그림·메모'));
    for (const supplement of entry.supplements) card.appendChild(element('p', `추가: ${supplement.text}`));
    if (statusLabels[entry.status]) card.appendChild(element('p', statusLabels[entry.status], 'muted'));
    for (const range of entry.ranges) seekButton(card, range.frameOut - range.frameIn === 1 ? clock(range.frameIn) : `${clock(range.frameIn)} – ${clock(range.frameOut)}`, range.frameIn);
    const drawings = element('div');
    let expanded = false;
    if (entry.overlays.length) {
      const toggle = element('button', `마크업 ${entry.overlays.length}묶음 보기`);
      toggle.addEventListener('click', () => {
        expanded = !expanded;
        toggle.textContent = expanded ? '마크업 접기' : `마크업 ${entry.overlays.length}묶음 보기`;
        while (drawings.firstChild) drawings.removeChild(drawings.firstChild);
        if (expanded) for (const overlay of entry.overlays) renderOverlay(drawings, overlay);
        controls();
      });
      card.appendChild(toggle); card.appendChild(drawings);
    }
    if (entry.excludedAttachmentCount) card.appendChild(element('p', `참고 이미지·음성 ${entry.excludedAttachmentCount}개는 원래 앱에서 확인하세요.`, 'muted'));
    list.appendChild(card);
  }
  controls();
}
function renderOverlay(parent, overlay) {
  const preview = element('div', undefined, 'overlay');
  const image = element('img'); image.src = overlay.preview; image.alt = '영상 배경 없는 마크업';
  preview.appendChild(image);
  preview.appendChild(element('p', `작성 ${clock(overlay.authoredFrame)} · ${overlay.drawings.length}개 표시`, 'muted'));
  if (overlay.status === 'present') seekButton(preview, `그림 위치 ${clock(overlay.frame)}`, overlay.frame);
  else preview.appendChild(element('p', statusLabels[overlay.status], 'muted'));
  parent.appendChild(preview);
}
async function readFile(selected, selectedFolder = null) {
  clearBinding();
  if ((await selected.getMetadata()).size > 48 * 1024 * 1024) throw new Error('48MB 이하의 연동 JSON을 선택해 주세요.');
  const next = bridge.validateBundle(JSON.parse(await selected.read()));
  bundle = next; file = selected; folder = selectedFolder; render();
  say('자료를 읽었습니다. 같은 영상 버전이 놓인 시퀀스를 연결하세요.');
}
byId('load').addEventListener('click', () => run(async () => {
  const selected = await storage.localFileSystem.getFileForOpening({ types: ['json'], allowMultiple: false });
  if (selected) await readFile(selected);
}));
byId('load-folder').addEventListener('click', () => run(async () => {
  const selected = await storage.localFileSystem.getFolder();
  if (selected) await readFile(await selected.getEntry('premiere-feedback.json'), selected);
}));
byId('reload').addEventListener('click', () => run(() => readFile(file, folder)));
byId('offset').addEventListener('input', clearBinding);
byId('bind').addEventListener('click', () => run(async () => {
  clearBinding();
  const { info } = await activeSequence();
  const raw = byId('offset').value.trim();
  if (!raw) throw new Error('시퀀스 시작 위치를 초 단위로 입력해 주세요.');
  binding = bridge.sequenceBinding(bundle, info, Number(raw));
  byId('binding').textContent = `${info.name} · 시작 ${binding.offsetSeconds.toFixed(3)}초\n시퀀스 프레임 경계에 맞춰 시간을 변환합니다.`;
  say('연결되었습니다. 마커 갱신은 댓글 마커만 변경합니다.');
}));
byId('sync').addEventListener('click', () => run(async () => {
  try {
    const result = await bridge.syncMarkers(ppro, bundle, binding);
    say(`마커 ${result.added}개 반영 · 기존 연동 마커 ${result.replaced}개 교체.`);
  } catch (error) { clearBinding(); throw error; }
}));
byId('inspect-overlays').addEventListener('click', () => run(async () => {
  placement = null;
  const inspected = await overlays.inspect(ppro, bundle, binding);
  // Read and verify every PNG before any host mutation.
  const assets = await overlays.loadAssets(folder, inspected.plan, bundle.canvas, storage.formats.binary);
  placement = { assets, fingerprint: inspected.fingerprint };
  byId('placement').textContent = `V${inspected.target.index + 1} · ${assets.length}구간 배치 · 기존 연동 ${inspected.target.items.length}개 교체\n` +
    inspected.plan.slice(0, 6).map(item => `${item.start.toFixed(3)}–${item.end.toFixed(3)}초`).join('\n') +
    (assets.length > 6 ? `\n외 ${assets.length - 6}구간` : '');
  byId('apply-overlays').textContent = assets.length ? `V${inspected.target.index + 1}에 오버레이 적용` : '기존 연동 오버레이 지우기';
  say('파일과 배치 구간을 확인했습니다. 적용 버튼을 누르면 해당 트랙에 반영합니다.');
}));
byId('apply-overlays').addEventListener('click', () => run(async () => {
  const prepared = placement;
  placement = null;
  // Re-read at the action boundary: files could have changed since preview.
  const assets = await overlays.loadAssets(folder, overlays.overlayPlan(bundle, binding), bundle.canvas, storage.formats.binary);
  if (assets.some((asset, index) => asset.path !== prepared.assets[index]?.path)) throw new Error('묶음 폴더가 바뀌었습니다. 배치를 다시 확인해 주세요.');
  const result = await overlays.applyOverlays(ppro, bundle, binding, assets, prepared.fingerprint);
  byId('placement').textContent = `V${result.track} · ${result.added}구간 반영 완료`;
  say(`투명 오버레이 ${result.added}구간 반영 · 기존 ${result.replaced}개 교체. Premiere 실행 취소로 트랙 배치를 되돌릴 수 있습니다.`);
}));
controls();
