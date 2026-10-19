import { drawingFrame } from './drawing-anchors.mjs';
import { normalizeDrawing } from './overlay-geometry.mjs';

export const DRAWING_HISTORY_LIMIT = 50;
const DEFAULT_CONTEXT_LIMIT = 8;
const ownedDrawings = new WeakSet();

function samePoints(left, right) {
  return left === right || Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((point, index) => point.x === right[index].x && point.y === right[index].y);
}

function sameRegion(left, right) {
  return left === right || Boolean(left && right && left.x === right.x && left.y === right.y && left.w === right.w && left.h === right.h);
}

/** Includes stacking order through drawingsEqual; no serialization or coordinate allocation. */
export function drawingEqual(left, right, fallbackFrame) {
  return left === right || Boolean(left && right && left.id === right.id && left.kind === right.kind && left.text === right.text &&
    drawingFrame(left, fallbackFrame) === drawingFrame(right, fallbackFrame) && left.color === right.color &&
    (left.strokeWidth ?? 3) === (right.strokeWidth ?? 3) && (left.opacity ?? 1) === (right.opacity ?? 1) &&
    (left.fill ?? 'none') === (right.fill ?? 'none') && sameRegion(left.region, right.region) && samePoints(left.points, right.points));
}

export function drawingsEqual(left, right, fallbackFrame) {
  return left === right || left.length === right.length && left.every((drawing, index) => drawingEqual(drawing, right[index], fallbackFrame));
}

/** Include additions, removals, frame moves, geometry/style edits, and stacking-order changes. */
export function changedDrawingFrames(before, after, fallbackFrame) {
  const previous = new Map(before.map(drawing => [drawing.id, drawing]));
  const changed = new Set();
  for (const drawing of after) {
    const original = previous.get(drawing.id);
    if (!original || !drawingEqual(original, drawing, fallbackFrame)) {
      changed.add(drawingFrame(drawing, fallbackFrame));
      if (original) changed.add(drawingFrame(original, fallbackFrame));
    }
    previous.delete(drawing.id);
  }
  for (const drawing of previous.values()) changed.add(drawingFrame(drawing, fallbackFrame));
  // Only order within one displayed scene affects stacking. Another scene's insertion
  // must not report all subsequent scenes as changed merely because array indices shift.
  const orderByFrame = drawings => {
    const groups = new Map();
    for (const drawing of drawings) {
      const frame = drawingFrame(drawing, fallbackFrame);
      if (!groups.has(frame)) groups.set(frame, []);
      groups.get(frame).push(drawing.id);
    }
    return groups;
  };
  const beforeOrder = orderByFrame(before), afterOrder = orderByFrame(after);
  for (const [frame, ids] of afterOrder) {
    const original = beforeOrder.get(frame);
    if (!original || ids.length !== original.length || ids.some((id, index) => id !== original[index])) changed.add(frame);
  }
  return [...changed].sort((left, right) => left - right);
}

function capture(drawings, previous, fallbackFrame) {
  if (drawings === previous) return previous;
  const byId = new Map(previous.map(drawing => [drawing.id, drawing]));
  const ids = new Set();
  const next = drawings.map(drawing => {
    if (ids.has(drawing.id)) throw new RangeError('그림 기록에 중복된 ID가 있습니다.');
    ids.add(drawing.id);
    const frame = drawingFrame(drawing, fallbackFrame), prior = byId.get(drawing.id);
    if (prior && drawingEqual(drawing, prior, fallbackFrame)) return prior;
    if (ownedDrawings.has(drawing)) return drawing;
    const normalized = { ...normalizeDrawing(drawing), frame };
    // A style change shares the potentially large pen geometry with its earlier snapshot.
    normalized.points = prior && samePoints(normalized.points, prior.points) ? prior.points :
      Object.freeze(normalized.points.map(point => Object.freeze(point)));
    if (normalized.region) normalized.region = prior && sameRegion(normalized.region, prior.region) ? prior.region : Object.freeze(normalized.region);
    if (prior && drawingEqual(normalized, prior, fallbackFrame)) return prior;
    Object.freeze(normalized);
    ownedDrawings.add(normalized);
    return normalized;
  });
  return next.length === previous.length && next.every((drawing, index) => drawing === previous[index]) ? previous : Object.freeze(next);
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function createSession(drawings, fallbackFrame, limit) {
  let present = capture(drawings, Object.freeze([]), fallbackFrame);
  let past = [], future = [], groupStart = null;
  const remember = previous => {
    past.push(previous);
    if (past.length > limit) past.shift();
    future = [];
  };
  const session = {
    get present() { return present; },
    get past() { return Object.freeze([...past]); },
    get future() { return Object.freeze([...future]); },
    get canUndo() { return past.length > 0 || groupStart !== null && !drawingsEqual(groupStart, present, fallbackFrame); },
    get canRedo() { return future.length > 0 && (groupStart === null || drawingsEqual(groupStart, present, fallbackFrame)); },
    get grouping() { return groupStart !== null; },
    /** A real external replacement clears all history; equal React/server echoes retain it. */
    sync(drawings, nextFallbackFrame = fallbackFrame) {
      const next = capture(drawings, present, nextFallbackFrame);
      fallbackFrame = nextFallbackFrame;
      if (next === present) return false;
      present = next;
      past = [];
      future = [];
      groupStart = null;
      return true;
    },
    commit(drawings) {
      const next = capture(drawings, present, fallbackFrame);
      session.endGroup();
      if (drawingsEqual(next, present, fallbackFrame)) return false;
      remember(present);
      present = next;
      return true;
    },
    beginGroup() {
      if (groupStart === null) groupStart = present;
    },
    updateGroup(drawings) {
      const next = capture(drawings, present, fallbackFrame);
      if (next === present) return false;
      session.beginGroup();
      present = next;
      return true;
    },
    endGroup() {
      if (groupStart === null) return false;
      const before = groupStart;
      groupStart = null;
      if (drawingsEqual(before, present, fallbackFrame)) { present = before; return false; }
      remember(before);
      return true;
    },
    undo() {
      session.endGroup();
      if (!past.length) return null;
      future.push(present);
      present = past.pop();
      return present;
    },
    redo() {
      session.endGroup();
      if (!future.length) return null;
      past.push(present);
      if (past.length > limit) past.shift();
      present = future.pop();
      return present;
    },
  };
  return Object.freeze(session);
}

/** Keep one store above the editable/review switch. Only activate editable draft keys.
 * Keys should include project, version and draft generation. Least-recently activated
 * contexts are evicted at maxContexts; each retained context has at most limit undo steps.
 * Snapshots are deeply frozen and must be edited through new objects/arrays. */
export function createDrawingHistoryStore({ limit = DRAWING_HISTORY_LIMIT, maxContexts = DEFAULT_CONTEXT_LIMIT } = {}) {
  positiveInteger(limit, 'limit');
  if (limit > DRAWING_HISTORY_LIMIT) throw new RangeError(`limit must be at most ${DRAWING_HISTORY_LIMIT}.`);
  positiveInteger(maxContexts, 'maxContexts');
  const sessions = new Map();
  let activeKey = null;
  return Object.freeze({
    get size() { return sessions.size; },
    activate(key, drawings, fallbackFrame) {
      if (typeof key !== 'string' || !key.length) throw new TypeError('그림 기록에는 비어 있지 않은 문맥 키가 필요합니다.');
      if (activeKey !== key) sessions.get(activeKey)?.endGroup();
      let session = sessions.get(key);
      if (session) session.sync(drawings, fallbackFrame);
      else session = createSession(drawings, fallbackFrame, limit);
      sessions.delete(key);
      sessions.set(key, session);
      activeKey = key;
      while (sessions.size > maxContexts) sessions.delete(sessions.keys().next().value);
      return session;
    },
    get(key) { return sessions.get(key); },
    delete(key) {
      if (activeKey === key) activeKey = null;
      return sessions.delete(key);
    },
    clear() { sessions.clear(); activeKey = null; },
  });
}
