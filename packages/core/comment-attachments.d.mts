export const IMAGE_ATTACHMENT_LIMIT: 10;
export function commentAttachmentInput(attachments: readonly { id: string; role: 'reference' | 'insert' | 'voice' }[]): { attachmentIds: string[]; voiceAssetId?: string };
