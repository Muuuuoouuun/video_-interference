/** A permission request may resolve after the composer has closed. Never leave that stream running. */
export async function acquireMicrophone(getUserMedia, signal) {
  if (signal.aborted) return null;
  const stream = await getUserMedia({ audio: true });
  if (signal.aborted) { stopMicrophone(stream); return null; }
  return stream;
}

export function stopMicrophone(stream) {
  stream?.getTracks().forEach(track => track.stop());
}
