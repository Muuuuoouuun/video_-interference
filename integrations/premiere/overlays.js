const bridge = require('./bridge.js');
const { sha256 } = require('./sha256.js');
const fail = message => { throw new Error(message); };
const samePath = (a, b) => a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
const ownedPath = (path, scope) => new RegExp(`^vi-${scope}-[0-9]+-[0-9]+-[a-f0-9]{64}\\.png$`).test(path.replace(/\\/g, '/').split('/').pop());

function overlayPlan(bundle, binding) {
  bridge.validateBundle(bundle);
  if (!bundle.timelineOverlays) fail('앱에서 오버레이 묶음을 새로 내보내 주세요.');
  if (!binding || binding.scope !== bundle.scope) fail('이 자료의 시퀀스를 먼저 연결해 주세요.');
  return bundle.timelineOverlays.segments.map(segment => {
    const start = bridge.sequenceSeconds(segment.frameIn, binding);
    const end = bridge.sequenceSeconds(segment.frameOut, binding);
    if (end - start < binding.frameSeconds * 0.5) fail('현재 프레임레이트에서 표시할 수 없는 짧은 그림 구간이 있습니다. 앱에서 구간을 늘려 주세요.');
    if (end > binding.endSeconds + 1e-7) fail('오버레이 구간이 시퀀스 끝을 넘습니다. 시작 위치를 확인해 주세요.');
    return { ...segment, start, end };
  });
}
function validatePng(input, segment, canvas) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length !== segment.bytes || bytes.length < 33 ||
      view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452 ||
      view.getUint32(16) !== canvas.width || view.getUint32(20) !== canvas.height || bytes[24] !== 8 || bytes[25] !== 6 ||
      sha256(bytes) !== segment.sha256) fail('오버레이 PNG가 변경되었거나 해상도·투명도 정보가 다릅니다. 원래 묶음을 다시 선택해 주세요.');
}
async function loadAssets(folder, plan, canvas, binaryFormat) {
  const assets = [];
  for (const segment of plan) {
    const file = await folder.getEntry(segment.file);
    if (!file.isFile || typeof file.nativePath !== 'string' || (await file.getMetadata()).size !== segment.bytes) fail('오버레이 파일이 없거나 변경되었습니다.');
    validatePng(await file.read({ format: binaryFormat }), segment, canvas);
    assets.push({ ...segment, path: file.nativePath });
  }
  return assets;
}
async function active(ppro, binding) {
  const project = await ppro.Project.getActiveProject();
  const sequence = project && await project.getActiveSequence();
  if (!sequence) fail('Premiere에서 연결한 시퀀스를 열어 주세요.');
  bridge.assertBinding(binding, await bridge.readSequenceInfo(project, sequence));
  const settings = await sequence.getSettings();
  if (typeof settings.PAR_SQUARE !== 'string' || await settings.getVideoPixelAspectRatio() !== settings.PAR_SQUARE) fail('위치를 정확히 맞추려면 정사각형 픽셀 시퀀스가 필요합니다.');
  return { project, sequence };
}
async function tracks(ppro, sequence, scope) {
  const result = [];
  for (let index = 0; index < await sequence.getVideoTrackCount(); index++) {
    const track = await sequence.getVideoTrack(index);
    // Documented TrackItemType values: Clip=1, Transition=2.
    const clips = await track.getTrackItems(1, false), transitions = await track.getTrackItems(2, false);
    const items = [];
    for (const clip of clips) {
      const item = await clip.getProjectItem();
      let path = '';
      try { path = await ppro.ClipProjectItem.cast(item).getMediaFilePath(); } catch (_) { /* Non-file items are user-owned. */ }
      const [start, end] = await Promise.all([clip.getStartTime(), clip.getEndTime()]);
      items.push({ clip, path, start: start.seconds, end: end.seconds, owned: ownedPath(path, scope) });
    }
    result.push({ index, items, transitions: transitions.length, muted: await track.isMuted() });
  }
  return result;
}
function chooseTrack(all) {
  const managed = all.filter(track => track.items.some(item => item.owned));
  if (managed.length > 1) fail('연동 오버레이가 여러 트랙에 나뉘어 있습니다. 한 전용 트랙으로 모아 주세요.');
  if (managed.some(track => track.transitions || track.items.some(item => !item.owned))) fail('연동 트랙에 다른 클립이나 전환 효과가 있습니다. 오버레이 전용 트랙으로 분리해 주세요.');
  const highestOther = all.reduce((highest, track) => track.items.some(item => !item.owned) || track.transitions ? track.index : highest, -1);
  const target = managed[0] || all.find(track => track.index > highestOther && !track.items.length && !track.transitions && !track.muted);
  if (!target || target.index <= highestOther) fail('영상 트랙 위에 비어 있는 오버레이 전용 영상 트랙을 추가해 주세요.');
  if (target.muted) fail(`V${target.index + 1} 트랙의 표시를 켜 주세요.`);
  return target;
}
const fingerprint = all => JSON.stringify(all.map(track => ({ index: track.index, muted: track.muted, transitions: track.transitions,
  items: track.items.map(({ path, start, end }) => ({ path, start, end })) })));
async function inspect(ppro, bundle, binding) {
  const plan = overlayPlan(bundle, binding);
  const { project, sequence } = await active(ppro, binding);
  const all = await tracks(ppro, sequence, bundle.scope), target = chooseTrack(all);
  return { project, sequence, plan, target, fingerprint: fingerprint(all) };
}
async function findMedia(ppro, root, paths) {
  const found = new Map();
  let visited = 0;
  async function walk(folder) {
    for (const item of await folder.getItems()) {
      if (++visited > 50000) fail('프로젝트 항목이 너무 많습니다. 작은 프로젝트에서 연결해 주세요.');
      let clip = null;
      try { clip = ppro.ClipProjectItem.cast(item); } catch (_) { /* Try folders next. */ }
      if (clip) {
        let path = '';
        try { path = await clip.getMediaFilePath(); } catch (_) { continue; }
        for (const expected of paths) if (samePath(path, expected)) found.set(expected, { clip, projectItem: item });
      } else {
        let nested = null;
        try { nested = ppro.FolderItem.cast(item); } catch (_) { /* Not a folder. */ }
        if (nested) await walk(nested);
      }
    }
  }
  await walk(root);
  return found;
}
function transaction(project, label, build) {
  let ok = false;
  project.lockedAccess(() => {
    const actions = []; build(action => actions.push(action));
    ok = project.executeTransaction(compound => { for (const action of actions) compound.addAction(action); }, label);
  });
  if (!ok) fail('Premiere가 변경을 적용하지 못했습니다. 트랙 잠금과 실행 취소 기록을 확인해 주세요.');
}
async function applyOverlays(ppro, bundle, binding, assets, expectedFingerprint) {
  const before = await inspect(ppro, bundle, binding);
  if (expectedFingerprint !== undefined && expectedFingerprint !== before.fingerprint) fail('트랙 배치가 바뀌었습니다. 적용할 트랙을 다시 확인해 주세요.');
  const { project, sequence, plan, target } = before;
  if (assets.length !== plan.length || assets.some((asset, i) => asset.file !== plan[i].file || !asset.path)) fail('오버레이 파일 준비가 완료되지 않았습니다.');
  if (!plan.length && !target.items.length) return { added: 0, replaced: 0, track: target.index + 1 };
  const root = await project.getRootItem();
  let media = await findMedia(ppro, root, assets.map(asset => asset.path));
  const missing = assets.filter(asset => !media.has(asset.path));
  if (missing.length) {
    if (!await project.importFiles(missing.map(asset => asset.path), true, root, false)) fail('투명 PNG 가져오기에 실패했습니다.');
    media = await findMedia(ppro, root, assets.map(asset => asset.path));
  }
  const prepared = [];
  for (let i = 0; i < assets.length; i++) {
    const entry = media.get(assets[i].path);
    if (!entry) fail('가져온 오버레이 항목을 찾지 못했습니다.');
    const item = entry.clip;
    const interpretation = await item.getFootageInterpretation();
    if (interpretation.setAlphaUsage(interpretation.ALPHACHANNEL_STRAIGHT) === false ||
        interpretation.setIgnoreAlpha(false) === false || interpretation.setInvertAlpha(false) === false ||
        interpretation.setPixelAspectRatio(1) === false) fail('PNG 투명도 설정을 적용할 수 없습니다.');
    prepared.push({ item, projectItem: entry.projectItem, interpretation, ...plan[i], path: assets[i].path });
  }
  // Commit item duration first: overwrite actions use the item's current in/out points.
  if (prepared.length) transaction(project, 'Video Interference 투명 PNG 준비', add => {
    for (const item of prepared) {
      add(item.item.createSetFootageInterpretationAction(item.interpretation));
      add(item.item.createSetInOutPointsAction(ppro.TickTime.createWithSeconds(0), ppro.TickTime.createWithSeconds(item.end - item.start)));
    }
  });
  const current = await active(ppro, binding);
  const latestTracks = await tracks(ppro, current.sequence, bundle.scope);
  if (fingerprint(latestTracks) !== before.fingerprint) fail('파일을 준비하는 동안 트랙이 바뀌었습니다. 시퀀스를 다시 연결해 주세요.');
  const editor = ppro.SequenceEditor.getEditor(sequence);
  let success = false;
  project.lockedAccess(() => {
    const apply = selection => {
      const actions = [];
      if (selection) actions.push(editor.createRemoveItemsAction(selection, false, ppro.Constants.MediaType.VIDEO, false));
      for (const item of prepared) actions.push(editor.createOverwriteItemAction(item.projectItem,
        ppro.TickTime.createWithSeconds(item.start), target.index, -1));
      success = project.executeTransaction(compound => { for (const action of actions) compound.addAction(action); }, 'Video Interference 오버레이 갱신');
    };
    if (target.items.length) ppro.TrackItemSelection.createEmptySelection(selection => {
      for (const item of target.items) if (selection.addItem(item.clip, true) === false) fail('기존 연동 오버레이를 선택하지 못했습니다.');
      apply(selection);
    });
    else apply(null);
  });
  if (!success) fail('오버레이 적용에 실패했습니다. 트랙 잠금과 실행 취소 기록을 확인해 주세요.');
  const actual = (await tracks(ppro, sequence, bundle.scope))[target.index].items.sort((a, b) => a.start - b.start);
  if (actual.length !== prepared.length || actual.some((item, i) => !samePath(item.path, prepared[i].path) ||
      Math.abs(item.start - prepared[i].start) > 1e-7 || Math.abs(item.end - prepared[i].end) > 1e-7)) {
    fail('Premiere가 예상과 다른 길이로 배치했습니다. 바로 실행 취소한 뒤 타임라인을 확인해 주세요.');
  }
  return { added: prepared.length, replaced: target.items.length, track: target.index + 1 };
}
module.exports = { overlayPlan, validatePng, loadAssets, inspect, applyOverlays, chooseTrack };
