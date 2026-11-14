const CODE_SYMBOLS = Object.freeze({
  BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=',
  Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\', Space: ' ',
});
const SHIFTED = Object.freeze({ '/': '?', '=': '+', '-': '_', ',': '<', '.': '>', '[': '{', ']': '}' });

/**
 * A layout- and input-source-independent key for single-key shortcuts.
 * An ASCII character or a named key is used as typed, so Dvorak or AZERTY keep their own letters.
 * With a Hangul (or other non-Latin) input source the browser reports a jamo such as 'ㅊ', or
 * 'Process' while the IME is engaged; only then the physical key decides, so C stays C.
 */
export function shortcutKey(event) {
  const key = typeof event?.key === 'string' ? event.key : '';
  if (key.length === 1 && key.charCodeAt(0) < 128) return key.toLowerCase();
  if (key.length > 1 && key !== 'Process' && key !== 'Unidentified' && key !== 'Dead') return key.toLowerCase();
  const code = typeof event?.code === 'string' ? event.code : '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^(Digit|Numpad)[0-9]$/.test(code)) return code.at(-1);
  const symbol = CODE_SYMBOLS[code];
  if (symbol) return event.shiftKey ? SHIFTED[symbol] ?? symbol : symbol;
  if (code === 'Enter' || code === 'NumpadEnter') return 'enter';
  if (code === 'Escape') return 'escape';
  return key.toLowerCase();
}

const isEnter = event => event?.key === 'Enter' || event?.code === 'Enter' || event?.code === 'NumpadEnter';

/**
 * Enter saves and Shift+Enter breaks the line, including while a Hangul syllable is still composing.
 *
 * A Hangul IME finishes the syllable and then passes Enter through as a line break; a candidate-window
 * IME (Japanese, Chinese) consumes Enter to confirm a conversion. So a composing Enter never saves by
 * itself: it saves only when the browser then reports the passed-through line break, or a second,
 * non-composing Enter. A confirmed conversion produces neither and is left alone.
 */
export function createEnterSubmit({ now = () => Date.now(), windowMs = 500 } = {}) {
  let pendingAt = null;
  const pending = () => pendingAt !== null && now() - pendingAt <= windowMs;
  return {
    /** 'submit': prevent the default and save. 'block': prevent the default only. null: leave the key alone. */
    keydown(event) {
      if (!isEnter(event) || event.shiftKey || event.altKey) { pendingAt = null; return null; }
      if (event.isComposing || event.keyCode === 229) { pendingAt = now(); return null; }
      pendingAt = null;
      return event.repeat ? 'block' : 'submit';
    },
    /** true: prevent this line break and save once the committed text is in the field. */
    beforeinput(event) {
      if (!pending() || event?.inputType !== 'insertLineBreak' && event?.inputType !== 'insertParagraph') return false;
      pendingAt = null;
      return true;
    },
    reset() { pendingAt = null; },
  };
}
