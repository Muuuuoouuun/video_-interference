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
