export interface PendingVoiceUpload<Anchor> {
  blob: Blob;
  name: string;
  anchor: Anchor;
  status: 'pending' | 'uploading' | 'failed';
  error?: string;
}
export interface PendingVoiceSession<Anchor> {
  readonly pending: PendingVoiceUpload<Anchor> | null;
  stage(blob: Blob, name: string, anchor: Anchor): boolean;
  retry(): Promise<boolean>;
  discard(): boolean;
  release(): void;
}
export function createPendingVoiceUpload<Anchor, Attachment>(callbacks: {
  upload: (recording: PendingVoiceUpload<Anchor>) => Promise<Attachment>;
  onChange: (recording: PendingVoiceUpload<Anchor> | null) => void;
  onSaved: (attachment: Attachment, anchor: Anchor) => void;
}): PendingVoiceSession<Anchor>;
