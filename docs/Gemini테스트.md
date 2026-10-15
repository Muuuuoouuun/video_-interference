# Gemini 피드백 해석 테스트

2026-10-14 사용자 결정에 따라 필요한 AI API 테스트에는 Gemini를 사용한다. 첫 검증 대상은 **시간별 피드백 자료를 AI가 제대로 읽는지**다. 영상 파일을 보내거나 편집을 실행하지 않는다.

## 입력과 결과

기존 ‘피드백 내보내기’의 `manifest.json`과 같은 폴더의 자료를 사용한다. 한 번에 최대 3개 피드백의 문구·보완 이력·타임코드·그림 좌표·장면 스틸·그림 표시·참고 이미지를 준비한다. 음성은 이 테스트에서 전송하거나 전사하지 않는다. 전달 이미지와 제외한 음성 개수는 검사 결과에 기록한다.

Gemini는 장면 관찰, 피드백 요약, 확인할 사항만 반환한다. 작성 시점과 현재 버전 대응, 원문은 로컬 자료에서 그대로 복사해 결과에 연결한다. 반환된 피드백 ID와 근거 프레임을 검사하며, 알 수 없는 ID나 빠진 항목을 허용하지 않는다. 원문·승인·영상 버전은 변경하지 않는다.

결과는 `storage/qa/gemini-feedback/` 아래 별도 폴더에 저장한다.

- `report.json`: 전송 항목, 모델·사용량, 검증된 응답, 원본 시점과 피드백
- `review.md`: 사람이 원문과 Gemini 관찰·요약을 비교할 문서

기존 내보내기 자료의 `modelCalled:false`는 로컬 자료를 준비한 이력이다. Gemini 호출 이력은 별도 테스트 결과에 기록하며 기존 manifest를 덮어쓰지 않는다.

## 형식 v2: 한 장 요약 우선

2026-10-15부터 피드백 내보내기는 형식 v2([AI·도구용 전달 형식](AI전달형식.md))다. v2 자료에서는 기본으로 **피드백당 한 장 요약(`sheets/`)과 참고 이미지**만 보낸다. 한 장 요약의 칸마다 프레임·역할·위치·그림 표시 여부를 `scene_sheet` 바인딩으로 함께 보내고, 그림 좌표를 로컬에서 바꾼 위치 문장(`drawingDescriptions`)도 글로 보낸다.

| 검증용 합성 영상의 피드백 3개 묶음 (로컬 준비, 호출 없음) | 이미지 | 요청 크기 |
|---|---|---|
| `--detail full` (이전과 같은 전체 스틸) | 16장 | 912KB |
| 기본 `auto` → 한 장 요약 | 4장 | 236KB |

같은 내용을 작은 칸으로 보는 것이므로, 작은 글씨나 세부가 필요하면 `--detail full`로 다시 확인한다. 한 장 요약 모드의 실제 Gemini 호출 결과와 토큰 수는 아직 측정하지 않았다. v1 자료(한 장 요약 없음)는 자동으로 전체 스틸을 보낸다.

받아쓰기 글은 `--include-transcripts`를 붙일 때만 보낸다. 음성 파일은 어떤 경우에도 보내지 않는다. `--live`가 성공하면 `observations.json`을 함께 남긴다. 이 파일은 `npm run export -- --observations 경로`로 전달 자료에 붙일 수 있고, 모델 결과(`source: "model"`)로 따로 표시된다. 그 뒤 피드백이 바뀌면 `stale: true`로 표시한다.

## 실행

프로젝트 루트의 `.env.local`에서 `GEMINI_API_KEY`와 `GEMINI_MODEL`을 읽는다. 형식은 [.env.example](../.env.example)을 참고한다. `.env.local`은 Git에서 제외하며 키 값을 로그나 결과에 넣지 않는다. 모델 기본값은 `gemini-3.5-flash-lite`이고 설정으로 바꿀 수 있다.

```sh
# 로컬 검증만: 외부 전송 없음
npm run test:gemini -- /path/to/export/manifest.json

# 명시적으로 한 번 호출: 스틸·그림·피드백을 Gemini에 전송
npm run test:gemini -- /path/to/export/manifest.json --live

# 큰 묶음에서는 검토할 항목을 선택
npm run test:gemini -- /path/to/export/manifest.json --comment-id feedback-id --live

# 전체 스틸로 보기, 받아쓰기 글 포함
npm run test:gemini -- /path/to/export/manifest.json --detail full --include-transcripts --live
```

동일 호출을 자동 재시도하지 않는다. API 오류·제한·형식 불일치는 테스트 실패로 남긴다. 일반 `npm test`, 앱의 저장·내보내기는 Gemini를 호출하지 않는다. 이 테스트는 아직 앱의 ‘요청 해석’ 버튼에 연결된 기능이 아니다.

## 의미 검수

자동 검사는 구조와 앵커 보존을 확인한다. 장면 이해의 정확도는 결과 문서를 따로 읽고 판단한다.

1. 주석 그림을 영상 자체의 그래픽으로 오해하지 않는가.
2. 원문뿐 아니라 보완 지시도 반영하는가.
3. 참고 이미지를 자동 삽입 요청으로 바꾸지 않는가.
4. 삭제된 장면을 현재 영상의 다른 시점에 붙이지 않는가.
5. 정지 이미지에서 확인할 수 없는 속도·움직임·음성을 확인했다고 주장하지 않는가.
6. 메모와 편집 피드백을 구분하는가.

API 형식은 Google의 [이미지 입력 문서](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding), [구조화 응답 문서](https://ai.google.dev/gemini-api/docs/structured-output), [모델 목록](https://ai.google.dev/gemini-api/docs/models)을 기준으로 확인했다. 실제 호출의 모델 접근 가능 여부는 키로 별도 확인한다.


## 첫 실제 호출 결과

2026-10-14, `gemini-3.5-flash-lite`로 PC 영상에서 만든 피드백 3개와 이미지 16개를 한 번 전송했다. 자료는 약 1.68MB, 응답은 약 4.24초, 공급자 사용량은 입력 19,601·출력 334토큰이었다. 영상·음성 파일은 보내지 않았다.

- 학습 화면 모음, ‘하나의 교실.’ 문구, ClassIn 로고를 실제 스틸과 대조해 확인했다.
- ‘표시한 부분만 참고하고 원본 색 유지’ 보완을 요약에 유지했다.
- 삭제된 장면은 현재 버전에 없다는 점을 질문에 반영했다.
- 지정하지 않은 강조 방식·자막 이동 거리·줄일 제목은 임의로 만들지 않고 질문으로 남겼다.
- 좌표와 원문은 로컬에서 붙인 값이며, 모델이 시간 매핑을 계산했다는 의미가 아니다.

[실제 모델 해석 문서](../storage/qa/gemini-feedback/live-wLbzhU/review.md), [호출·전송 목록·사용량](../storage/qa/gemini-feedback/live-wLbzhU/report.json). 호출 후 빈 텍스트·null 응답 검증을 더 엄격하게 보완했고, 이미 받은 응답을 최종 검증기로 다시 검사했다. 이 [재검사](../storage/qa/gemini-feedback/live-wLbzhU/current-validator-check.json)는 외부 호출 없는 검증이며 두 번째 API 호출이 아니다.

이 결과는 작은 샘플의 의미 검토다. 그림이 정확히 어느 대상을 가리키는지, 복잡한 충돌·음성·다양한 영상 전체의 이해까지 통과한 것으로 확대하지 않는다. 앱의 AI 버튼 연결과 자동 편집은 이번 테스트 범위에 포함하지 않는다.
