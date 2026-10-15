import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLAPSED_WIDTHS, PANEL_DEFAULTS, PANEL_LIMITS, WORKSPACE_MIN_WIDTH,
  decodePanelWidths, resizePanelWidth, resolvePanelWidths, sanitizePanelWidths,
} from '../packages/core/panel-layout.mjs';

const bothOpen = Object.freeze({ project: true, feedback: true });
const maximum = Object.freeze({ project: 320, feedback: 640 });

test('saved panel widths accept only finite numbers and sanitize each panel independently', () => {
  for (const value of [null, undefined, '', 180, [], [180, 380]]) {
    assert.deepEqual(sanitizePanelWidths(value), { project: 180, feedback: 380 });
  }
  assert.deepEqual(sanitizePanelWidths({ project: 240.5 }), { project: 240.5, feedback: 380 });
  assert.deepEqual(sanitizePanelWidths({ project: -100, feedback: 900 }), { project: 160, feedback: 640 });
  assert.deepEqual(sanitizePanelWidths({ project: 900, feedback: -100 }), { project: 320, feedback: 320 });
  assert.deepEqual(sanitizePanelWidths({ project: '240', feedback: 420 }), { project: 180, feedback: 420 });
  for (const invalid of [NaN, Infinity, -Infinity, false, null, {}, new Number(240)]) {
    assert.deepEqual(sanitizePanelWidths({ project: invalid, feedback: invalid }), PANEL_DEFAULTS);
  }
});

test('storage decoding recovers safely from missing, malformed and wrong-shaped JSON', () => {
  for (const raw of [null, '', '{', 'undefined', 'null', 'false', '[]', '"240"', '{"project":Infinity}']) {
    assert.deepEqual(decodePanelWidths(raw), PANEL_DEFAULTS);
  }
  assert.deepEqual(decodePanelWidths('{"project":250,"feedback":450,"unused":true}'), { project: 250, feedback: 450 });
  assert.deepEqual(decodePanelWidths('{"project":"250","feedback":700}'), { project: 180, feedback: 640 });
});

test('viewport resolution shrinks the project panel first and honors both sidebar minima', () => {
  assert.equal(WORKSPACE_MIN_WIDTH, 440);
  assert.deepEqual(resolvePanelWidths(maximum, 1500, bothOpen), maximum);
  assert.deepEqual(resolvePanelWidths(maximum, 1400, bothOpen), maximum);
  assert.deepEqual(resolvePanelWidths(maximum, 1320, bothOpen), { project: 240, feedback: 640 });
  assert.deepEqual(resolvePanelWidths(maximum, 1200, bothOpen), { project: 160, feedback: 600 });
  assert.deepEqual(resolvePanelWidths(maximum, 1000, bothOpen), { project: 160, feedback: 400 });
  assert.deepEqual(resolvePanelWidths(maximum, 920, bothOpen), { project: 160, feedback: 320 });
  assert.deepEqual(resolvePanelWidths(maximum, 901, bothOpen), { project: 160, feedback: 320 });
  assert.deepEqual(resolvePanelWidths(maximum, 0, bothOpen), { project: 160, feedback: 320 });
  assert.deepEqual(maximum, { project: 320, feedback: 640 });
});

test('collapsed rails consume only their actual width and preserve expanded preferences on reopening', () => {
  assert.deepEqual(resolvePanelWidths(maximum, 1000, { project: false, feedback: true }), { project: 56, feedback: 504 });
  assert.deepEqual(resolvePanelWidths(maximum, 800, { project: true, feedback: false }), { project: 308, feedback: 52 });
  assert.deepEqual(resolvePanelWidths(maximum, 1000, { project: false, feedback: false }), COLLAPSED_WIDTHS);
  assert.deepEqual(resolvePanelWidths(maximum, 1500, bothOpen), maximum);
  for (const width of [NaN, Infinity, -1]) {
    assert.deepEqual(resolvePanelWidths(maximum, width, bothOpen), maximum);
    assert.deepEqual(resolvePanelWidths(maximum, width, { project: false, feedback: true }), { project: 56, feedback: 640 });
  }
});

test('panel dragging applies opposite directions on the left and right and changes only that preference', () => {
  assert.deepEqual(resizePanelWidth('project', PANEL_DEFAULTS, 70, 1200, bothOpen), { project: 250, feedback: 380 });
  assert.deepEqual(resizePanelWidth('project', PANEL_DEFAULTS, -70, 1200, bothOpen), { project: 160, feedback: 380 });
  assert.deepEqual(resizePanelWidth('feedback', PANEL_DEFAULTS, 70, 1200, bothOpen), { project: 180, feedback: 320 });
  assert.deepEqual(resizePanelWidth('feedback', PANEL_DEFAULTS, -150, 1200, bothOpen), { project: 180, feedback: 530 });
  assert.deepEqual(resizePanelWidth('project', PANEL_DEFAULTS, 10000, 1200, bothOpen), { project: 320, feedback: 380 });
  assert.deepEqual(resizePanelWidth('feedback', PANEL_DEFAULTS, -10000, 1200, bothOpen), { project: 180, feedback: 580 });
  assert.deepEqual(resizePanelWidth('feedback', PANEL_DEFAULTS, -10000, 1400, bothOpen), { project: 180, feedback: 640 });
});

test('a compressed panel drag starts at its visible width and uses total displacement without accumulating', () => {
  assert.deepEqual(resolvePanelWidths(maximum, 1200, bothOpen), { project: 160, feedback: 600 });
  assert.deepEqual(resizePanelWidth('feedback', maximum, 1, 1200, bothOpen), { project: 320, feedback: 599 });
  assert.deepEqual(resizePanelWidth('feedback', maximum, 10, 1200, bothOpen), { project: 320, feedback: 590 });
  assert.deepEqual(resizePanelWidth('feedback', maximum, 1, 1200, bothOpen), { project: 320, feedback: 599 });
  assert.deepEqual(resizePanelWidth('feedback', maximum, 0, 1200, bothOpen), maximum);
  assert.deepEqual(resizePanelWidth('project', maximum, -1, 1320, bothOpen), { project: 239, feedback: 640 });
  assert.deepEqual(resizePanelWidth('project', maximum, 100, 1320, bothOpen), { project: 240, feedback: 640 });
});

test('resizing accounts for a collapsed opposite panel and retains stored widths for closed panels', () => {
  assert.deepEqual(resizePanelWidth('project', maximum, 10000, 800, { project: true, feedback: false }), { project: 308, feedback: 640 });
  assert.deepEqual(resizePanelWidth('feedback', maximum, -10000, 1000, { project: false, feedback: true }), { project: 320, feedback: 504 });
  assert.deepEqual(resizePanelWidth('project', maximum, 100, 1200, { project: false, feedback: true }), maximum);
  assert.deepEqual(resizePanelWidth('feedback', maximum, -100, 1200, { project: true, feedback: false }), maximum);
  assert.deepEqual(resizePanelWidth('feedback', maximum, -100, 901, bothOpen), { project: 320, feedback: 320 });
});

test('invalid drag geometry does not replace stored preferences', () => {
  for (const delta of [0, NaN, Infinity, -Infinity]) {
    assert.deepEqual(resizePanelWidth('feedback', maximum, delta, 1200, bothOpen), maximum);
  }
  for (const width of [0, -1, NaN, Infinity]) {
    assert.deepEqual(resizePanelWidth('project', maximum, 10, width, bothOpen), maximum);
  }
  assert.deepEqual(resizePanelWidth('unknown', maximum, 10, 1200, bothOpen), maximum);
});

test('all open/closed combinations preserve the workspace minimum whenever the panel minima fit', () => {
  for (const project of [false, true]) for (const feedback of [false, true]) {
    const open = { project, feedback };
    const sidebarMinimum = (project ? PANEL_LIMITS.project.min : COLLAPSED_WIDTHS.project)
      + (feedback ? PANEL_LIMITS.feedback.min : COLLAPSED_WIDTHS.feedback);
    for (const width of [500, 901, 920, 1000, 1200, 1600]) {
      for (const preferred of [PANEL_DEFAULTS, maximum, { project: 270.5, feedback: 480.25 }]) {
        const actual = resolvePanelWidths(preferred, width, open);
        for (const side of ['project', 'feedback']) {
          if (open[side]) {
            assert.ok(actual[side] >= PANEL_LIMITS[side].min);
            assert.ok(actual[side] <= preferred[side]);
          } else assert.equal(actual[side], COLLAPSED_WIDTHS[side]);
        }
        if (width >= sidebarMinimum + WORKSPACE_MIN_WIDTH) {
          assert.ok(width - actual.project - actual.feedback >= WORKSPACE_MIN_WIDTH);
        }
        for (const side of ['project', 'feedback']) for (const delta of [-10000, -1, 1, 10000]) {
          const next = resizePanelWidth(side, preferred, delta, width, open);
          assert.equal(next[side === 'project' ? 'feedback' : 'project'], preferred[side === 'project' ? 'feedback' : 'project']);
          const resolved = resolvePanelWidths(next, width, open);
          if (width >= sidebarMinimum + WORKSPACE_MIN_WIDTH) {
            assert.ok(width - resolved.project - resolved.feedback >= WORKSPACE_MIN_WIDTH);
          }
        }
      }
    }
  }
});
