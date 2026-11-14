# AI·도구용 피드백 전달 형식 v2

2026-10-15 사용자 결정: **“작업물을 AI와 다른 코드 형태로 빠르게 받아보고 해석할 수 있는 게 포인트. 영상과 이미지를 다 보는 게 아니라, 필요하면 본다.”**

피드백 내보내기 묶음은 **글을 먼저 읽고, 이미지는 필요할 때만 여는** 순서로 구성한다. 영상 파일은 넣지 않는다. 형식 규격은 [schema/feedback-handoff.schema.json](../schema/feedback-handoff.schema.json)이다.

## 읽는 순서

| 단계 | 파일 | 언제 여는가 |
|---|---|---|
| 1. 글 | `feedback.jsonl` (한 줄에 피드백 하나) 또는 `manifest.json` | 항상 먼저 |
| 2. 피드백별 한 장 | `sheets/feedback-0001.jpg` | 글만으로 장면이나 그림 대상을 판단할 수 없을 때 |
| 3. 개별 스틸 | `scenes/…`, `annotations/…` | 한 장 요약의 작은 칸으로 부족할 때 |
| 영상 전체 흐름 | `overview/grid.jpg` 한 장 | 피드백 사이의 흐름이나 전체 구성이 필요할 때 |

사람이 읽는 문서는 `feedback.md`, 영상 플레이어에 띄워 보는 자막은 `feedback.vtt`다.

## 글만으로 알 수 있게 한 것

- **그림 위치 문장**: 그림 좌표를 로컬에서 문장으로 바꾼다. 예: `빨간 박스(#ff0000, 채움) · 화면 왼쪽 위 · 가로 10–30%, 세로 10–30% (화면의 약 4%)`. 화살표는 시작·끝 위치와 방향, 펜은 점·그은 선·둘러싼 표시를 구분한다. 모델을 쓰지 않는 계산이다.
- **영상 개요**: 기준 버전의 길이, 화면 변화량으로 추정한 컷 구간 목록, 12칸 전체 흐름 이미지 1장. 컷 구간은 `estimated: true`인 추정값이다.
- **음성 받아쓰기**: 사용자가 카드의 **로컬 받아쓰기**를 누른 음성만 글로 들어간다. `transcript.source: "asr"`, 엔진·모델·언어를 함께 적는다. 자동 결과이므로 원본 음성과 대조해야 한다.
- **AI 관찰**: Gemini 테스트(`--live`)가 남긴 `observations.json`을 CLI의 `--observations`로 붙인 경우에만 들어간다. `source: "model"`로 사용자 기록과 구분하며, 그 뒤 피드백이 바뀌었으면 `stale: true`다.

사용자가 쓴 장면 설명(`sceneDescription.source: "user"`), 자동 받아쓰기(`asr`), 모델 관찰(`model`)은 서로 대체하지 않는다.

## 파일과 필드

`manifest.json`의 `feedback[]` 한 항목:

| 필드 | 의미 |
|---|---|
| `number` | 문서·JSONL·VTT에서 같은 번호 |
| `authored` | 작성 당시 버전과 프레임 구간 `[frameIn, frameOut)`, 기준 프레임 |
| `current` | 기준 버전에서의 대응 구간, `present` · `partial` · `deleted` · `unavailable` |
| `sceneDescription`, `feedback` | 사용자 장면 설명, 원문과 보완 |
| `drawings` | 그림의 정확한 정규화 좌표 (원본 그대로) |
| `drawingProjection` | 그림별 작성·현재 프레임과 위치 문장 |
| `scenes` | 기준·시작·중간·끝·그림 프레임의 스틸과 그림 표시 스틸 |
| `sheet` | 한 장 요약 이미지와 칸마다의 프레임·역할·위치(x, y, w, h) |
| `attachments` | 참고 이미지, 음성(받아쓰기 포함 가능) |
| `observations` | 붙인 경우에만, 모델 관찰 |

`feedback.jsonl` 첫 줄은 `type: "handoff"`(기준 버전, 길이, 컷 구간, 읽는 순서), 이후 줄은 `type: "feedback"`이다. 그림 상자는 소수 넷째 자리로 줄였고, 정확한 값은 `manifest.json`에 그대로 둔다.

`feedback.vtt`는 기준 버전 시간축의 자막이다. 한 시점 피드백은 보기 편하도록 최대 2초 동안 보여 준다. 현재 버전에서 사라진 장면의 피드백은 다른 시점에 붙이지 않고 `NOTE`에 남긴다.

## 받는 방법

앱: **피드백 내보내기** → 묶음(ZIP), 문서, 구조화 데이터, **AI용 글 자료(JSONL)**, **자막 형식(VTT)**.

명령: 앱 화면 없이 바로 받는다. 앱 DB는 읽기만 하고 모델 호출·외부 전송·받아쓰기는 하지 않는다.

```sh
npm run export -- --format jsonl          # 한 줄에 피드백 하나 (표준 출력)
npm run export -- --format md             # 사람용 문서
npm run export -- --format paths          # 생성된 파일 경로
npm run export -- --version 2 --comment-id ID --out ./handoff
npm run export -- --observations storage/qa/gemini-feedback/live-XXXX/observations.json
```

자료는 `storage/cli-exports/<내용 해시>/`에 만들고 같은 내용이면 다시 만들지 않는다. 영상 개요는 버전 파일마다 `storage/overviews/`에 한 번만 만든다.

## 편집 기능의 요청별 AI용 자료

편집 기능의 **AI용 자료 준비**도 같은 항목 형식(`kind: "video-feedback-context"`, `feedback[0]`)을 쓴다. 그림 표시 스틸과 `sheet.jpg` 한 장 요약을 함께 만든다. 기존 최상위 필드(`sceneFrames`, `instructionHistory` 등)는 편집 도구와의 호환을 위해 유지한다.

## 음성 받아쓰기 설정

받아쓰기는 사용자의 컴퓨터에 설치한 [whisper.cpp](https://github.com/ggml-org/whisper.cpp)를 쓴다. 음성을 밖으로 보내지 않는다. 저장이나 내보내기가 받아쓰기를 자동으로 시작하지 않는다.

```sh
brew install whisper-cpp                   # whisper-cli 설치 (macOS)
# 모델: whisper.cpp의 models/download-ggml-model.sh small 등으로 받은 ggml-*.bin (한국어는 small 이상 권장)
WHISPER_CPP_PATH=/opt/homebrew/bin/whisper-cli \
WHISPER_MODEL_PATH=/path/to/ggml-small.bin \
WHISPER_LANGUAGE=ko \
npm run dev
```

두 경로가 모두 있을 때만 카드의 음성 메모에 **로컬 받아쓰기** 버튼이 나타난다.

## Gemini 검토와의 관계

`npm run test:gemini`는 형식 v2 자료에서 기본으로 **피드백당 한 장 요약 + 참고 이미지**만 보낸다. 검증용 합성 영상의 피드백 3개 묶음에서 이미지 16장(요청 912KB)이 4장(236KB)으로 줄었다. 전체 스틸이 필요하면 `--detail full`을 쓴다. 받아쓰기 글은 `--include-transcripts`를 붙일 때만 보내며 음성 파일은 보내지 않는다. 자세한 내용은 [Gemini 테스트](Gemini테스트.md)를 따른다.
