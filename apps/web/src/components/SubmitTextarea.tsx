import { useEffect, useLayoutEffect, useRef, type Ref, type TextareaHTMLAttributes } from 'react';
import { createEnterSubmit } from '../../../../packages/core/shortcut-key.mjs';

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onSubmit'> {
  ref?: Ref<HTMLTextAreaElement>;
  /** Enter saves; Shift+Enter breaks the line. Also fires for a Hangul syllable that Enter just finished. */
  onSubmit: () => void;
  /** Esc, outside IME composition. Without it Esc keeps its default behavior. */
  onEscape?: () => void;
  /** Grow with the text up to this many pixels, then scroll inside. */
  maxHeight?: number;
}

/** A textarea for feedback text: one Enter saves on every input source, and the box grows with its content. */
export function SubmitTextarea({ ref, onSubmit, onEscape, maxHeight, onKeyDown, value, ...rest }: Props) {
  const element = useRef<HTMLTextAreaElement | null>(null);
  const enter = useRef(createEnterSubmit());
  const latest = useRef({ onSubmit, onEscape });
  latest.current = { onSubmit, onEscape };

  useEffect(() => {
    const textarea = element.current;
    if (!textarea) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // React's synthetic beforeinput has no inputType, so the passed-through line break is read natively.
    const beforeInput = (event: InputEvent) => {
      if (!enter.current.beforeinput(event)) return;
      event.preventDefault();
      // Save after the IME has committed the syllable and React has seen the final text.
      timer = setTimeout(() => latest.current.onSubmit(), 0);
    };
    const reset = () => enter.current.reset();
    textarea.addEventListener('beforeinput', beforeInput);
    textarea.addEventListener('blur', reset);
    return () => { clearTimeout(timer); textarea.removeEventListener('beforeinput', beforeInput); textarea.removeEventListener('blur', reset); };
  }, []);

  useLayoutEffect(() => {
    const textarea = element.current;
    if (!textarea || !maxHeight) return;
    textarea.style.height = 'auto';
    const next = Math.min(maxHeight, textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight);
    textarea.style.height = `${next}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, maxHeight]);

  return <textarea {...rest} value={value}
    ref={node => { element.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node; }}
    onKeyDown={event => {
      const native = event.nativeEvent;
      const action = enter.current.keydown(native);
      if (action) {
        event.preventDefault(); event.stopPropagation();
        if (action === 'submit') latest.current.onSubmit();
        return;
      }
      if (event.key === 'Escape' && latest.current.onEscape && !native.isComposing && native.keyCode !== 229) {
        event.preventDefault(); event.stopPropagation(); latest.current.onEscape();
        return;
      }
      onKeyDown?.(event);
    }}/>;
}
