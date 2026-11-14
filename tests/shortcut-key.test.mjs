import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnterSubmit, shortcutKey } from '../packages/core/shortcut-key.mjs';

test('shortcuts keep the typed ASCII key and named keys on any Latin layout', () => {
  assert.equal(shortcutKey({ key: 'c', code: 'KeyC' }), 'c');
  assert.equal(shortcutKey({ key: 'C', code: 'KeyC', shiftKey: true }), 'c');
  assert.equal(shortcutKey({ key: 'c', code: 'KeyI' }), 'c', 'Dvorak: the typed letter wins over the physical position');
  assert.equal(shortcutKey({ key: '?', code: 'Slash', shiftKey: true }), '?');
  assert.equal(shortcutKey({ key: 'ArrowLeft', code: 'ArrowLeft' }), 'arrowleft');
  assert.equal(shortcutKey({ key: 'Escape', code: 'Escape' }), 'escape');
  assert.equal(shortcutKey({ key: ' ', code: 'Space' }), ' ');
});

test('a Hangul input source resolves every letter shortcut from its physical key', () => {
  const hangul = { ㅊ: 'KeyC', ㅓ: 'KeyJ', ㅏ: 'KeyK', ㅣ: 'KeyL', ㅑ: 'KeyI', ㅐ: 'KeyO', ㅠ: 'KeyB', ㅡ: 'KeyM', ㄹ: 'KeyF', ㅎ: 'KeyG', ㅗ: 'KeyH', ㅍ: 'KeyV', ㅔ: 'KeyP', ㄷ: 'KeyE', ㅁ: 'KeyA', ㅅ: 'KeyT', ㅋ: 'KeyZ', ㅇ: 'KeyD', ㅛ: 'KeyY' };
  for (const [key, code] of Object.entries(hangul)) assert.equal(shortcutKey({ key, code }), code.slice(3).toLowerCase(), key);
  assert.equal(shortcutKey({ key: 'ㅆ', code: 'KeyT', shiftKey: true }), 't', 'double consonants are still the same key');
  assert.equal(shortcutKey({ key: 'Process', code: 'KeyC' }), 'c', 'an engaged IME reports Process');
  assert.equal(shortcutKey({ key: 'Process', code: 'Slash', shiftKey: true }), '?');
  assert.equal(shortcutKey({ key: 'Process', code: 'BracketRight' }), ']');
  assert.equal(shortcutKey({ key: 'Process', code: 'Digit0' }), '0');
  assert.equal(shortcutKey({ key: 'Process', code: 'Enter' }), 'enter');
  assert.equal(shortcutKey({ key: 'Unidentified', code: '' }), 'unidentified');
  assert.equal(shortcutKey({}), '');
});

test('Enter saves, Shift+Enter and Alt+Enter break the line, a held key never saves twice', () => {
  const enter = createEnterSubmit();
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter' }), 'submit');
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter', ctrlKey: true }), 'submit', 'the former Ctrl/⌘ + Enter still saves');
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter', repeat: true }), 'block');
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter', shiftKey: true }), null);
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter', altKey: true }), null);
  assert.equal(enter.keydown({ key: 'a', code: 'KeyA' }), null);
  assert.equal(enter.beforeinput({ inputType: 'insertLineBreak' }), false, 'an ordinary Shift+Enter line break is never swallowed');
});

test('a Hangul syllable still composing saves on the passed-through line break, exactly once', () => {
  let clock = 1000;
  const enter = createEnterSubmit({ now: () => clock });
  // macOS Chrome/Safari: keydown is reported as composing, then the IME passes the line break through.
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 }), null);
  assert.equal(enter.beforeinput({ inputType: 'insertCompositionText' }), false);
  assert.equal(enter.beforeinput({ inputType: 'insertLineBreak' }), true);
  assert.equal(enter.beforeinput({ inputType: 'insertLineBreak' }), false, 'one Enter saves once');
  // Safari reports the same key with isComposing false but keyCode 229.
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter', isComposing: false, keyCode: 229 }), null);
  assert.equal(enter.beforeinput({ inputType: 'insertLineBreak' }), true);
  // Windows: the IME reports Process, commits, then sends a real Enter.
  assert.equal(enter.keydown({ key: 'Process', code: 'Enter', keyCode: 229 }), null);
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter', keyCode: 13 }), 'submit');
  assert.equal(enter.beforeinput({ inputType: 'insertLineBreak' }), false);
});

test('confirming an IME conversion, a stale wait or Shift+Enter while composing never saves', () => {
  let clock = 0;
  const enter = createEnterSubmit({ now: () => clock, windowMs: 500 });
  // Japanese/Chinese: Enter confirms the candidate; no line break follows.
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 }), null);
  clock = 501;
  assert.equal(enter.beforeinput({ inputType: 'insertLineBreak' }), false, 'a later, unrelated line break is not a save');
  clock = 600;
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229, shiftKey: true }), null);
  assert.equal(enter.beforeinput({ inputType: 'insertLineBreak' }), false, 'Shift+Enter while composing is a line break');
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 }), null);
  assert.equal(enter.keydown({ key: 'a', code: 'KeyA' }), null);
  assert.equal(enter.beforeinput({ inputType: 'insertLineBreak' }), false, 'another key cancels the wait');
  assert.equal(enter.keydown({ key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 }), null);
  enter.reset();
  assert.equal(enter.beforeinput({ inputType: 'insertLineBreak' }), false);
});
