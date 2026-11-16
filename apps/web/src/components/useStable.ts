import { useMemo, useRef } from 'react';

type Handler = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Event handlers with a fixed identity that always run the latest closure.
 * Only for functions called from events or effects: a memoized child will not re-render when their logic changes.
 */
export function useStableHandlers<T extends Record<string, Handler | undefined>>(handlers: T): { [K in keyof T]-?: NonNullable<T[K]> } {
  const latest = useRef(handlers);
  latest.current = handlers;
  return useMemo(() => Object.fromEntries(Object.keys(handlers).map(name => [name, (...args: unknown[]) => latest.current[name]?.(...args)])) as { [K in keyof T]-?: NonNullable<T[K]> }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Returns the previous object while every field is identical, so memoized children skip unrelated renders. */
export function useShallowStable<T extends object>(value: T): T {
  const stable = useRef(value);
  const previous = stable.current as Record<string, unknown>, next = value as Record<string, unknown>;
  const keys = Object.keys(next);
  if (previous !== next && (keys.length !== Object.keys(previous).length || keys.some(key => !Object.is(previous[key], next[key])))) stable.current = value;
  return stable.current;
}
