const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** Buffer bytes once: a UTF-8 character can span multiple HTTP chunks. */
export async function readJsonBody(req, maxBytes = 2_000_000) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw fail('JSON 요청이 필요합니다.', 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw fail('요청이 너무 큽니다.', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(bytes ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)) : '{}'); }
  catch { throw fail('JSON 형식이 유효하지 않습니다.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('JSON 객체 요청이 필요합니다.');
  return value;
}
