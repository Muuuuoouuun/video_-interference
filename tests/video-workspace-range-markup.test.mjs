import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// Pure SSR markup contracts for the real component. No browser, DOM, video
// playback, effects, or pointer/keyboard interaction is executed by these tests.
let server, cache, VideoWorkspace;
before(async () => {
  cache = await mkdtemp(join(tmpdir(), 'video-range-markup-'));
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: cache, envDir: cache,
    server: { middlewareMode: true, hmr: false, ws: false, watch: { ignored: ['**/*'] } },
    appType: 'custom', esbuild: { jsx: 'automatic' },
  });
  ({ VideoWorkspace } = await server.ssrLoadModule('/apps/web/src/components/VideoWorkspace.tsx'));
});
after(async () => { await server?.close(); if (cache) await rm(cache, { recursive: true, force: true }); });

const version = {
  id: 'range-markup-version', assetId: 'range-markup-asset', number: 1, durationFrames: 900,
  mediaUrl: '/media/range-markup.mp4', thumbnailUrl: '/media/range-markup.jpg',
  timelineMap: [{ sourceIn: 0, sourceOut: 900, outputIn: 0, outputOut: 900, speed: 1, volume: 1 }],
};
const comment = {
  id: 'saved-point', versionId: version.id, kind: 'request', text: '여기 자막 수정',
  frameIn: 420, frameOut: 421, contextFrame: 420, sourceRanges: [{ frameIn: 420, frameOut: 421 }],
};
function markup(overrides = {}) {
  return renderToStaticMarkup(React.createElement(VideoWorkspace, {
    version, versions: [version], asset: { id: version.assetId, width: 1920, height: 1080 },
    comments: [comment], selectedCommentId: null, currentFrame: 360,
    range: { in: 150, out: 270 }, rangeAvailable: true, rangeActive: false,
    drawings: [], onFrameChange() {}, onRangeChange() {}, onDrawingsChange() {},
    onCompose() {}, onRangeStart() {}, onRangeClear() {}, ...overrides,
  }));
}
function withLayoutStorage(getItem, render) {
  const previous = globalThis.window;
  globalThis.window = { localStorage: { getItem } };
  try { return render(); }
  finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
}

test('SSR expanded directing workspace exposes a height separator and explicit minimize control', () => {
  const html = markup();
  assert.match(html, /aria-label="영상과 타임라인 높이 조절" aria-orientation="horizontal"/);
  assert.match(html, /aria-label="타임라인 최소화 · 영상 집중" aria-expanded="true"/);
  assert.match(html, /--vi-timeline-height:240px/);
  assert.equal((html.match(/<video\b/g) ?? []).length, 1);
});

test('SSR persisted compact timeline retains seeking, markers and range handles in a 48px dock', () => {
  const html = withLayoutStorage(key => key === 'interference.timeline-compact.v1' ? 'true' : '420', () => markup({ rangeActive: true }));
  assert.match(html, /data-timeline-compact="true"/);
  assert.match(html, /--vi-timeline-height:48px/);
  assert.doesNotMatch(html, /aria-label="영상과 타임라인 높이 조절"/);
  const toggle = html.match(/<button[^>]*aria-label="타임라인 펼치기"[^>]*>/)?.[0];
  assert.ok(toggle);
  assert.match(toggle, /aria-expanded="false"/);
  const controlledId = toggle.match(/aria-controls="([^"]+)"/)[1];
  assert.ok(html.includes(`<div id="${controlledId}" hidden="">`));
  assert.match(html, /aria-label="재생 위치"/);
  assert.match(html, /aria-label="피드백 1: 00:14\.00 여기 자막 수정"/);
  assert.match(html, /aria-label="구간 시작 IN"/);
  assert.match(html, /aria-label="구간 끝 OUT"/);
  assert.match(html, /aria-label="구간 해제"/);
  assert.match(html, /aria-label="그림 도구" aria-expanded="false"/);
  assert.match(html, /class="vi-filmstrip" hidden=""[^>]*aria-busy="false"/);
  assert.doesNotMatch(html, /aria-label="타임라인 상세 정보"/);
  assert.equal((html.match(/<video\b/g) ?? []).length, 1);
});

test('SSR layout remains available when persisted settings cannot be read', () => {
  const html = withLayoutStorage(() => { throw new Error('storage unavailable'); }, () => markup());
  assert.match(html, /data-timeline-compact="false"/);
  assert.match(html, /--vi-timeline-height:240px/);
  assert.match(html, /aria-label="타임라인 최소화 · 영상 집중"/);
});
function buttonWithText(html, text) {
  const button = (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [])
    .find(tag => tag.replace(/<[^>]*>/g, '').includes(text));
  assert.ok(button, `button containing "${text}" exists`);
  return button.match(/^<button\b[^>]*>/)[0];
}
function assertNoRangeControls(html) {
  assert.doesNotMatch(html, /class="vi-range-selection"/);
  assert.doesNotMatch(html, /aria-label="구간 (?:시작 IN|끝 OUT)"/);
  assert.doesNotMatch(html, /aria-label="구간 (?:시작|끝) 시간"/);
}

test('SSR point mode hides a retained sample range while keeping the saved marker and seek timeline', () => {
  const html = markup();
  assertNoRangeControls(html);
  assert.match(html, /class="vi-point-fields vi-selection"/);
  assert.match(html, /class="vi-timeline"/);
  assert.match(html, /class="vi-playhead"/);
  assert.match(html, /aria-label="피드백 1: 00:14\.00 여기 자막 수정"/);
  assert.match(html, /class="vi-overlay-controls"/);
  assert.doesNotMatch(buttonWithText(html, '구간 지정'), /\sdisabled(?:=|\s|>)/);
  assert.doesNotMatch(html, /class="vi-loop-button(?:\s|"|$)/);
});

test('SSR active range exposes both endpoints and an explicit clear action', () => {
  const html = markup({ rangeActive: true });
  assert.match(html, /class="vi-range-selection"/);
  assert.match(html, /aria-label="구간 시작 IN"[^>]*aria-valuenow="150"/);
  assert.match(html, /aria-label="구간 끝 OUT"[^>]*aria-valuenow="270"/);
  assert.match(html, /aria-label="구간 시작 시간"/);
  assert.match(html, /aria-label="구간 끝 시간"/);
  assert.doesNotMatch(buttonWithText(html, '구간 해제'), /\sdisabled(?:=|\s|>)/);
  assert.doesNotMatch(buttonWithText(html, '구간 반복'), /\sdisabled(?:=|\s|>)/);
  assert.doesNotMatch(html, /class="vi-point-fields vi-selection"/);
});

test('SSR saved range spans remain with numbered markers without a selection or while drafting elsewhere', () => {
  const saved = { ...comment, id: 'saved-range', frameIn: 150, frameOut: 270, sourceRanges: [{ frameIn: 150, frameOut: 270 }] };
  for (const rangeActive of [false, true]) {
    const html = markup({ comments: [comment, saved], rangeActive, range: { in: 600, out: 720 } });
    assert.match(html, /class="vi-saved-ranges" aria-hidden="true"/);
    assert.match(html, /class="vi-range-selection vi-saved-range" data-marker-key="saved-range-0" data-feedback-category="video" style="left:16\.666666666666664%;width:13\.333333333333334%"/);
    assert.doesNotMatch(html, /data-marker-key="saved-point-0"/);
    assert.equal((html.match(/class="vi-comment-marker/g) ?? []).length, 2);
    assert.equal((html.match(/class="vi-range-selection vi-saved-range"/g) ?? []).length, 1);
  }
});

test('SSR selected saved range is drawn once while other overlapping saved ranges stay visible', () => {
  const saved = { ...comment, id: 'saved-range', frameIn: 150, frameOut: 270, sourceRanges: [{ frameIn: 150, frameOut: 270 }] };
  const overlap = { ...saved, id: 'overlap', frameOut: 300, sourceRanges: [{ frameIn: 150, frameOut: 300 }] };
  const html = markup({ comments: [saved, overlap], selectedCommentId: saved.id, annotationsReadOnly: true, rangeActive: true, range: { in: 150, out: 270 } });
  assert.doesNotMatch(html, /data-marker-key="saved-range-0"/);
  assert.match(html, /data-marker-key="overlap-0"/);
  assert.equal((html.match(/class="vi-range-selection" data-readonly="true"/g) ?? []).length, 1);
  assert.match(html, /aria-label="가까운 마커 2개 · 피드백 1, 피드백 2"/);
});

test('SSR cut feedback keeps separate surviving spans and removes fully deleted spans', () => {
  const cut = { ...version, id: 'cut', durationFrames: 600, timelineMap: [
    { sourceIn: 0, sourceOut: 300, outputIn: 0, outputOut: 300, speed: 1, volume: 1 },
    { sourceIn: 600, sourceOut: 900, outputIn: 300, outputOut: 600, speed: 1, volume: 1 },
  ] };
  const partial = { ...comment, id: 'partial', frameIn: 250, frameOut: 650, sourceRanges: [{ frameIn: 250, frameOut: 650 }] };
  const deleted = { ...comment, id: 'deleted', frameIn: 350, frameOut: 400, sourceRanges: [{ frameIn: 350, frameOut: 400 }] };
  const html = markup({ version: cut, versions: [version, cut], comments: [partial, deleted] });
  assert.match(html, /data-marker-key="partial-0" data-feedback-category="video" style="left:41\.66666666666667%;width:8\.333333333333332%"/);
  assert.match(html, /data-marker-key="partial-1" data-feedback-category="video" style="left:50%;width:8\.333333333333332%"/);
  assert.doesNotMatch(html, /data-marker-key="deleted-/);
});

test('SSR saved point review offers selection exit without exposing editable range controls', () => {
  const html = markup({ annotationsReadOnly: true, selectedCommentId: comment.id, currentFrame: 420, range: { in: 420, out: 421 } });
  assertNoRangeControls(html);
  assert.match(html, /class="vi-comment-marker vi-comment-selected"/);
  assert.doesNotMatch(buttonWithText(html, '선택 해제'), /\sdisabled(?:=|\s|>)/);
  assert.doesNotMatch(html, /class="vi-loop-button(?:\s|"|$)/);
  assert.doesNotMatch(html, /class="vi-range-start"/);
});

test('SSR player and marker use the same rounded timestamp as comment labels', () => {
  const html = markup({ currentFrame: 2, comments: [{ ...comment, frameIn: 2, frameOut: 3, contextFrame: 2, sourceRanges: [{ frameIn: 2, frameOut: 3 }] }] });
  assert.match(html, /<strong>00:00\.07<\/strong>/);
  assert.match(html, /aria-label="피드백 1: 00:00\.07 여기 자막 수정"/);
  assert.match(html, /title="피드백 1 · 00:00\.07 · 여기 자막 수정 · 영상"/);
  assert.doesNotMatch(html, /00:00\.06/);
});

test('SSR clustered feedback exposes its count and preserves the selected sidebar number', () => {
  const html = markup({ comments: [comment, { ...comment, id: 'second', text: '두 번째 댓글' }], selectedCommentId: 'second' });
  assert.match(html, /aria-label="가까운 마커 2개 · 피드백 1, 피드백 2"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /class="vi-marker-number">2<\/span>/);
  assert.match(html, /class="vi-marker-count">\+1<\/span>/);
  assert.equal((html.match(/class="vi-comment-marker/g) ?? []).length, 1);
});

test('SSR ruler keeps complete minute labels past 100 minutes', () => {
  const longVersion = { ...version, durationFrames: 180000 };
  const html = markup({ version: longVersion, versions: [longVersion], comments: [] });
  assert.match(html, /<span[^>]*>100:00<\/span>/);
});

test('SSR saved ranges remain readable outputs and static bounds while the playhead moves', () => {
  for (const currentFrame of [0, 360, 899]) {
    const html = markup({ annotationsReadOnly: true, rangeActive: true, range: { in: 150, out: 900 }, currentFrame });
    assert.match(html, /aria-label="저장된 댓글 구간"/);
    assert.match(html, /<output[^>]*aria-label="시작 시간">00:05\.00<\/output>/);
    assert.match(html, /<output[^>]*aria-label="끝 시간">00:30\.00<\/output>/);
    assert.doesNotMatch(html, /role="slider" aria-label="구간/);
    assert.doesNotMatch(html, /aria-label="구간 (?:시작|끝) 시간"/);
    assert.match(html, /class="vi-range-boundary vi-range-out"[^>]*left:100%/);
    assert.doesNotMatch(buttonWithText(html, '선택 해제'), /\sdisabled(?:=|\s|>)/);
  }
});

test('SSR detail tracks start collapsed and do not mount attachment media until expanded', () => {
  const html = markup({
    comments: [{ ...comment, attachmentIds: ['reference-image'] }],
    attachments: [{ id: 'reference-image', name: '시안.png', role: 'reference', mimeType: 'image/png', mediaUrl: '/private/reference.png' }],
  });
  const toggle = buttonWithText(html, '구간·시안 펼치기');
  assert.match(toggle, /aria-expanded="false"/);
  assert.match(toggle, /aria-controls="[^"]+"/);
  assert.doesNotMatch(html, /class="vi-details-tracks"/);
  assert.doesNotMatch(html, /private\/reference\.png/);
});

test('SSR exposes a focused seek ruler without flattening the interactive comment marker group', () => {
  const html = markup();
  assert.match(html, /class="vi-timeline-seek-surface" role="group" aria-label="영상 시간축 탐색"/);
  assert.match(html, /class="vi-timeline-ruler" role="slider"[^>]*tabindex="0"[^>]*aria-label="재생 위치"[^>]*aria-valuemax="899"[^>]*aria-valuenow="360"/);
  const rulerStart = html.indexOf('class="vi-timeline-ruler"');
  const rulerEnd = html.indexOf('</div>', rulerStart);
  assert.ok(rulerEnd < html.indexOf('class="vi-marker-rail"'));
  assert.match(html, /role="group" aria-label="타임라인 댓글 마커"/);
  assert.match(markup({ editingLocked: true }), /class="vi-timeline-ruler" role="slider"[^>]*tabindex="-1"[^>]*aria-disabled="true"/);
});


test('SSR categories color saved pins, projected spans and the selected range consistently', () => {
  for (const category of ['subtitle', 'video', 'audio', 'effect', 'note']) {
    const saved = { ...comment, id: 'colored', kind: category === 'note' ? 'note' : 'request', category: category === 'note' ? undefined : category, frameIn: 150, frameOut: 270, sourceRanges: [{ frameIn: 150, frameOut: 270 }] };
    const unselected = markup({ comments: [saved] });
    assert.match(unselected, new RegExp(`class="vi-comment-marker" data-feedback-category="${category}"`));
    assert.match(unselected, new RegExp(`data-marker-key="colored-0" data-feedback-category="${category}"`));
    const selected = markup({ comments: [saved], selectedCommentId: saved.id, annotationsReadOnly: true, rangeActive: true, range: { in: 150, out: 270 } });
    assert.match(selected, new RegExp(`class="vi-timeline" data-feedback-category="${category}"`));
    assert.doesNotMatch(selected, /data-marker-key="colored-0"/);
  }
  const mixed = markup({ comments: [comment, { ...comment, id: 'sound', category: 'audio' }] });
  assert.match(mixed, /data-mixed="true"/);
  assert.match(mixed, /aria-description="영상·사운드 분야"/);
});
