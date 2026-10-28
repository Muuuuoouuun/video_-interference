# Local worker API

Run `node apps/worker/server.mjs`. Node 25, FFmpeg, ffprobe and sharp are required. The worker binds to `127.0.0.1:4318`. Vite runs on port 4317 and proxies `/api` and `/media` to the worker. `PORT`, `VI_DEV_PORT`, `VI_STORAGE_ROOT`, `VI_SAMPLE_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH` and `VI_PROXY_PRESET` can override local defaults. Without `FFMPEG_PATH`/`FFPROBE_PATH`, the worker uses the first executable among `/opt/homebrew/bin`, `/usr/local/bin` and `PATH`. `VI_PROXY_PRESET` selects the x264 preset of the review proxy only (default `superfast`; `veryfast` gives smaller proxies and slower imports); renders keep their own settings.

`GET /api/state` returns `BootstrapState` from `packages/core/types.ts`: a complete `AppState`, or `{empty:true, capabilities}` when no source is open. A missing sample does not prevent server startup; use `POST /api/assets` to initialize the workspace. Every frame range uses canonical 30 fps, with an exclusive out frame. Import keeps the uploaded source and creates a 30 fps proxy. Every render decodes that preserved source, rather than re-encoding a preceding output version. Versions retain immutable operation snapshots and source-to-output maps. A speed factor is absolute relative to source speed; the newest operation wins where speed or whole-track volume requests overlap. Cuts are additive; trim operations retain their intersection. Graphics in removed ranges disappear from output.

`CreateComment.contextFrame` records the displayed frame where a drawing or spatial request was made. It can differ from the editing `frameIn`/`frameOut` interval, but must be an integer within the version. The optional AI adapter extracts that frame for visual context. Omitted values and legacy comments fall back to `frameIn`; edit ranges and source anchors are unaffected.

Comments can be saved without interpreting them, including an attachment-only request or memo with empty text. Saving an image does not interpret or insert it automatically. Optional `kind` is `request` by default, including legacy callers; `kind:'note'` stores a non-executable memo. Interpreting a memo returns 409 and creates no operations. Legacy interpreted `note` operations remain readable but cannot be selected in an execution batch, including alongside ordinary edits.

`Comment.supplements` is an optional append-only list of `{id,text,createdAt}` records. Save more instructions through `POST /api/comments/:id/supplements`; the original text, drawings, selected range, displayed frame and source anchors remain unchanged. Each addition accepts 1–5,000 characters, at most 20 additions, and at most 20,000 characters across the original and additions. Validation is atomic. Saving an addition removes that request's unapplied proposals and approvals, clears its clarification and returns it to `received`; interpretation happens only when explicitly requested again. Pending interpretation, active rendering and previously applied requests return 409. Memos can receive additions but remain non-executable.

Local rules read the original plus all additions. An addition can supply a missing speed factor or a quoted subtitle, while conflicting speed factors or subtitle texts produce a clarification with no operations. To resolve a conflict in the same request, the newest addition can explicitly say `최종 3배속`, `확정: 3배속` or `최종 자막: 다음`. That confirmation selects the corresponding field without altering prior text; a contradictory newest addition still needs clarification. A simple later value does not silently replace an earlier value. The optional Claude adapter receives chronological `instructionHistory` and `latestInstruction` with the same conflict/explicit-confirmation policy. Saving additions itself never calls an AI API.

Conflicting new speed requests in one batch return 409 when their source ranges overlap and their factors differ. A new request in a later version may still replace inherited speed settings. New subtitle, overlay, audio or speed requests whose entire range disappears from the final output also return 409 before a job is created. Cutting away inherited layers in a later version remains supported.

Drawing remains a review annotation until a request explicitly asks “이 그림/도형 그대로 영상에 넣어줘”. Interpretation then proposes `overlay` with `{kind:'drawing', drawings:Drawing[]}`. Approval is required before the renderer burns those exact vectors into the selected source-anchored range. Rectangle, ellipse, line, arrow, freehand pen and text annotations are supported; every request holds up to 30 shapes and each pen up to 2,000 normalized points. Optional `strokeWidth` defaults to 3 in a logical SVG viewport whose width is 1000 and height is `1000 * videoHeight / videoWidth`. Color and closed-shape fill use `#RRGGBB`; fill defaults to `none`. Opacity defaults to 1 and accepts 0–1. Open pen/line/arrow strokes remain unfilled, and arrowheads use the stroke color. Text annotations store `text` (1–500 characters, up to 8 lines) and a normalized `region`; browser and native SVG share line positions and fitted line lengths. Legacy annotations without style fields keep working.

Optional `Drawing.frame` records each annotation's authored-version frame. Explicit values must be integers within that version; omitted legacy values keep their stored JSON shape and use `comment.contextFrame ?? comment.frameIn`. Supplements and restarts retain every anchor. Different frames are independent location annotations. Static insertion of more than one frame group is held for clarification in local/cloud validation, parameter editing and rendering: copy one scene's drawings into a new request before insertion. Raster cache keys exclude drawing IDs and frame metadata, with frame validation before cache lookup.

`prepareRequestContextBundle` in `context-bundle.mjs` prepares local `manifest.json`, all drawing-scene JPEGs, comment context, request start/middle/end, all verified image attachments and original voice uploads. Duplicate frames share one image, and short seek+decode runs extract every required scene. Images fit within 640×640. The manifest explicitly records `modelCalled:false`, `networkUsed:false` and `externalConnection:'not-connected'`; voice transcription remains unavailable. Missing attachments stop preparation instead of being silently omitted. This preparation has no network client and is not connected to the production adapter. Explicit per-drawing frames currently return a clear unconnected-material clarification before the external adapter runs; the earlier legacy single-context adapter remains unchanged.

Provider compatibility checked on 2026-10-14: Anthropic's [official vision limits](https://platform.claude.com/docs/en/build-with-claude/vision) allow 100 images for 200k-context API models and 600 for other models, and advise keeping dimensions at most 2000px for requests above 20 images. The [Messages request size limit](https://platform.claude.com/docs/en/api/overview) is 32 MB. The local maximum here is 34 scene images plus 10 attachment images, below the smaller documented image count. This confirms preparation constraints only; actual model interpretation and expanded external transmission remain unverified and unconnected.

Graphic rasters use a content-keyed, atomically written PNG cache in `storage/jobs/graphic-cache/`. Consecutive graphic layers with exactly equal output timing are composited into one transparent input while preserving layer order. Graphics with intervening layers are kept separate. Subtitle and overlay timings no longer split video or audio into extra concat segments: only cut, trim, speed and audio boundaries do so. Each job writes `render-diagnostics.json` with segment/input counts, cache hits and preparation/render timings. Audio enters tempo filters as float samples, which also preserves exact silence for sources without audio.

Audio retains its original start offset relative to video in both the preview proxy and renders. Imports store `Asset.audioOffsetSeconds`; older assets without that field are probed from the preserved source when rendered. Positive offsets receive leading silence and negative offsets trim audio that preceded the video, using FFmpeg's [timestamp-aware resampler](https://ffmpeg.org/ffmpeg-resampler.html). A 1× segment uses audio passthrough after alignment, avoiding an unnecessary tempo filter. Proxy padding ends with the video rather than extending its duration.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/state` | — | `AppState` or `EmptyState` |
| `POST /api/assets` | Raw video body. `x-file-name: encodeURIComponent(name)`. | `{asset, version}`; replaces the active project. Dropping the connection cancels the import and keeps the current project |
| `GET /api/import-status` | — | `{active:false}` or `{active:true, stage:'receiving'\|'converting', name, receivedBytes, totalBytes, progress, startedAt}` |
| `POST /api/attachments` | Raw file body; encoded `x-file-name`; `x-asset-role: reference`, `insert`, or `voice`. | `Attachment` |
| `POST /api/comments` | JSON `CreateComment` | `Comment` |
| `POST /api/comments/:id/supplements` | JSON `{text}` | Updated `Comment`; clears unapplied proposals and approval |
| `POST /api/comments/:id/context-bundle` | JSON `{}` | `{manifestUrl, archiveUrl?, sceneCount, drawingSceneCount, attachmentCount}`; local files and portable ZIP, no model call |
| `POST /api/comments/:id/interpret` | JSON `{}` | `InterpretResult` |
| `PATCH /api/ops/:id` | JSON `{status:'proposed'\|'approved'\|'rejected', params?, region?}` | `EditOp`; valid parameter/region edits reset approval |
| `POST /api/render` | JSON `{parentVersionId, opIds}`; approved ops from this version only | `RenderJob`, HTTP 202 |
| `GET /api/jobs/:id` | — | `RenderJob` |
| `POST /api/jobs/:id/cancel` | JSON `{}`; queued/running job only | HTTP 202 `RenderJob` with `cancelRequested:true` |
| `PATCH /api/project` | JSON `{activeVersionId}`; completed version only | `Project` |
| `GET/HEAD /media/:id` | Optional byte `Range`; `?download=1` adds download header | Stream with byte ranges |

All mutation calls except raw imports need `Content-Type: application/json`. Errors return `{error:string}` with an appropriate HTTP status. Poll job state or the full state while rendering. A completed render does not change the active version automatically; explicitly select it after completion.

Cancellation aborts the native render and removes incomplete output/thumbnail files before publishing `status:'canceled'`. The failed version cannot be selected, source files remain intact, and selected operations retain approval for a retry. Completed, already canceled or failed jobs return 409 from the cancel endpoint.

SIGINT/SIGTERM stops new requests, aborts pending interpretation and render work, and stops tracked native processes, including imports and frame extraction. The worker waits up to three seconds for native process closure, incomplete-output cleanup and job-state persistence before closing SQLite. Native subprocesses receive SIGTERM first and SIGKILL after one second if needed. A render interrupted before its final state was saved remains recoverable as a failed job on restart.

Import is exclusive against pending interpretations, attachment uploads and renders. During import, project mutations return 409 while state/media reads continue. Mutations retain their project identity while reading request bodies; asynchronous interpretation/upload commits recheck that identity. Duplicate interpretations for one comment return 409, and a late interpretation cannot replace a plan that was approved while it was pending.

Local material preparation shares the pending-comment lock: imports, interpretation or supplements cannot race that request while its bundle is being prepared. Preparing materials leaves comments, approvals, versions and original files unchanged. Manifest, individual files and ZIP receive generated media IDs; incomplete bundles are removed on failure or cancellation. Every ZIP (context bundle, feedback handoff, Premiere) is written by the built-in `zip.mjs`: no platform `zip` binary, generated relative entry names only, JPEG/PNG/audio stored without recompression, text deflated, ZIP64 when an archive or entry needs it, and an atomic rename so a failed or canceled export leaves no partial archive.

Region edits are allowed for overlay/subtitle operations and require finite normalized coordinates within the frame, with width/height at least 0.002. The server validates every supplied field before committing any parameter, region or approval change. Failed edits retain the previous values and approval. Drawing graphics themselves use their stored full-frame vector coordinates.

Without both `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` in the process environment, interpretation uses a small, explicit local rules parser. This mode does not perform general AI reasoning or transcription. With both configured, the optional Claude adapter sends the selected frame, drawing coordinates, request text and up to three image attachments to the Anthropic Messages API, then validates returned proposals. The API key is never returned to the browser. Human approval is still required. Voice files are saved and playable; automatic voice transcription is unavailable in this draft.

When available, the initial project copies the repository-local `fixtures/demo.mp4` as “인터랙티브 수업” and seeds two unapproved requests: source 5–9 seconds at 2× and 9–12 seconds with the subtitle “배움이 이어지는 순간”. Without that optional sample, the server starts empty and accepts a user video. Import limits are 10 minutes, SDR, 2 GB video, 50 MB image and 100 MB voice. Only static images are accepted as visual attachments in this draft. It serves a production `dist/` if present. Opening another source archives the preceding workspace state as a JSON file in `storage/archives/` and preserves its media files.

Security: loopback binding, exact Host/Origin checks, cross-site request rejection, no permissive CORS, generated storage paths, no caller-provided commands or filesystem paths, image decoding validation, ffprobe media validation, subprocess argument arrays with no shell, and approval validation before rendering. SQLite persists the local project and immutable render snapshots. Interrupted jobs are marked failed on restart.

## Still extraction and request reliability

Scene bundles, feedback exports, overview grids and timeline filmstrips extract exact
frames of the zero-based 30fps review/render versions. `planCanonicalFrameRuns`
groups the requested frames into decode runs: frames closer than 4 seconds share one
run, and each run seeks to a whole second with one second of preroll
(`planCanonicalFrameDecode`). Runs execute as separate single-threaded FFmpeg
processes with bounded parallelism (`parallel.mjs`), so twelve thumbnails spread
over ten minutes decode a few seconds of video instead of almost all of it. A run
that returns the wrong number of images is reported as missing frames, never
shifted onto neighbours. Source VFR footage must be normalized before using this path.

Feedback exports cache each still by version file identity and frame
(`feedback-exports/.stills/`), so a re-export after adding or editing feedback only
decodes frames it has not extracted before. The version overview reuses scene cuts
measured while that file was written: import normalization and renders split the
decoded picture into a 160×90 area-scaled scene-score branch (`scene-scores.mjs`) and
the cuts are cached by file identity in `overviews/`. Every frame passes that branch
and goes to a null output, so FFmpeg progress reports keep flowing. Without stored
cuts (older projects), one scene-only decode runs beside the grid extraction. Stills,
overview, attachment copies, annotated stills, one-sheet summaries and file hashes run
with bounded parallelism while keeping manifest and ZIP order deterministic.

Measured on 2026-10-28 in a 4-core Linux container (Node 22, FFmpeg 6.1) with
`node scripts/benchmark-upload-export.mjs --video <5 min 1080p, 206 MB> --comments 40 --images 10`:

| Step | Before | After (two runs) |
| --- | --- | --- |
| Import (upload + 30fps proxy) | 124.1 s | 103.9–104.6 s |
| Timeline filmstrip, cold (same proxy, module call) | 59.4 s | 3.1 s |
| Feedback export, cold (40 items, 68 stills, overview) | 108.0 s | 11.1–14.3 s |
| Re-export after one more feedback | full export again | 2.2–2.4 s |
| 10 photo attachments (4032×3024 JPEG) | 2.7 s one at a time | 1.3 s three at a time, same run |

The synthetic `testsrc2` source is not representative of real footage; the report is
written to `storage/qa/upload-export/<label>.json`. Import time is dominated by the
proxy encode itself; the default `superfast` preset measured 1.45× faster than
`veryfast` on 60 s of this source with higher SSIM (0.9988 vs 0.9974) and larger files.

JSON requests are limited to 2,000,000 actual bytes and decoded once, preserving
Korean and emoji even when UTF-8 bytes span network chunks. Malformed UTF-8,
invalid JSON and non-object payloads are rejected before project mutation.
Native regression tests compare sought frames against full decoding at GOP,
second and EOF boundaries, including feedback-export and drawing anchors.
The HTTP integration test checks split Korean text through API and SQLite.

Run `npm test` and `npm run build` for verification.

## Gemini feedback-brief test

The user selected Gemini for needed API tests. `npm run test:gemini -- /path/to/export/manifest.json` validates a portable feedback bundle locally; `--live` makes one explicit Gemini request with up to three selected feedback items and their stills, annotation previews and reference images. Source/rendered videos and audio are excluded. It writes a separate review result and never changes the live project, its comments, exact anchors, approvals or versions. The production interpreter remains separate. See [test workflow](../../docs/Gemini테스트.md). Keys come from ignored `.env.local`, not the browser. Ordinary `npm test` uses mocks and does not call Gemini.
