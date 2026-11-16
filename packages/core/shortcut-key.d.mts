export interface ShortcutKeyEvent { key?: string; code?: string; shiftKey?: boolean }
/** Lower-case key for single-key shortcuts; falls back to the physical key under a non-Latin input source. */
export function shortcutKey(event: ShortcutKeyEvent): string;
export interface EnterKeyEvent { key?: string; code?: string; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean; keyCode?: number; repeat?: boolean }
export interface EnterSubmit {
  keydown(event: EnterKeyEvent): 'submit' | 'block' | null;
  beforeinput(event: { inputType?: string }): boolean;
  reset(): void;
}
export function createEnterSubmit(options?: { now?: () => number; windowMs?: number }): EnterSubmit;
