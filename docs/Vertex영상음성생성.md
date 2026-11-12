# Vertex 영상·음성 생성 CLI

이 가이드는 Google Cloud Vertex AI 기반 텍스트 생성 기능(영상 생성: Google Veo, 음성 생성: Gemini Audio)의 실행 및 안전 가드를 설명한다. CLI 기본 실행은 외부 통신과 파일 쓰기가 없는 **미리보기(preview)**다. 앱에서는 별도의 명시적 생성 화면을 이용하며 기존 피드백 저장·내보내기는 모델을 호출하지 않는다. 사용자 개인의 영상·이미지·음성 파일은 읽거나 전송하지 않으며 오직 텍스트 프롬프트만 취급한다.

---

## 1. 영상 생성 CLI (Google Veo)

Vertex AI의 비디오 생성 모델(`veo-3.1-lite-generate-001`, 가장 비용 효율적인 모델)을 사용하여 텍스트 설명으로부터 MP4 영상을 생성한다. 영상 생성은 긴 처리 시간이 소요되는 **비동기 장기 작업(Long-Running Operation, LRO)**으로 동작한다.

### 사용법

```sh
# 1) 외부 호출 없이 설정 및 미리보기 검사 (기본 실행)
printf '%s' '해질녘 안개 낀 소나무 숲을 부드럽게 비추는 시네마틱 드론 샷' | node scripts/vertex-video.mjs --project PROJECT_ID

# 2) 실제 호출: LRO 작업 제출 (비동기 작업 등록)
printf '%s' '해질녘 안개 낀 소나무 숲을 부드럽게 비추는 시네마틱 드론 샷' | node scripts/vertex-video.mjs --project PROJECT_ID --live --request-id NEW_UUID_V4

# 3) 실제 호출 + 작업 완료까지 대기(polling) 후 비디오 자동 저장 (기본 4초, 720p)
printf '%s' '해질녘 안개 낀 소나무 숲을 부드럽게 비추는 시네마틱 드론 샷' | node scripts/vertex-video.mjs --project PROJECT_ID --live --request-id NEW_UUID_V4 --poll

# 4) 이미 제출된 장기 작업의 현재 상태 1회 조회 및 완료 시 다운로드
node scripts/vertex-video.mjs --project PROJECT_ID --check-operation "projects/PROJECT_ID/locations/us-central1/operations/OPERATION_ID" --request-id USED_UUID_V4
```

### 옵션
- `--project PROJECT_ID`: Google Cloud 프로젝트 ID (필수)
- `--live`: 실제 Google Cloud Vertex AI API로 요청을 전송 (과금 발생 가능)
- `--request-id UUID-V4`: 요청마다 새로 발급하는 UUID v4 (중복 방지 및 멱등성 보장)
- `--location LOCATION`: Vertex AI 리전 (기본값: `us-central1`)
- `--duration 4|5|6|8`: 생성 영상 길이(초 단위, 기본값: `4`초 - 최소 비용)
- `--aspect-ratio 16:9|9:16|1:1`: 영상 화면비 (기본값: `16:9`)
- `--poll`: 작업 제출 후 공급자 완료까지 대기하며 상태를 확인하고 완료 시 `video.mp4`를 저장
- `--check-operation OP_NAME`: 기제출된 장기 작업의 단독 상태 확인

### 장기 작업(LRO) 상태 관리 및 결과 저장
- 결과는 `storage/vertex-videos/요청ID/`에 저장된다.
- 작업 제출 시 즉시 `operation.json` 파일에 작업 상태(`SUBMITTING` -> `PENDING` -> `RUNNING` -> `SUCCEEDED` / `FAILED`)가 원자적으로 기록된다.
- 완료 시 `storage/vertex-videos/요청ID/video.mp4` 파일로 저장된다 (`0o600` 권한).
- 사용한 요청 ID는 디렉터리로 예약되어 실패·타임아웃 이후에도 동일 ID로 다시 호출되지 않는다 (`DUPLICATE_REQUEST`).
- 네트워크 전송 이후의 오류는 과금 가능성이 있으므로 자동 재시도하지 않고 에러를 기록한다.

---

## 2. 음성 생성 CLI (Gemini Audio)

Vertex AI의 Gemini 모델(`gemini-3.8-flash-lite-tts`, responseModalities: `["AUDIO"]`)을 사용하여 텍스트 대사로부터 24kHz 모노 PCM WAV 음성을 생성한다.

### 사용법

```sh
# 1) 외부 호출 없이 설정 및 미리보기 검사 (기본 실행)
printf '%s' '안녕하세요, 새로운 편집본을 확인해 주세요.' | node scripts/vertex-audio.mjs --project PROJECT_ID

# 2) 실제 호출: 음성 1회 생성 및 로컬 저장
printf '%s' '안녕하세요, 새로운 편집본을 확인해 주세요.' | node scripts/vertex-audio.mjs --project PROJECT_ID --live --request-id NEW_UUID_V4 --voice Puck
```

### 옵션
- `--project PROJECT_ID`: Google Cloud 프로젝트 ID (필수)
- `--live`: 실제 Google Cloud Vertex AI API로 요청을 전송 (과금 발생 가능)
- `--request-id UUID-V4`: 요청마다 새로 발급하는 UUID v4 (중복 방지 및 멱등성 보장)
- `--location LOCATION`: Vertex AI 리전 (기본값: `global`)
- `--voice VOICE`: 사전 설정 음성 (`Puck`, `Charon`, `Kore`, `Fenrir`, `Aoede`, 기본값: `Puck`)

### 결과 저장
- 결과는 `storage/vertex-audio/요청ID/audio.wav`에 저장된다 (`0o600` 권한). 손상된 응답과 헤더 없는 raw PCM은 거부한다.
- 요청 ID 중복 방지 및 심볼릭 링크 거부 등 보안 검증이 동일하게 적용된다.

---

## 3. 공통 안전 규칙 및 제한 사항

1. **비활성 기본 (Preview by default)**: `--live`를 지정하지 않으면 외부 네트워크 호출이나 파일 쓰기를 전혀 수행하지 않는다 (`networkAttempted: false`).
2. **Google Cloud ADC 인증**: 공식 `google-auth-library`를 통해 로컬의 Application Default Credentials(ADC)로부터 단기 Bearer 토큰을 획득한다. 토큰과 인증 정보는 로그나 결과 파일에 남기지 않는다.
3. **API 키 자동 폴백 금지**: 기존 Gemini Developer API 키(`GEMINI_API_KEY`)로 절대 폴백하지 않으며 `x-goog-api-key` 헤더를 전송하지 않는다. 오직 Vertex AI의 Bearer 토큰 경로만 사용한다.
4. **개인 미디어 보호**: 사용자의 로컬 영상, 프레임 스틸, 드로잉, 오디오 파일은 절대 외부로 전송하지 않는다. 오직 표준 입력으로 전달한 텍스트 프롬프트만 모델에 전달된다.
5. **호출 및 크기 상한**:
   - 텍스트 프롬프트는 제어 문자를 제외한 2,000자 이하로 제한된다.
   - 단일 실행당 1회 호출 원칙(단일 샷)을 유지하며 임의의 자동 재시도를 하지 않는다.
   - 비디오 LRO 폴링은 최대 30회 / 10분 상한이 설정되어 있다.
   - 응답 크기는 영상 최대 64MB, 음성 최대 16MB로 제한된다.
6. **실계정 과금 및 크레딧 차감 주의**:
   - 모의 테스트(`tests/vertex-video.test.mjs`, `tests/vertex-audio.test.mjs`)와 합성 로컬 파일로 응답 및 저장 흐름을 검사했다.
   - 모델별 접근 권한, 실제 사용료 및 크레딧 적용은 청구 화면에서 확인한다.

## 앱 화면에서 사용

앱의 AI 음성·영상 생성은 서버 설정으로 명시적으로 활성화한 후 사용할 수 있다. 설정 방법은 [Vertex 이미지 생성](Vertex이미지생성.md)의 앱 실행 절과 같다. 입력한 대사 또는 설명만 전송하며, 생성 결과는 프로젝트에 자동으로 삽입되지 않는다. 음성은 재생·다운로드, 영상은 장기 작업의 **상태 확인**을 누른 뒤 재생·다운로드한다. 상태 확인은 기존 작업을 조회하며 새 생성을 제출하지 않는다. 앱 재시작 뒤에도 기존 작업 식별자를 보존하고 미확인 제출을 자동 재전송하지 않는다.
