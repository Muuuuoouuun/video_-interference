export function confirmedMutation<T>(write: () => Promise<T>, refresh: () => Promise<unknown>): Promise<{ result: T; refreshError: unknown | null }>;
