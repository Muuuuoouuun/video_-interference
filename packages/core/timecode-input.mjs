const MAX_FRAME = BigInt(Number.MAX_SAFE_INTEGER);
const INTEGER = /^\d+$/;
const SECONDS = /^\d+(?:\.\d{1,3})?$/;

function rateRatio(fps) {
  const [mantissa, exponent = '0'] = String(fps).split('e');
  const fractionDigits = mantissa.split('.')[1]?.length ?? 0;
  const power = Number(exponent) - fractionDigits;
  const digits = BigInt(mantissa.replace('.', ''));
  return power >= 0 ? [digits * 10n ** BigInt(power), 1n] : [digits, 10n ** BigInt(-power)];
}

/** Accept seconds, MM:SS or HH:MM:SS; store only the nearest nonnegative frame. */
export function parseTimecodeInput(text, fps = 30) {
  if (typeof text !== 'string' || !Number.isFinite(fps) || fps <= 0) return null;
  const input = text.trim();
  if (!input) return null;
  const parts = input.split(':');
  if (parts.length > 3) return null;
  let secondsText = parts.at(-1);
  if (parts.length === 1 && /^\.\d{1,3}$/.test(secondsText)) secondsText = `0${secondsText}`;
  if (!SECONDS.test(secondsText) || parts.slice(0, -1).some(part => !INTEGER.test(part))) return null;
  const [whole, fraction = ''] = secondsText.split('.');
  const secondsMillis = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (parts.length > 1 && secondsMillis >= 60000n) return null;
  if (parts.length === 3 && BigInt(parts[1]) >= 60n) return null;
  const minutes = parts.length === 2 ? BigInt(parts[0]) : parts.length === 3 ? BigInt(parts[0]) * 60n + BigInt(parts[1]) : 0n;
  const millis = minutes * 60000n + secondsMillis;
  const [rateNumerator, rateDenominator] = rateRatio(fps);
  const denominator = 1000n * rateDenominator;
  // Integer arithmetic keeps half-frame rounding and safe-integer checks exact.
  const frame = (millis * rateNumerator + denominator / 2n) / denominator;
  return frame <= MAX_FRAME ? Number(frame) : null;
}

/** Invalid drafts leave the anchor intact; valid drafts respect the caller's bounds. */
export function commitTimecodeInput(text, currentFrame, minFrame, maxFrame, fps = 30) {
  if (!Number.isSafeInteger(minFrame) || !Number.isSafeInteger(maxFrame) || minFrame < 0 || maxFrame < minFrame) return currentFrame;
  const parsed = parseTimecodeInput(text, fps);
  return parsed === null ? currentFrame : Math.max(minFrame, Math.min(maxFrame, parsed));
}
