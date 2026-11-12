import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVertexImage } from '../apps/worker/vertex-image.mjs';

const usage = `Vertex 이미지 생성: 설명을 표준 입력으로 전달합니다. 기본 실행은 외부 호출 없는 미리보기입니다.\nnode scripts/vertex-image.mjs --project PROJECT [--live --request-id UUID-V4]\n--live는 설명 텍스트를 Google에 전송하고 비용이 발생할 수 있습니다. 영상·이미지·음성 입력은 지원하지 않습니다.\n`;
try {
  const args = process.argv.slice(2); let project, requestId, live = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { process.stdout.write(usage); process.exit(0); }
    if (args[i] === '--live') { if (live) throw new Error('옵션을 중복 지정했습니다.'); live = true; }
    else if (args[i] === '--project' || args[i] === '--request-id') {
      const key = args[i], value = args[++i]; if (!value || value.startsWith('--')) throw new Error('옵션 값을 확인해 주세요.');
      if (key === '--project') { if (project) throw new Error('프로젝트를 중복 지정했습니다.'); project = value; }
      else { if (requestId) throw new Error('요청 ID를 중복 지정했습니다.'); requestId = value; }
    } else throw new Error('지원하지 않는 옵션입니다.');
  }
  if (process.stdin.isTTY) throw new Error('설명을 표준 입력으로 전달해 주세요.');
  process.stdin.setEncoding('utf8');
  let prompt = '';
  for await (const chunk of process.stdin) { prompt += chunk.toString('utf8'); if (prompt.length > 2000) throw new Error('설명은 2000자 이하여야 합니다.'); }
  const result = await generateVertexImage({ project, prompt, requestId, live, storageRoot: process.env.VI_STORAGE_ROOT ? resolve(process.env.VI_STORAGE_ROOT) : fileURLToPath(new URL('../storage', import.meta.url)) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error?.code ? `${error.code}: ` : ''}${error?.message || '이미지 작업에 실패했습니다.'}\n`);
  process.exitCode = 1;
}
