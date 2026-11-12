import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVertexAudio } from '../apps/worker/vertex-audio.mjs';

const usage = `Vertex 음성 생성 CLI (Gemini Audio)
대사/텍스트를 표준 입력으로 전달합니다. 기본 실행은 외부 호출 없는 미리보기입니다.

사용법:
  node scripts/vertex-audio.mjs --project PROJECT [--live --request-id UUID-V4] [옵션]

옵션:
  --live                      실제 Vertex API로 음성을 생성합니다. 과금이 발생할 수 있습니다.
  --request-id UUID-V4        작업 구분을 위한 고유 UUID v4 (실행 시 필수)
  --project PROJECT           Google Cloud 프로젝트 ID
  --location LOCATION         Vertex 리전 (기본값: global)
  --voice VOICE               음성 종류: Puck, Charon, Kore, Fenrir, Aoede (기본값: Puck)
  -h, --help                  도움말 출력

주의: 텍스트 이외의 미디어 입력(음성·영상·이미지)은 전송하지 않습니다.
`;

try {
  const args = process.argv.slice(2);
  let project;
  let requestId;
  let live = false;
  let location;
  let voiceName;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage);
      process.exit(0);
    }
    if (arg === '--live') {
      if (live) throw new Error('옵션을 중복 지정했습니다.');
      live = true;
    } else if (arg === '--project' || arg === '--request-id' || arg === '--location' || arg === '--voice') {
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
      } else if (key === '--voice') {
        if (voiceName) throw new Error('음성을 중복 지정했습니다.');
        voiceName = value;
      }
    } else {
      throw new Error(`지원하지 않는 옵션입니다: ${arg}`);
    }
  }

  if (process.stdin.isTTY) {
    throw new Error('음성 대사를 표준 입력으로 전달해 주세요.');
  }

  process.stdin.setEncoding('utf8');
  let prompt = '';
  for await (const chunk of process.stdin) {
    prompt += chunk.toString('utf8');
    if (prompt.length > 2000) throw new Error('대사는 2000자 이하여야 합니다.');
  }

  const storageRoot = process.env.VI_STORAGE_ROOT
    ? resolve(process.env.VI_STORAGE_ROOT)
    : fileURLToPath(new URL('../storage', import.meta.url));

  const result = await generateVertexAudio({
    project,
    prompt,
    requestId,
    live,
    location,
    voiceName,
    storageRoot,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error?.code ? `${error.code}: ` : ''}${error?.message || '음성 작업에 실패했습니다.'}\n`);
  process.exitCode = 1;
}
