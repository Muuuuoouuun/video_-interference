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
    server: { middlewareMode: true, watch: { ignored: ['**/*'] } },
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
function buttonWithText(html, text) {
  const button = (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [])
    .find(tag => tag.replace(/<[^>]*>/g, '').includes(text));
  assert.ok(button, `button containing "${text}" exists`);
  return button.match(/^<button\b[^>]*>/)[0];
}
function assertNoRangeControls(html) {
  assert.doesNotMatch(html, /class="vi-range-selection"/);
  assert.doesNotMatch(html, /aria-label="구간 (?:시작 IN|끝 OUT)"/);
  assert.doesNotMatch(html, /aria-label="(?:IN|OUT) 시간 초"/);
}

test('SSR point mode hides a retained sample range while keeping the saved marker and seek timeline', () => {
  const html = markup();
  assertNoRangeControls(html);
  assert.match(html, /class="vi-point-fields"/);
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
  assert.match(html, /aria-label="IN 시간 초"/);
  assert.match(html, /aria-label="OUT 시간 초"/);
  assert.doesNotMatch(buttonWithText(html, '구간 해제'), /\sdisabled(?:=|\s|>)/);
  assert.doesNotMatch(buttonWithText(html, '구간 반복'), /\sdisabled(?:=|\s|>)/);
  assert.doesNotMatch(html, /class="vi-point-fields"/);
});

test('SSR saved point review offers selection exit without exposing editable range controls', () => {
  const html = markup({ annotationsReadOnly: true, selectedCommentId: comment.id, currentFrame: 420, range: { in: 420, out: 421 } });
  assertNoRangeControls(html);
  assert.match(html, /class="vi-comment-marker vi-comment-selected"/);
  assert.doesNotMatch(buttonWithText(html, '선택 해제'), /\sdisabled(?:=|\s|>)/);
  assert.doesNotMatch(html, /class="vi-loop-button(?:\s|"|$)/);
  assert.doesNotMatch(html, /class="vi-range-start"/);
});
