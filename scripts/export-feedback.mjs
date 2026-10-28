import { cp, readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareFeedbackExport } from '../apps/worker/feedback-export.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const formats = new Set(['summary', 'jsonl', 'md', 'json', 'vtt', 'paths']);
const help = `시간별 피드백 자료를 앱 화면 없이 내보내는 명령입니다. AI·다른 도구가 바로 읽도록 글 자료를 표준 출력으로 줍니다.
앱 DB는 읽기만 하며, 모델 호출·외부 전송·받아쓰기는 하지 않습니다.

npm run export -- [--format summary|jsonl|md|json|vtt|paths] [--version N] [--comment-id ID] [--observations FILE] [--out DIR]
  --format FORMAT      표준 출력 형식 (기본 summary)
                       jsonl: 한 줄에 피드백 하나 · md: 사람용 문서 · json: manifest · vtt: 자막 · paths: 파일 경로
  --version N          기준 버전 번호 (기본: 앱에서 열려 있는 버전)
  --comment-id ID      내보낼 피드백 ID (여러 번 지정 가능, 기본: 삭제하지 않은 전체)
  --observations FILE  npm run test:gemini -- ... --live가 만든 observations.json (모델 결과로 따로 표시)
  --out DIR            완성된 자료 폴더를 복사할 위치
  --storage DIR        앱 저장 폴더 (기본 VI_STORAGE_ROOT 또는 ./storage)

자료는 storage/cli-exports/<내용 해시>/에 만들어지고 같은 내용이면 다시 만들지 않습니다.`;

function options(args) {
  const result = { format: 'summary', commentIds: [], observations: [], storage: process.env.VI_STORAGE_ROOT || join(root, 'storage') };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    const value = args[index + 1];
    if (!['--format', '--version', '--comment-id', '--observations', '--out', '--storage'].includes(arg)) throw new Error(`알 수 없는 인자입니다: ${arg}. --help에서 사용법을 볼 수 있습니다.`);
    if (!value || value.startsWith('--')) throw new Error(`${arg} 값을 지정해 주세요.`);
    index++;
    if (arg === '--format') { if (!formats.has(value)) throw new Error(`형식은 ${[...formats].join(', ')} 중 하나입니다.`); result.format = value; }
    else if (arg === '--version') { if (!/^\d+$/.test(value)) throw new Error('--version에는 버전 번호(예: 2)를 지정해 주세요.'); result.version = Number(value); }
    else if (arg === '--comment-id') result.commentIds.push(value);
    else if (arg === '--observations') result.observations.push(resolve(value));
    else if (arg === '--out') result.out = resolve(value);
    else result.storage = resolve(value);
  }
  return result;
}

/** A read-only snapshot never runs the worker's startup recovery, so a live worker's jobs stay untouched. */
async function readWorkspace(storage) {
  const path = join(storage, 'project.sqlite');
  try { await stat(path); } catch { throw new Error(`앱 저장 폴더에서 프로젝트를 찾지 못했습니다: ${path}`); }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const record = db.prepare('SELECT data FROM workspace WHERE id = 1').get();
    if (!record) throw new Error('저장된 프로젝트가 없습니다. 앱에서 영상을 먼저 열어 주세요.');
    const data = JSON.parse(record.data);
    if (!data.state) throw new Error('저장된 프로젝트가 없습니다. 앱에서 영상을 먼저 열어 주세요.');
    return data;
  } finally { db.close(); }
}

async function readObservations(paths) {
  const sets = [];
  for (const path of paths) {
    let value;
    try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error(`AI 관찰 파일을 읽지 못했습니다: ${path}`); }
    if (value?.kind !== 'video-feedback-observations' || value.schemaVersion !== 1 || !Array.isArray(value.items)) throw new Error(`AI 관찰 파일 형식이 아닙니다: ${path}`);
    sets.push({ provider: value.provider, model: value.model, createdAt: value.createdAt, items: value.items.map(item => ({ id: item.id, entryDigest: item.entryDigest, observedScene: item.observedScene, feedbackSummary: item.feedbackSummary, questions: item.questions, evidenceFrames: item.evidenceFrames })) });
  }
  return sets;
}

async function main() {
  const input = options(process.argv.slice(2));
  if (input.help) { process.stdout.write(`${help}\n`); return; }
  const data = await readWorkspace(input.storage), state = data.state;
  const target = input.version === undefined ? state.versions.find(version => version.id === state.project.activeVersionId) : state.versions.find(version => version.number === input.version);
  if (!target) throw new Error(input.version === undefined ? '앱에서 열려 있는 버전을 찾지 못했습니다.' : `v${input.version} 버전을 찾지 못했습니다.`);
  const observations = await readObservations(input.observations);
  const result = await prepareFeedbackExport({ state, targetVersionId: target.id, commentIds: input.commentIds.length ? input.commentIds : undefined, files: data.files, snapshots: data.snapshots || {}, directory: join(input.storage, 'cli-exports'), overviewDirectory: join(input.storage, 'overviews'), ...(observations.length ? { observations } : {}) });
  if (input.out) await cp(result.directory, input.out, { recursive: true });
  const base = input.out ?? result.directory;
  const paths = { directory: base, manifest: join(base, 'manifest.json'), markdown: join(base, 'feedback.md'), jsonl: join(base, 'feedback.jsonl'), vtt: join(base, 'feedback.vtt'), archive: join(base, 'feedback.zip') };
  if (input.format === 'jsonl') process.stdout.write(await readFile(result.jsonlPath, 'utf8'));
  else if (input.format === 'md') process.stdout.write(`${await readFile(result.markdownPath, 'utf8')}\n`);
  else if (input.format === 'json') process.stdout.write(`${await readFile(result.manifestPath, 'utf8')}\n`);
  else if (input.format === 'vtt') process.stdout.write(await readFile(result.vttPath, 'utf8'));
  else if (input.format === 'paths') process.stdout.write(`${JSON.stringify(paths, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify({ project: state.project.name, version: target.number, feedback: result.commentCount, scenes: result.sceneCount, shots: result.manifest.stats.shotCount, transcripts: result.manifest.stats.transcriptCount, observations: result.manifest.stats.observationCount, cacheHit: result.cacheHit, ...paths, readFirst: paths.jsonl }, null, 2)}\n`);
}

main().catch(error => { process.stderr.write(`${error?.message || '피드백 자료를 내보내지 못했습니다.'}\n`); process.exitCode = 1; });
