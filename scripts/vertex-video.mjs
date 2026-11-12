import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVertexVideo, checkVertexVideoOperation } from '../apps/worker/vertex-video.mjs';

const usage = `Vertex 영상 생성 CLI (Google Veo)
설명을 표준 입력으로 전달합니다. 기본 실행은 외부 호출 없는 미리보기입니다.

사용법:
  node scripts/vertex-video.mjs --project PROJECT [--live --request-id UUID-V4] [옵션]
  node scripts/vertex-video.mjs --project PROJECT --check-operation OP_NAME --request-id UUID-V4 [옵션]

옵션:
  --live                      실제 Vertex API로 장기 작업(LRO)을 제출합니다. 과금이 발생할 수 있습니다.
  --request-id UUID-V4        작업 구분을 위한 고유 UUID v4 (실행 시 필수)
  --project PROJECT           Google Cloud 프로젝트 ID
  --location LOCATION         Vertex 리전 (기본값: us-central1)
  --duration 4|5|6|8          생성할 영상 길이(초, 기본값: 4)
  --aspect-ratio 16:9|9:16|1:1 영상 화면비 (기본값: 16:9)
  --poll                      작업 제출 후 완료까지 대기하며 상태를 확인합니다.
  --check-operation OP_NAME   이미 제출된 작업의 상태를 1회 확인하고 완료 시 영상을 저장합니다.
  -h, --help                  도움말 출력

주의: 영상·이미지·음성 파일 입력은 지원하지 않으며 오직 텍스트 프롬프트만 지원합니다.
`;

try {
  const args = process.argv.slice(2);
  let project;
  let requestId;
  let live = false;
  let location;
  let durationSeconds;
  let aspectRatio;
  let poll = false;
  let checkOperation;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage);
      process.exit(0);
    }
    if (arg === '--live') {
      if (live) throw new Error('옵션을 중복 지정했습니다.');
      live = true;
    } else if (arg === '--poll') {
      if (poll) throw new Error('옵션을 중복 지정했습니다.');
      poll = true;
    } else if (arg === '--project' || arg === '--request-id' || arg === '--location' ||
               arg === '--duration' || arg === '--aspect-ratio' || arg === '--check-operation') {
      const key = arg;
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('옵션 값을 확인해 주세요.');
      if (key === '--project') {
        if (project) throw new Error('프로젝트를 중복 지정했습니다.');
        project = value;
      } else if (key === '--request-id') {
        if (requestId) throw new Error('요청 ID를 중복 지정했습니다.');
        requestId = value;
      } else if (key === '--location') {
        if (location) throw new Error('리전을 중복 지정했습니다.');
        location = value;
      } else if (key === '--duration') {
        if (durationSeconds) throw new Error('길이를 중복 지정했습니다.');
        const parsed = Number(value);
        if (!Number.isInteger(parsed)) throw new Error('영상 길이는 정수여야 합니다.');
        durationSeconds = parsed;
      } else if (key === '--aspect-ratio') {
        if (aspectRatio) throw new Error('화면비를 중복 지정했습니다.');
        aspectRatio = value;
      } else if (key === '--check-operation') {
        if (checkOperation) throw new Error('작업명을 중복 지정했습니다.');
        checkOperation = value;
      }
    } else {
      throw new Error(`지원하지 않는 옵션입니다: ${arg}`);
    }
  }

  const storageRoot = process.env.VI_STORAGE_ROOT
    ? resolve(process.env.VI_STORAGE_ROOT)
    : fileURLToPath(new URL('../storage', import.meta.url));

  if (checkOperation) {
    if (!project || !requestId) {
      throw new Error('--check-operation에는 --project와 --request-id가 모두 필요합니다.');
    }
    const checkResult = await checkVertexVideoOperation({
      project,
      location,
      operationName: checkOperation,
      requestId,
      storageRoot,
    });
    process.stdout.write(`${JSON.stringify(checkResult)}\n`);
    process.exit(0);
  }

  if (process.stdin.isTTY) {
    throw new Error('영상 설명을 표준 입력으로 전달해 주세요.');
  }

  process.stdin.setEncoding('utf8');
  let prompt = '';
  for await (const chunk of process.stdin) {
    prompt += chunk.toString('utf8');
    if (prompt.length > 2000) throw new Error('설명은 2000자 이하여야 합니다.');
  }

  const result = await generateVertexVideo({
    project,
    prompt,
    requestId,
    live,
    location,
    durationSeconds,
    aspectRatio,
    poll,
    storageRoot,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error?.code ? `${error.code}: ` : ''}${error?.message || '영상 작업에 실패했습니다.'}\n`);
  process.exitCode = 1;
}
