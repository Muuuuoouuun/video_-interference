import { randomUUID } from 'node:crypto';

const kinds = new Set(['rect', 'ellipse', 'line', 'arrow', 'pen']);
const colorPattern = /^#[a-f\d]{6}$/i;
const error = message => Object.assign(new Error(message), { status: 400 });
const numberIn = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const fields = new Set(['id', 'kind', 'color', 'points', 'region', 'strokeWidth', 'opacity', 'fill', 'frame']);

/** Styles stay optional so persisted v0.1 annotations retain their original JSON shape. */
export function validateDrawings(value = [], { durationFrames } = {}) {
  if (!Array.isArray(value) || value.length > 30) throw error('드로잉은 요청마다 최대 30개를 저장할 수 있습니다.');
  return value.map(drawing => {
    if (!drawing || typeof drawing !== 'object' || Array.isArray(drawing) || Object.keys(drawing).some(key => !fields.has(key))) throw error('드로잉 형식이 유효하지 않습니다.');
    if (!kinds.has(drawing.kind)) throw error('지원하지 않는 드로잉 도구입니다.');
    if (!colorPattern.test(drawing.color || '')) throw error('드로잉 색상은 #RRGGBB 형식이어야 합니다.');
    if (!Array.isArray(drawing.points) || drawing.points.length > 2000 || drawing.points.some(p => !p || typeof p !== 'object' || Object.keys(p).some(key => !['x', 'y'].includes(key)) || !numberIn(p.x, 0, 1) || !numberIn(p.y, 0, 1))) throw error('드로잉 좌표가 유효하지 않습니다.');
    const region = drawing.region;
    if (region && (typeof region !== 'object' || Array.isArray(region) || Object.keys(region).some(key => !['x', 'y', 'w', 'h'].includes(key)) || !numberIn(region.x, 0, 1) || !numberIn(region.y, 0, 1) || !numberIn(region.w, Number.EPSILON, 1) || !numberIn(region.h, Number.EPSILON, 1) || region.x + region.w > 1.00001 || region.y + region.h > 1.00001)) throw error('드로잉 영역이 화면을 벗어났습니다.');
    if (['line', 'arrow'].includes(drawing.kind) && drawing.points.length !== 2) throw error('선과 화살표에는 시작점과 끝점이 필요합니다.');
    if (drawing.kind === 'pen' && !drawing.points.length) throw error('펜 드로잉에는 한 개 이상의 점이 필요합니다.');
    if (['rect', 'ellipse'].includes(drawing.kind) && !region && drawing.points.length !== 2) throw error('사각형과 타원에는 영역 또는 두 모서리 점이 필요합니다.');
    if (['rect', 'ellipse'].includes(drawing.kind) && !region && (drawing.points[0].x === drawing.points[1].x || drawing.points[0].y === drawing.points[1].y)) throw error('사각형과 타원의 영역은 너비와 높이가 있어야 합니다.');
    if (drawing.strokeWidth !== undefined && !numberIn(drawing.strokeWidth, 0.25, 64)) throw error('선 두께는 기준 영상 너비 1000에서 0.25~64 사이여야 합니다.');
    if (drawing.opacity !== undefined && !numberIn(drawing.opacity, 0, 1)) throw error('드로잉 투명도는 0~1 사이여야 합니다.');
    if (drawing.fill !== undefined && drawing.fill !== 'none' && !colorPattern.test(drawing.fill)) throw error('드로잉 채우기는 #RRGGBB 또는 none 형식이어야 합니다.');
    if (drawing.frame !== undefined && (!Number.isInteger(drawing.frame) || drawing.frame < 0 || durationFrames !== undefined && drawing.frame >= durationFrames)) throw error('그림 기준 프레임은 작성 버전의 실제 정수 프레임이어야 합니다.');
    const shape = { id: String(drawing.id || `drawing_${randomUUID().slice(0, 12)}`).slice(0, 80), kind: drawing.kind, color: drawing.color, points: drawing.points.map(p => ({ x: p.x, y: p.y })) };
    if (region) shape.region = { x: region.x, y: region.y, w: region.w, h: region.h };
    for (const key of ['strokeWidth', 'opacity', 'fill', 'frame']) if (drawing[key] !== undefined) shape[key] = drawing[key];
    return shape;
  });
}

/** SVG viewBox is 1000 units wide; every style scales with the source video width. */
export function assertStaticDrawingFrames(drawings) {
  if (!Array.isArray(drawings) || !drawings.length) throw error('영상에 넣을 드로잉이 필요합니다.');
  const frames = new Set();
  for (const drawing of drawings) if (drawing?.frame !== undefined) {
    if (!Number.isInteger(drawing.frame) || drawing.frame < 0) throw error('그림 기준 프레임은 0 이상의 정수여야 합니다.');
    frames.add(drawing.frame);
  }
  if (frames.size > 1) throw error('여러 장면의 그림은 함께 삽입할 수 없습니다. 한 장면의 그림을 새 요청에 복사해 삽입해 주세요.');
}

export function drawingsSvg(width, height, drawings) {
  const viewportHeight = 1000 * height / width;
  const px = point => ({ x: point.x * 1000, y: point.y * viewportHeight });
  const validated = validateDrawings(drawings);
  assertStaticDrawingFrames(validated);
  const shapes = validated.map(drawing => {
    const strokeWidth = drawing.strokeWidth ?? 3, opacity = drawing.opacity ?? 1;
    const fill = ['rect', 'ellipse'].includes(drawing.kind) ? drawing.fill ?? 'none' : 'none';
    const attrs = `stroke="${drawing.color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" fill="${fill}"`;
    let body;
    if (['rect', 'ellipse'].includes(drawing.kind)) {
      const a = drawing.points[0], b = drawing.points[1];
      const region = drawing.region || { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      const x = region.x * 1000, y = region.y * viewportHeight, w = region.w * 1000, h = region.h * viewportHeight;
      body = drawing.kind === 'rect' ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${attrs}/>` : `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${attrs}/>`;
    } else if (drawing.kind === 'pen') {
      const points = drawing.points.map(px);
      body = points.length === 1 ? `<circle cx="${points[0].x}" cy="${points[0].y}" r="${strokeWidth / 2}" fill="${drawing.color}"/>` : `<path d="${points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ')}" ${attrs}/>`;
    } else {
      const a = px(drawing.points[0]), b = px(drawing.points[1]);
      body = `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ${attrs}/>`;
      if (drawing.kind === 'arrow') {
        const angle = Math.atan2(b.y - a.y, b.x - a.x), length = Math.max(9, strokeWidth * 4), halfWidth = Math.max(4.5, strokeWidth * 2.2);
        const back = { x: b.x - Math.cos(angle) * length, y: b.y - Math.sin(angle) * length };
        const left = { x: back.x + Math.sin(angle) * halfWidth, y: back.y - Math.cos(angle) * halfWidth };
        const right = { x: back.x - Math.sin(angle) * halfWidth, y: back.y + Math.cos(angle) * halfWidth };
        body += `<polygon points="${b.x},${b.y} ${left.x},${left.y} ${right.x},${right.y}" fill="${drawing.color}"/>`;
      }
    }
    return `<g opacity="${opacity}">${body}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 ${viewportHeight}">${shapes}</svg>`;
}
