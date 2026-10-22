/** All frame ranges are canonical 30 fps and half-open: [frameIn, frameOut). */
export type OpType = 'cut' | 'trim' | 'speed' | 'subtitle' | 'overlay' | 'audio' | 'note';
export type OpStatus = 'proposed' | 'approved' | 'rejected' | 'applied' | 'needs_clarification';
export type CommentStatus = 'received' | 'interpreted' | 'approved' | 'applied' | 'needs_clarification';
export interface Region { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export type DrawingKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'pen' | 'text';
/** Coordinates are normalized. strokeWidth uses a video-width-1000 viewport, never screen pixels.
 * frame is canonical 30 fps in the authored version; legacy drawings use their comment's context frame. */
export interface Drawing { id: string; kind: DrawingKind; text?: string; color: string; points: Point[]; frame?: number; region?: Region; strokeWidth?: number; opacity?: number; fill?: string }
export interface SourceRange { frameIn: number; frameOut: number }
export interface TimelineSegment { sourceIn: number; sourceOut: number; outputIn: number; outputOut: number; speed: number; volume: number }
export interface Project { id: string; name: string; activeVersionId: string; createdAt: string }
export interface Asset { id: string; name: string; durationFrames: number; fps: 30; width: number; height: number; hasAudio: boolean; mediaUrl: string; thumbnailUrl: string; originalFps?: string; audioOffsetSeconds?: number }
export interface Attachment { id: string; name: string; role: 'reference' | 'insert' | 'voice'; mimeType: string; mediaUrl: string; createdAt: string }
export interface Version { id: string; assetId: string; number: number; parentVersionId: string | null; durationFrames: number; mediaUrl: string; thumbnailUrl: string; opIds: string[]; appliedOpIds?: string[]; timelineMap: TimelineSegment[]; createdAt: string; status: 'ready' | 'rendering' | 'failed'; label: string }
export interface LayerChange { action: 'replace' | 'remove'; targetLayerId: string; targetOpId: string }
export interface CommentSupplement { id: string; text: string; createdAt: string }
export type FeedbackCategory = 'video' | 'subtitle' | 'audio' | 'effect';
export interface CommentRevision { id: string; text: string; sceneDescription?: string; editedAt: string }
export interface Comment { id: string; versionId: string; frameIn: number; frameOut: number; contextFrame?: number; kind?: 'request' | 'note'; category?: FeedbackCategory; layerChange?: LayerChange; sceneDescription?: string; text: string; supplements?: CommentSupplement[]; revisions?: CommentRevision[]; drawings: Drawing[]; attachmentIds: string[]; voiceAssetId?: string; status: CommentStatus; createdAt: string; updatedAt?: string; deletedAt?: string; clarification?: string; sourceRanges: SourceRange[] }
export interface EditOp { id: string; layerId?: string; layerChange?: LayerChange; commentId: string; versionId: string; type: OpType; frameIn: number; frameOut: number; sourceRanges: SourceRange[]; region?: Region; params: { factor?: number; text?: string; assetRef?: string; volume?: number; kind?: 'text' | 'image' | 'box' | 'drawing'; color?: string; drawings?: Drawing[] }; status: OpStatus; aiNote: string; createdAt: string; interpreter: 'local-rules' | 'anthropic' | 'manual' }
export interface RenderJob { id: string; versionId: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'; progress: number; cancelRequested?: boolean; error?: string; createdAt: string; completedAt?: string }
export interface Capabilities { ffmpeg: boolean; interpreter: 'local-rules' | 'anthropic'; interpreterLabel: string; transcription: boolean; maxDurationSeconds: number; fps: 30; supportedOps: OpType[] }
export interface AppState { project: Project; asset: Asset; versions: Version[]; comments: Comment[]; deletedComments?: Comment[]; ops: EditOp[]; jobs: RenderJob[]; attachments: Attachment[]; capabilities: Capabilities }
export interface EmptyState { empty: true; capabilities: Capabilities }
export type BootstrapState = AppState | EmptyState;
export interface CreateComment { versionId: string; frameIn: number; frameOut?: number; contextFrame?: number; kind?: 'request' | 'note'; category?: FeedbackCategory; sceneDescription?: string; text: string; drawings?: Drawing[]; attachmentIds?: string[]; voiceAssetId?: string }
export interface InterpretResult { comment: Comment; ops: EditOp[]; mode: 'local-rules' | 'anthropic'; clarification?: string }
export interface ApiError { error: string; code?: string }

/** Effective visual layers in one immutable rendered version, ordered from back to front. */
export interface RenderLayer { id: string; op: EditOp; outputRanges: SourceRange[] }
export interface LayerChangeInput { action: 'replace' | 'remove'; targetOpId: string; params?: EditOp['params']; region?: Region }
export interface LayerChangeResult { comment: Comment; op: EditOp }

/** Locally prepared, portable feedback materials; video files are excluded. */
export interface FeedbackExportResult { manifestUrl: string; markdownUrl: string; archiveUrl: string; commentCount: number; sceneCount: number }
