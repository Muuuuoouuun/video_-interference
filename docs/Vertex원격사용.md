# Vertex 원격 사용

이 저장소의 영상·이미지·음성 생성과 선택적인 편집 요청 해석은 Vertex AI를 사용할 수 있다. GitHub 저장소에는 코드만 들어가며 Google 인증정보와 `storage/`는 포함하지 않는다. 각 실행 환경에 프로젝트와 인증을 따로 설정해야 한다. 사용 프로젝트의 결제 연결 및 적용 가능한 크레딧은 Google Cloud에서 별도로 확인한다.

## 다른 컴퓨터에서 실행

1. Vertex 기능을 포함한 버전의 저장소를 가져온다. Node.js 22.13 이상과 `ffmpeg`, `ffprobe`가 필요하다. 두 도구는 PATH에서 찾으며, 필요하면 `FFMPEG_PATH`와 `FFPROBE_PATH`로 실행 파일을 직접 지정한다.
2. `npm install --bin-links=false`로 의존성을 설치한다.
3. Vertex AI API가 활성화되고 호출 권한·결제가 설정된 Google Cloud 프로젝트에 대해, 해당 컴퓨터에서 `gcloud auth application-default login`으로 ADC를 설정한다. 대화창이나 저장소에 인증 파일과 토큰을 넣지 않는다. ADC는 `gcloud auth login`과 별개다.
4. Git에서 제외되는 `.env.vertex.local`에 다음을 설정하고 `npm run dev`로 실행한다.

```dotenv
VERTEX_PROJECT_ID=YOUR_GOOGLE_CLOUD_PROJECT_ID
VI_VERTEX_GENERATION_ENABLED=1
VI_INTERPRETER_PROVIDER=vertex
```

생성은 앱에서 명시적으로 실행한다. 해석은 영상 열기 → 더 보기 → 편집 기능 → 요청 생성 후 ‘요청 해석’을 눌렀을 때 실행된다. 해석은 선택한 스틸 한 장, 요청 텍스트·추가 지시·드로잉 좌표와 최대 3장의 첨부 이미지를 전송한다. 원본 전체 영상과 음성은 전송하지 않는다. 다중 프레임 드로잉 해석은 지원하지 않는다. Vertex 오류 시 기존 Gemini API 키로 자동 전환하지 않는다.

텍스트를 사용한 명령줄 생성 예시는 [영상·음성 생성](Vertex영상음성생성.md), [이미지 생성](Vertex이미지생성.md)을 참고한다. 미리보기에는 네트워크 호출이 없고 실제 생성에는 `--live`와 새 UUID 요청 ID가 필요하다. 출력은 실행 컴퓨터의 `storage/`에 저장된다. 영상 생성의 제출이 완료된 후 오류나 시간 초과가 발생하면 새 요청을 바로 보내지 말고 저장된 operation을 먼저 조회한다.

## Codex Cloud

Codex Cloud는 별도의 작업 환경이므로 이 컴퓨터의 ADC를 자동으로 사용할 수 없다. 현재 저장소에 대해 Cloud 환경이나 Google Cloud OIDC 연결이 구성·검증됐다고 가정하지 않는다.

설정할 때는 다음을 확인한다.

- 이 저장소를 포함하는 전용 Cloud 환경을 만들고 사용하려는 코드 버전을 선택한다. 앱 워커는 로컬 전용으로 설계되어 있으므로 인터넷에 직접 공개하지 않는다.
- Cloud 환경의 **Advanced → OIDC**에서 Google Cloud 연결을 구성하고, Google의 Workload Identity Federation에서 표시된 발급자·대상·주체 조건을 검증하도록 신뢰를 설정한다. 전용 서비스 계정에는 필요한 추론·할당량 권한만 부여한다. 이 코드의 Vertex 호출 및 쿼터 프로젝트에는 `aiplatform.endpoints.predict`, `serviceusage.services.use`가 필요하며 Veo 작업 조회 권한은 실제 연결에서 검증한다.
- 제한된 네트워크 정책에서는 인증에 필요한 Google 엔드포인트와 `aiplatform.googleapis.com`, `us-central1-aiplatform.googleapis.com` 등 사용하는 리전의 Vertex 엔드포인트를 허용한다. 주소 허용만으로 권한이 생기지는 않는다.
- Google Cloud OIDC 연결의 `gcloud` 인증은 OpenAI의 호환 목록에 있지만, Vertex AI와 이 저장소의 Node ADC 클라이언트는 목록에 명시되지 않았다. 게시된 환경에서 새 Cloud 작업을 시작해 ADC 인식, 권한, 텍스트·이미지·음성·영상 호출 및 영상 operation 재조회까지 직접 검증한다.
- Cloud 작업의 파일은 원격 작업 환경에 저장된다. 원본·생성물·operation 상태는 필요할 때 안전한 위치에 별도로 보존하고 공개 Git에 올리지 않는다.

참고: [OpenAI Cloud 환경과 OIDC](https://learn.chatgpt.com/docs/environments/cloud-environments), [Google Cloud 할당량 프로젝트 권한](https://docs.cloud.google.com/docs/quotas/set-quota-project), [Google Cloud Vertex 모델 접근 권한](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/access-control).
