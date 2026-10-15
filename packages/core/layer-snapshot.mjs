const conflict = message => Object.assign(new Error(message), { status: 409 });
export const isVisualOp = op => op?.type === 'subtitle' || op?.type === 'overlay';
export const visualLayerId = op => op.layerId ?? op.id;
const sameRanges = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Resolve changes against the immutable parent, keeping replacement layers in their stack slot. */
export function resolveLayerSnapshot(inherited, selected) {
  const snapshot = structuredClone(inherited);
  const layers = new Map();
  for (let index = 0; index < inherited.length; index++) {
    const op = inherited[index];
    if (!isVisualOp(op)) continue;
    const id = visualLayerId(op);
    if (typeof id !== 'string' || !id || layers.has(id)) throw conflict('기준 버전의 그래픽 식별자가 중복되거나 유효하지 않습니다.');
    layers.set(id, { op, index });
  }
  const changed = new Set(), removed = new Set(), additions = [];
  for (const op of selected) {
    if (!op.layerChange) {
      if (isVisualOp(op)) {
        const id = visualLayerId(op);
        if (typeof id !== 'string' || !id || layers.has(id)) throw conflict('새 그래픽의 식별자가 기존 그래픽과 겹칩니다.');
        layers.set(id, { op, index: -1 });
      }
      additions.push(structuredClone(op)); continue;
    }
    const change = op.layerChange;
    if (!isVisualOp(op) || !['replace', 'remove'].includes(change.action) || typeof change.targetLayerId !== 'string' || typeof change.targetOpId !== 'string' || op.layerId !== change.targetLayerId) throw conflict('그래픽 변경 대상이 유효하지 않습니다.');
    const target = layers.get(change.targetLayerId);
    if (!target || target.index < 0) throw conflict('변경할 그래픽이 기준 버전에 없습니다.');
    if (target.op.id !== change.targetOpId) throw conflict('그래픽이 다른 내용으로 변경되었습니다. 현재 버전에서 다시 선택해 주세요.');
    if (changed.has(change.targetLayerId)) throw conflict('같은 그래픽의 변경 요청을 동시에 적용할 수 없습니다. 하나만 승인해 주세요.');
    if (op.type !== target.op.type || !sameRanges(op.sourceRanges, target.op.sourceRanges)) throw conflict('그래픽 변경은 기존 종류와 원본 구간을 유지해야 합니다.');
    changed.add(change.targetLayerId);
    if (change.action === 'remove') removed.add(target.index);
    else {
      const replacement = structuredClone(op);
      delete replacement.layerChange;
      snapshot[target.index] = replacement;
    }
  }
  return [...snapshot.filter((_, index) => !removed.has(index)), ...additions];
}
