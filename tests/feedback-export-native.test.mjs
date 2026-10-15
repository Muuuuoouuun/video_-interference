import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegPath, run } from '../apps/worker/engine.mjs';
import { verifyFeedbackExport } from '../scripts/verify-feedback-export.mjs';

test('portable feedback export keeps authored context and deleted-scene feedback across a cut/speed version without video files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-interference-feedback-export-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.mp4');
  await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x303030:s=320x180:r=30:d=6', '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='gte(n,30)*lt(n,60)',drawbox=x=0:y=0:w=iw:h=ih:color=cyan:t=fill:enable='gte(n,90)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath]);
  const report = await verifyFeedbackExport({ sourcePath, directory: join(directory, 'outputs') });
  assert.equal(report.commentCount, 3); assert.equal(report.annotatedChecks.length, 3);
  assert.ok(report.sourcePreserved && report.versionsPreserved && report.statePreserved);
});
