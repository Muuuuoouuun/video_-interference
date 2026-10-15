const GAP = 6;

// Group overlapping hit areas, not timestamps: resizing the workspace may
// change the groups, but never the saved frame or the sidebar numbering.
export function layoutTimelineMarkers(markers, durationFrames, width) {
  if (!markers.length || !(width > 0) || !(durationFrames > 0)) return [];
  const sorted = [...markers].sort((a, b) => a.frame - b.frame);
  const position = frame => Math.max(0, Math.min(width, frame / durationFrames * width));
  const measure = (start, end, digits) => {
    const count = end - start + 1;
    const badgeWidth = count === 1 ? Math.max(28, 14 + digits * 7)
      : 27 + (digits + String(count - 1).length) * 7;
    const size = Math.min(width, badgeWidth);
    const anchor = (position(sorted[start].frame) + position(sorted[end].frame)) / 2;
    const left = Math.max(size / 2, Math.min(width - size / 2, anchor));
    return { start, end, digits, anchor, left, width: size };
  };
  const groups = [];
  for (let index = 0; index < sorted.length; index++) {
    let next = measure(index, index, String(sorted[index].number).length);
    while (groups.length) {
      const previous = groups.at(-1);
      if (next.left - next.width / 2 >= previous.left + previous.width / 2 + GAP) break;
      groups.pop();
      next = measure(previous.start, next.end, Math.max(previous.digits, next.digits));
    }
    groups.push(next);
  }
  return groups.map(group => ({ key: sorted[group.start].key, items: sorted.slice(group.start, group.end + 1), anchor: group.anchor, left: group.left, width: group.width }));
}
