import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareGeminiFeedback, analyzeGeminiFeedback } from '../apps/worker/gemini-feedback.mjs';

const help = `Gemini로 시간별 피드백 자료를 읽는 작은 테스트입니다.
기본 실행은 로컬 자료 검사만 합니다. --live에서만 Gemini를 호출합니다.

npm run test:gemini -- /path/to/manifest.json [--comment-id ID] [--detail auto|sheet|full] [--include-transcripts] [--live]
  --comment-id ID         지정한 피드백만 검사 (여러 번 지정 가능, 최대 3개)
  --detail MODE           이미지 단계. auto(기본): 형식 v2면 피드백당 한 장 요약, 아니면 전체 스틸
                          sheet: 한 장 요약만 · full: 모든 스틸과 그림 표시 스틸
  --include-transcripts   미리 실행한 로컬 받아쓰기 글을 함께 전송 (음성 파일은 보내지 않음)
  --output PATH           결과 폴더의 상위 경로 (기본 storage/qa/gemini-feedback)
  --live                  검증한 글·이미지를 Gemini에 한 번 전송하고 observations.json을 남김

observations.json은 피드백 내보내기 CLI의 --observations로 붙일 수 있습니다.

키와 모델은 .env.local의 GEMINI_API_KEY / GEMINI_MODEL을 사용합니다.
영상 파일·음성 파일은 보내지 않으며 앱의 원문·승인·버전은 바꾸지 않습니다.`;

function options(args) {
  const result = { live: false, commentIds: [], output: 'storage/qa/gemini-feedback', detail: 'auto', includeTranscripts: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--live') result.live = true;
    else if (arg === '--include-transcripts') result.includeTranscripts = true;
    else if (arg === '--comment-id' || arg === '--output' || arg === '--detail') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 값을 지정해 주세요.`);
      if (arg === '--comment-id') result.commentIds.push(value); else if (arg === '--detail') result.detail = value; else result.output = value;
    } else if (arg.startsWith('-') || result.manifest) throw new Error('실행 인자를 확인해 주세요. --help에서 사용법을 볼 수 있습니다.');
    else result.manifest = arg;
  }
  if (!result.manifest) throw new Error('검사할 피드백 manifest.json 경로를 지정해 주세요.');
  return result;
}

const clock = frame => {
  const ms = Math.round(frame / 30 * 1000);
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const ranges = items => items.length ? items.map(item => item.frameOut - item.frameIn === 1 ? clock(item.frameIn) : `${clock(item.frameIn)}–${clock(item.frameOut)}`).join(', ') : '현재 대응 장면 없음';
const quote = text => String(text).split('\n').map(line => `> ${line}`).join('\n');

function markdown(result) {
  const lines = ['# Gemini 피드백 해석 테스트', '', `모델: ${result.model}`, '', 'AI가 장면 스틸과 피드백을 읽은 검토용 결과입니다. 원문·시점은 로컬 자료에서 그대로 가져왔습니다. 영상 전체와 음성은 전송하지 않았고 편집은 실행하지 않았습니다.', ''];
  for (const [index, item] of result.feedback.entries()) {
    lines.push(`## ${index + 1}. 작성 ${ranges([item.authored])}`, '', `현재 대응: ${ranges(item.current.ranges)}`, '', '### 피드백 원문', '', quote(item.originalFeedback.original), '');
    for (const supplement of item.originalFeedback.supplements ?? []) lines.push('보완 내용', '', quote(supplement.text), '');
    lines.push('### Gemini의 장면 관찰', '', quote(item.analysis.observedScene), '', '### Gemini가 이해한 피드백', '', quote(item.analysis.feedbackSummary), '', '### 확인할 내용', '');
    if (item.analysis.questions.length) lines.push(...item.analysis.questions.map(question => `- ${question.replace(/\n/g, ' ')}`), '');
    else lines.push('모델이 추가 질문을 제시하지 않았습니다. 의미가 맞는지는 사람이 검토해야 합니다.', '');
  }
  return lines.join('\n');
}

async function main() {
  const input = options(process.argv.slice(2));
  if (input.help) { process.stdout.write(`${help}\n`); return; }
  const manifestPath = resolve(input.manifest);
  const info = await stat(manifestPath);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('32 MiB 이하의 피드백 manifest.json 파일이 필요합니다.');
  const original = await readFile(manifestPath);
  const prepared = await prepareGeminiFeedback(manifestPath, { ...(input.commentIds.length ? { commentIds: input.commentIds } : {}), detail: input.detail, includeTranscripts: input.includeTranscripts });
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const parent = resolve(input.output); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, input.live ? 'live-' : 'dry-run-'));
  const codeHashes = {};
  for (const file of ['scripts/test-gemini-feedback.mjs', 'apps/worker/gemini-feedback.mjs']) codeHashes[file] = createHash('sha256').update(await readFile(new URL(`../${file}`, import.meta.url))).digest('hex');
  const report = { createdAt: new Date().toISOString(), provider: 'gemini', model, mode: input.live ? 'live' : 'dry-run', inputManifest: manifestPath, inputManifestSha256: createHash('sha256').update(original).digest('hex'), requestSha256: createHash('sha256').update(JSON.stringify(prepared.request)).digest('hex'), codeHashes, prepared: prepared.summary, modelCalled: false, networkAttempted: false, generationRequestCount: 0, responseValidated: false };
  const started = performance.now();
  try {
    if (input.live) {
      if (!process.env.GEMINI_API_KEY?.trim()) throw new Error('GEMINI_API_KEY를 .env.local에 설정해 주세요. 외부 호출은 하지 않았습니다.');
      report.result = await analyzeGeminiFeedback(prepared, { apiKey: process.env.GEMINI_API_KEY, model, fetchImpl: (...args) => {
        report.networkAttempted = true; report.modelCalled = null; report.generationRequestCount++;
        return fetch(...args);
      } });
      report.modelCalled = true;
      report.responseValidated = true;
      await writeFile(join(directory, 'review.md'), markdown(report.result));
      // Model observations stay a separate file; the export CLI attaches them only when asked, labelled as model output.
      const observations = { kind: 'video-feedback-observations', schemaVersion: 1, provider: 'gemini', model, createdAt: report.createdAt, sourceManifestSha256: report.inputManifestSha256, imageDetail: prepared.summary.imageDetail, items: report.result.feedback.map(item => ({ id: item.id, entryDigest: item.entryDigest, ...item.analysis })) };
      await writeFile(join(directory, 'observations.json'), JSON.stringify(observations, null, 2));
    }
    report.inputManifestPreserved = original.equals(await readFile(manifestPath));
    if (!report.inputManifestPreserved) throw new Error('검사 도중 원본 manifest가 변경되었습니다. 결과를 다시 검토해 주세요.');
    report.status = input.live ? 'response-validated-needs-human-review' : 'prepared-no-network';
  } catch (error) {
    report.status = 'failed';
    // Adapter errors are intentionally generic. Never serialize response headers, payloads or credentials.
    report.error = String(error?.message || 'Gemini 테스트에 실패했습니다.').replaceAll(process.env.GEMINI_API_KEY || '\0', '[redacted]');
    process.exitCode = 1;
  } finally {
    report.elapsedMs = Math.round(performance.now() - started);
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ status: report.status, model, commentCount: prepared.summary.commentCount, imageCount: prepared.summary.imageCount, report: join(directory, 'report.json'), imageDetail: prepared.summary.imageDetail, ...(report.modelCalled ? { review: join(directory, 'review.md'), observations: join(directory, 'observations.json') } : {}), ...(report.error ? { error: report.error } : {}) }) + '\n');
  }
}

main().catch(error => {
  const message = String(error?.message || '테스트 준비에 실패했습니다.').replaceAll(process.env.GEMINI_API_KEY || '\0', '[redacted]');
  process.stderr.write(`${message}\n`); process.exitCode = 1;
});
