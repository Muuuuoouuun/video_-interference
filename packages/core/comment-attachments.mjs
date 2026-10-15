export const IMAGE_ATTACHMENT_LIMIT = 10;

/** Voice has its own field and does not consume one of the image attachment slots. */
export function commentAttachmentInput(attachments) {
  const voice = attachments.find(attachment => attachment.role === 'voice');
  return {
    attachmentIds: attachments.filter(attachment => attachment.role !== 'voice').map(attachment => attachment.id),
    ...(voice ? { voiceAssetId: voice.id } : {}),
  };
}
