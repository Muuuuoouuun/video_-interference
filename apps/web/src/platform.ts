/** The primary modifier as this computer labels it, so hints never show a key the keyboard lacks. */
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '') ? '⌘' : 'Ctrl';
