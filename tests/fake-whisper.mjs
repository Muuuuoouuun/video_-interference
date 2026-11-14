import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A stand-in for whisper.cpp's CLI: it checks the 16 kHz WAV input and writes the `-oj` JSON shape. */
export async function fakeWhisper(directory) {
  const binary = join(directory, 'whisper-cli'), model = join(directory, 'ggml-test.bin'), calls = join(directory, 'whisper-calls');
  await writeFile(model, 'not a real model');
  await writeFile(binary, `#!/bin/sh
out=""; wav=""
for arg in "$@"; do echo "$arg" >> "${calls}"; done
while [ $# -gt 0 ]; do
  case "$1" in
    -of) out="$2"; shift 2;;
    -f) wav="$2"; shift 2;;
    *) shift;;
  esac
done
[ "$(head -c 4 "$wav")" = "RIFF" ] || exit 3
printf '%s' '{"transcription":[{"timestamps":{"from":"00:00:00,000","to":"00:00:01,500"},"offsets":{"from":0,"to":1500},"text":" 자막을   조금 더"},{"offsets":{"from":1500,"to":2800},"text":" 크게 해 주세요"},{"offsets":{"from":2800,"to":3000},"text":"  "}]}' > "$out.json"
`);
  await chmod(binary, 0o755);
  return { binary, model, calls };
}
