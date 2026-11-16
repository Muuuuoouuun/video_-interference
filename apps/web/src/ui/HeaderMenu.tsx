import { useEffect, useRef, type ReactNode } from 'react';

interface Props { label: string; ariaLabel?: string; icon?: ReactNode; children: ReactNode }

/**
 * A small disclosure menu for secondary header actions.
 * It closes after an item is chosen, on a press outside, and on Esc (returning focus to its button).
 */
export function HeaderMenu({ label, ariaLabel, icon, children }: Props) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const element = menu.current;
      if (element?.open && !element.contains(event.target as Node)) element.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const element = menu.current;
      if (event.key !== 'Escape' || event.isComposing || !element?.open) return;
      event.preventDefault(); event.stopPropagation();
      element.open = false;
      element.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  }, []);
  return <details ref={menu} className="workspace-more">
    <summary aria-label={ariaLabel}>{icon}<span>{label}</span></summary>
    <div role="group" aria-label={ariaLabel ?? label} onClick={event => { if ((event.target as HTMLElement).closest('button:not(:disabled), a[href]') && menu.current) menu.current.open = false; }}>{children}</div>
  </details>;
}
