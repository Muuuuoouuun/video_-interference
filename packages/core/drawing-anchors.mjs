import { projectComment } from './comment-projection.mjs';

const validFrame = frame => Number.isInteger(frame) && frame >= 0;

/** Only an absent frame uses the legacy comment context; malformed explicit frames never do. */
export function drawingFrame(drawing, fallbackFrame) {
  if (!drawing || typeof drawing !== 'object' || Array.isArray(drawing)) throw new RangeError('그림 프레임 데이터가 유효하지 않습니다.');
  const frame = drawing?.frame === undefined ? fallbackFrame : drawing.frame;
  if (!validFrame(frame)) throw new RangeError('그림 프레임은 0 이상의 정수여야 합니다.');
  return frame;
}

/** Sorted frame groups preserve the original drawing order inside each group. Inputs are read-only. */
export function groupDrawings(drawings, fallbackFrame) {
  const groups = new Map();
  for (const drawing of drawings) {
    const frame = drawingFrame(drawing, fallbackFrame);
    const group = groups.get(frame);
    if (group) group.drawings.push(drawing);
    else groups.set(frame, { frame, drawings: [drawing] });
  }
  return [...groups.values()].sort((left, right) => left.frame - right.frame);
}

/** Keep every source entry, including missing anchors. Present clones carry target-version frames. */
export function projectDrawings(comment, authoredVersion, targetVersion) {
  if (!Array.isArray(comment?.drawings)) return [];
  const fallbackFrame = comment.contextFrame ?? comment.frameIn;
  const projections = new Map();
  return comment.drawings.map(drawing => {
    let authoredFrame;
    try { authoredFrame = drawingFrame(drawing, fallbackFrame); }
    catch { return { drawing: structuredClone(drawing), authoredFrame: null, frame: null, status: 'unavailable' }; }
    let projection = projections.get(authoredFrame);
    if (!projection) {
      projection = projectComment({ ...comment, contextFrame: authoredFrame }, authoredVersion, targetVersion);
      projections.set(authoredFrame, projection);
    }
    const status = projection.contextStatus, frame = projection.contextFrame;
    const clone = structuredClone(drawing);
    if (status === 'present') clone.frame = frame;
    return { drawing: clone, authoredFrame, frame, status };
  });
}

/** Replace one editable frame without removing or reordering drawings on other frames.
 * Geometry references are reused; callers edit immutable values and history retains full arrays. */
export function reconcileDrawingFrame(drawings, currentFrame, visibleDrawings, fallbackFrame = currentFrame) {
  if (!validFrame(currentFrame)) throw new RangeError('편집할 그림 프레임이 유효하지 않습니다.');
  const frames = drawings.map(drawing => drawingFrame(drawing, fallbackFrame));
  const protectedIds = new Set(drawings.filter((_, index) => frames[index] !== currentFrame).map(drawing => drawing.id));
  const nextIds = new Set();
  const replacements = visibleDrawings.map(drawing => {
    if (drawing.frame !== undefined && drawingFrame(drawing, currentFrame) !== currentFrame) throw new RangeError('다른 프레임의 그림을 현재 프레임으로 옮길 수 없습니다.');
    if (protectedIds.has(drawing.id) || nextIds.has(drawing.id)) throw new RangeError('그림 ID가 다른 프레임이나 같은 목록과 겹칩니다.');
    nextIds.add(drawing.id);
    return drawing.frame === currentFrame ? drawing : { ...drawing, frame: currentFrame };
  });
  const lastCurrentIndex = frames.lastIndexOf(currentFrame), result = [];
  let replacementIndex = 0;
  for (let index = 0; index < drawings.length; index++) {
    if (frames[index] !== currentFrame) result.push(drawings[index]);
    else if (replacementIndex < replacements.length) result.push(replacements[replacementIndex++]);
    if (index === lastCurrentIndex) while (replacementIndex < replacements.length) result.push(replacements[replacementIndex++]);
  }
  if (lastCurrentIndex < 0) result.push(...replacements);
  return result;
}
