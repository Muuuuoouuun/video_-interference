/** A failed refresh cannot turn an acknowledged write into a failed write. */
export async function confirmedMutation(write, refresh) {
  const result = await write();
  try { await refresh(); return { result, refreshError: null }; }
  catch (refreshError) { return { result, refreshError }; }
}
