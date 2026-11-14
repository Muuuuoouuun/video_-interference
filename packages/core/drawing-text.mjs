const kindLabels = { rect: '박스', ellipse: '원', line: '선', arrow: '화살표', pen: '펜', text: '텍스트' };
const colorNames = [
  ['빨간', [230, 40, 40]], ['주황', [245, 140, 30]], ['노란', [240, 220, 40]], ['초록', [40, 170, 70]], ['하늘색', [60, 190, 235]],
  ['파란', [40, 90, 230]], ['보라', [140, 70, 200]], ['분홍', [240, 110, 180]], ['흰', [245, 245, 245]], ['회색', [128, 128, 128]], ['검은', [20, 20, 20]],
];
const round = value => Math.round(value * 10_000) / 10_000;
const percent = value => Math.round(value * 100);
const clamp = value => Math.max(0, Math.min(1, value));

/** Nearest plain color word for a #RRGGBB value; unknown formats keep the raw value only. */
export function colorName(hex) {
  const match = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ''));
  if (!match) return '';
  const rgb = match.slice(1).map(part => parseInt(part, 16));
  let best = colorNames[0], distance = Infinity;
  for (const entry of colorNames) {
    const next = entry[1].reduce((sum, channel, index) => sum + (channel - rgb[index]) ** 2, 0);
    if (next < distance) { best = entry; distance = next; }
  }
  return best[0];
}

/** Normalized bounding box [x, y, w, h], rounded to 1/10000 of the frame for compact text outputs. */
export function drawingBox(drawing) {
  const points = Array.isArray(drawing?.points) ? drawing.points : [];
  let box;
  if (['rect', 'ellipse', 'text'].includes(drawing?.kind) && drawing.region) box = drawing.region;
  else if (points.length) {
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  } else return null;
  return [round(clamp(box.x)), round(clamp(box.y)), round(clamp(box.w)), round(clamp(box.h))];
}

function area(x, y) {
  const horizontal = x < 1 / 3 ? '왼쪽' : x > 2 / 3 ? '오른쪽' : '가운데';
  const vertical = y < 1 / 3 ? '위' : y > 2 / 3 ? '아래' : '가운데';
  if (horizontal === '가운데' && vertical === '가운데') return '화면 가운데';
  if (horizontal === '가운데') return `화면 ${vertical}쪽 가운데`;
  return `화면 ${horizontal} ${vertical}`;
}

const span = (start, length) => length < 0.005 ? `${percent(start)}%` : `${percent(start)}–${percent(start + length)}%`;

/** One Korean sentence that locates a request drawing without opening an image. Coordinates stay normalized. */
export function describeDrawing(drawing) {
  const box = drawingBox(drawing);
  const label = kindLabels[drawing?.kind] || '그림';
  const color = colorName(drawing?.color);
  const fill = ['rect', 'ellipse'].includes(drawing?.kind) && drawing?.fill && drawing.fill !== 'none' ? ', 채움' : '';
  const head = `${color ? `${color} ` : ''}${label}(${drawing?.color || '색 미지정'}${fill})`;
  if (!box) return `${head} · 위치 정보 없음`;
  const [x, y, w, h] = box;
  if (['line', 'arrow'].includes(drawing.kind) && drawing.points?.length === 2) {
    const [start, end] = drawing.points;
    const direction = drawing.kind === 'arrow' ? `${area(start.x, start.y)}에서 ${area(end.x, end.y).replace(/^화면 /, '')} 쪽을 가리킴` : `${area(start.x, start.y)}에서 ${area(end.x, end.y).replace(/^화면 /, '')}까지`;
    return `${head} · ${direction} · 시작 (가로 ${percent(start.x)}%, 세로 ${percent(start.y)}%) → 끝 (가로 ${percent(end.x)}%, 세로 ${percent(end.y)}%)`;
  }
  const where = area(x + w / 2, y + h / 2);
  const coverage = Math.max(1, Math.round(w * h * 100));
  let shape = '';
  if (drawing.kind === 'pen') {
    const points = drawing.points || [], first = points[0], last = points.at(-1);
    const closed = points.length > 5 && Math.hypot(first.x - last.x, first.y - last.y) < 0.2 * Math.max(w, h, 0.01);
    shape = points.length === 1 ? ' · 점 하나' : closed ? ' · 영역을 둘러싼 표시' : ' · 그은 선';
  }
  if (drawing.kind === 'text' && drawing.text?.trim()) shape = ` · 글자 “${drawing.text.replace(/\s+/g, ' ').trim()}”`;
  return `${head} · ${where} · 가로 ${span(x, w)}, 세로 ${span(y, h)} (화면의 약 ${coverage}%)${shape}`;
}
