# Project instructions

- This project is developed in `/Volumes/OneTouch/video_interference`.
- Current prototype focus, per the latest user instruction: capture and hand off timestamped scene content and feedback, not video files. The default flow is local video review → point/range → scene description and feedback/drawings → save → portable feedback export. Keep interpretation, approval and video rendering as optional advanced editing features. Follow `docs/피드백프로토타입.md`.
- Prioritize the desktop video review and editing workspace. Mobile work is deferred to a later phase.
- The first user is a solo video creator. Keep requests, interpreted operations, approval, rendering, and version selection distinct.
- Rank product decisions by essence, convenience, then usability. Preserve scene and intent first, reduce repeated input next, and make state and next action clear. Follow `docs/제품원칙.md`.
- Preserve original media and immutable render snapshots. Render approved operations only.
- Clearly label local rule interpretation when the AI API is not connected. Do not present deterministic parsing or manual transcripts as model output.
- Default prototype flow remains local feedback preparation. The user has now authorized using Gemini API for needed AI tests. Use Gemini for bounded, explicit feedback-brief tests with selected text, timestamps, stills and annotations; never send whole source/rendered videos for this prototype. Keep AI observations separate from user text and preserve exact local anchors. Saving or exporting feedback must not automatically call a model. Do not expand to other providers or unrelated transmissions without user direction.
- Drawing is a request annotation by default. Reference images and voice comments do not automatically enter the output video.
- Use `npm run build` and `npm test` for relevant verification. Test actual native FFmpeg results for editing changes.
- Install dependencies with `npm install --bin-links=false` on this external disk. Build and dev scripts invoke package executables directly.
- Keep `storage/`, credentials, local demo videos, and generated build files out of Git.

## Reading feedback handoffs (AI and tools)

- Read text first: `feedback.jsonl` (one feedback per line) or `manifest.json`. Open `sheets/feedback-NNNN.jpg` only when the text cannot settle the scene or drawing target, then individual `scenes/` or `annotations/` stills. Use `overview/grid.jpg` for the whole-video flow. Never request or reconstruct the video files. Format: `docs/AI전달형식.md`, schema `schema/feedback-handoff.schema.json`.
- Get the text without the UI: `npm run export -- --format jsonl` (or `md`, `json`, `vtt`, `paths`). The CLI opens the app database read-only and never calls a model, the network or transcription.
- Keep provenance: `sceneDescription.source: "user"`, transcripts `source: "asr"` (automatic, verify against the audio), observations `source: "model"` (stale when the feedback changed). Never present one as another or let model text replace user text.
- Drawing sentences, overview grids and shot lists are local computations; shot cuts are estimates (`estimated: true`).
- Local transcription runs only when the user presses the voice memo's transcribe action and `WHISPER_CPP_PATH` and `WHISPER_MODEL_PATH` are set. Saving or exporting never starts it. Do not add cloud transcription without user direction.
- Gemini tests send one sheet per feedback by default (`--detail full` for every still). Transcript text is sent only with `--include-transcripts`; audio files are never sent.
