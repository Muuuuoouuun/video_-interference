export const IMAGE_ATTACHMENT_LIMIT = 10;
/** Worker limits for one voice memo; the composer checks them before uploading or while recording. */
export const VOICE_MAX_SECONDS = 600;
export const VOICE_MAX_BYTES = 100_000_000;

/** Voice has its own field and does not consume one of the image attachment slots. */
export function commentAttachmentInput(attachments) {
  const voice = attachments.find(attachment => attachment.role === 'voice');
  return {
    attachmentIds: attachments.filter(attachment => attachment.role !== 'voice').map(attachment => attachment.id),
    ...(voice ? { voiceAssetId: voice.id } : {}),
  };
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
// Some browsers leave file.type empty for m4a/opus; the worker's ffprobe is the real check.
const AUDIO_NAME = /\.(m4a|mp3|wav|aac|ogg|oga|opus|flac|webm)$/i;

/** Splits picked or dropped files into attachable images, one voice file, and the rest. */
export function splitAttachmentFiles(files) {
  const images = [], audio = [], rejected = [];
  for (const file of files) {
    if (IMAGE_TYPES.includes(file.type)) images.push(file);
    else if (file.type.startsWith('audio/') || !file.type && AUDIO_NAME.test(file.name)) audio.push(file);
    else rejected.push(file);
  }
  return { images, voice: audio[0], extraVoice: audio.slice(1), rejected };
}
