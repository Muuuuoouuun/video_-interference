export const IMAGE_ATTACHMENT_LIMIT: 10;
export const VOICE_MAX_SECONDS: 600;
export const VOICE_MAX_BYTES: 100000000;
export function commentAttachmentInput(attachments: readonly { id: string; role: 'reference' | 'insert' | 'voice' }[]): { attachmentIds: string[]; voiceAssetId?: string };
export function splitAttachmentFiles<T extends { type: string; name: string }>(files: readonly T[]): { images: T[]; voice?: T; extraVoice: T[]; rejected: T[] };
