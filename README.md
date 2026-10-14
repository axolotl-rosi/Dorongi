# Dorongi (도롱이) v4.0.0

> **엔트리(Entry) 작품을 독자적인 AOT 바이트코드 가상 머신(EniwanVM)과 WebGL 배치 렌더러로 변환하여 실행하는 브라우저 확장 프로그램**  
> Developed under **Eniwan Studio** | Copyright (c) 2026 **Axolotl_rosi**  
> Source-Available Software (*Dorongi Source-Available License v1.0*)

---

## 1. 제품 소개 (Introduction)

**Dorongi(도롱이)**는 [playentry.org](https://playentry.org)에서 실행되는 엔트리 작품의 성능과 제어 유연성을 극대화하기 위해 개발된 고성능 브라우저 확장 프로그램입니다.

### Dorongi가 해결하는 문제
기본 엔트리 웹 런타임(EntryJS)은 광범위한 교육용 기능과 다양한 브라우저 호환성을 위해 이벤트 중심 인터프리터 및 범용 2D/Canvas 렌더링 파이프라인을 사용합니다. 그러나 다음과 같은 고부하 작업에서는 브라우저의 메인 스레드 병목 현상과 심한 프레임 저하가 발생할 수 있습니다:
- 수천 개의 복제본(Clones) 및 고밀도 개체 물리 연산
- 3D 와이어프레임 렌더러, 레이캐스팅(Raycasting), 소프트바디 시뮬레이션
- 대규모 펜(붓) 드로잉 및 다각형 면 채우기 연산
- 화면 주사율과 무관하게 연산 속도만 빠르게 가속해야 하는 알고리즘/인공지능 시뮬레이션

### 독자 실행 엔진을 사용하는 이유
Dorongi는 기존 엔트리 런타임의 브라우저 타이머 속도만 변경하는 단순한 FPS 조절기가 아닙니다. 엔트리 프로젝트의 블록 계층 구조를 사전에 파악하여 독자 설계된 **고정 4-워드 레지스터 머신 ISA(EniwanVM Bytecode)**로 AOT(Ahead-of-Time) 컴파일한 뒤, **전용 WebGL 배치 파이프라인**을 통해 렌더링합니다.

| 구분 | 일반 엔트리 런타임 | Dorongi (EniwanVM) |
|---|---|---|
| **실행 방식** | 블록 AST 순회 인터프리터 | AOT 컴파일된 ISA 바이트코드 레지스터 VM + 순수 함수 네이티브 JIT |
| **렌더링 방식** | Canvas2D / 범용 Display Object 순회 | WebGL 동적 버텍스 배치 (`PolygonBatcher` & `SpritePass`) |
| **루프 제어** | 화면 갱신 주기(VSync)에 결합된 블록 틱 | **로직 갱신 주기(Logic Hz)와 화면 렌더 주기(Render Hz)의 독립 제어** |
| **메모리 할당** | 틱당 블록 상태 객체 생성 및 GC 발생 | 평탄화된 TypedArray 기반 고정 레지스터 할당 (Allocation-Free Tick) |
| **편집기 연동** | 저장된 프로젝트 다운로드 필요 | **`/ws` 편집기 인메모리 모델 직접 직렬화**로 미저장 코드 즉시 실행 |

### 최근 강화 엔진 요약

Dorongi 4.0.0의 가속은 단순히 FPS 제한을 높이는 방식이 아닙니다.

- **전체 함수 단위 가속**: Entry 블록을 고정폭 ISA로 변환하고, 검증 가능한 수치·목록·3D 함수는 Structured Native 코드로 승격합니다. 실측 Ray Tracing 작품은 사용자 함수 24개 모두 네이티브 대상으로 컴파일됩니다.
- **도로롱 모드**: `OP_YIELD`와 스레드 순서를 유지하면서 표시 가능한 한 화면 구간에 여러 완료 논리 틱을 처리합니다. 최근 틱 비용을 보고 다음 틱이 화면 예산을 넘길 가능성이 크면 시작하지 않습니다.
- **긴 반복의 협력적 양보**: fast-loop를 사용하는 긴 네이티브 함수는 필요할 때 generator continuation으로 전환됩니다. 중첩 함수 호출을 지나서도 재개 지점을 보존하며, 논리 틱이 끝나기 전의 펜 버퍼는 완성 화면으로 공개하지 않습니다.
- **화면 우선 계측**: 화면 제출 FPS, 실제 내용 갱신률, 완료 논리 틱률을 서로 다른 수치로 표시합니다. 화면만 반복 제출한 결과를 계산 성능으로 과장하지 않습니다.
- **가변 렌더 품질**: CSS 무대와 입력 좌표는 그대로 두고 WebGL backing store와 펜 FBO만 100%·75%·50%로 조절합니다. 자동 모드는 CPU 계산 병목을 GPU 병목으로 오인하지 않도록 히스테리시스를 사용합니다.
- **1~5단계 성능 프로필**: 모든 안정 최적화는 1단계부터 켜집니다. 단계는 기능을 빼는 스위치가 아니라 명령어, catch-up, 메모 캐시와 화면당 작업 예산의 상한을 해제합니다. 4단계는 대형 3D, 5단계는 극한 규모용입니다.

재현 가능한 실작품 벤치마크와 측정 조건은 [성능 벤치마크](docs/PERFORMANCE_BENCHMARKS.md)에 기록합니다.

---

## 2. 핵심 기능 상세 (Core Features)

### 2.1 독자 실행 엔진 & AOT 바이트코드 컴파일
엔트리 프로젝트가 로드되면 Dorongi는 즉시 프로젝트 구조를 기계적으로 분석하여 최적화된 바이트코드로 변환합니다.

```
[Entry Project JSON / In-Memory Snapshot]
                     │
                     ▼
        [정적 복잡도 분석기 (analyzer.js)]
                     │
                     ▼
         [AOT 컴파일러 (compiler.js)]
         - 불필요한 블록 가지치기 (Dead Code Elimination)
         - 정적 수식 상수 폴딩 (Constant Folding)
         - 레지스터 재사용 스케줄링
                     │
                     ▼
         [EniwanVM ISA 바이트코드 (isa.js)]
         (고정폭 4-Word: [opcode, dst, src1, src2])
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
 [Structured Native JIT]  [ISA 레지스터 인터프리터]
 (순수 연산 함수 직컴파일) (안전한 기본 가상 머신)
                     │
                     ▼
        [하이브리드 렌더링 & 입출력 시스템]
```

- **기술적 구현**: `isa.js`에 정의된 4-워드 고정폭 명령어 세트를 채택하여 가상 머신 루프 내에서 객체 생성 없이 고속 스위치-디스패치를 수행합니다. 순수 수치 연산과 루프로 이루어진 커스텀 함수는 `structured-native.js`를 통해 직접 JavaScript 네이티브 함수로 JIT 컴파일됩니다.
- **사용자 이점**: 복잡한 수치 연산 및 3D 기하 연산 시 블록 호출 오버헤드가 제거되어 훨씬 매끄러운 동작을 보장합니다.

### 2.2 화면(Render Hz)과 로직(Logic Hz)의 독립 제어
화면 렌더링 주기와 내부 시뮬레이션 주기를 분리하여 사용자가 자유롭게 구성할 수 있습니다.
- **동작 방식**: 
  - **Render Hz** (30 / 60 / 120 / 144 / 240 / Display VSync): 화면을 브라우저에 그리는 주기입니다. 고주사율 모니터에서 부드러운 움직임을 감상할 수 있습니다.
  - **Logic Hz** (30 / 60 / 120 / 240 / 무제한): 내부 변수 변경, 물리 충돌, 블록 연산을 계산하는 주기입니다. `performance.now()` 기반의 고정 타임스텝 누적기(Fixed Timestep Accumulator)로 작동하여 프레임 드랍 시에도 물리 연산이 일정하게 유지됩니다.
- **절충(Trade-off)**: 로직 주기를 무제한으로 높이면 연산 처리량이 비약적으로 증가하지만 CPU 사용률이 증가합니다. 저사양 환경에서는 적절한 타깃 주기를 선택할 수 있습니다.

### 2.3 터보 모드 & 배속 실행
- **동작 방식**: 1x, 2x, 4x, 8x 및 무제한(Uncapped) 설정을 지원합니다.
- **기술적 구현**: 틱당 허용되는 바이트코드 명령어 실행 예산을 배수만큼 확장하고, 렌더링 지연 대기 블록을 건너뛰어 시뮬레이션을 신속하게 완료합니다.

### 2.4 WebGL 배치 렌더링 파이프라인
- **PolygonBatcher (`polygon-batcher.js`)**: 펜 선 그리기와 다각형 면 채우기 명령을 CPU에서 즉시 화면에 그리지 않고 동적 버텍스 버퍼에 모아 하나의 드로우 콜로 GPU에 전송합니다. 깊이 버퍼(Depth Buffer)를 활성화하여 3D 렌더러 구현 시 화가 알고리즘(Painters Algorithm) 없이도 정확한 Z-소팅을 처리합니다.
- **SpritePass (`sprite-pass.js`)**: 스프라이트의 크기, 회전, 투명도, 밝기, 색조(HSV) 필터 변환을 WebGL 프래그먼트 셰이더에서 병렬 처리합니다.
- **DOM 오버레이**: 글상자, 말풍선, 변수/리스트 모니터는 캔버스 상단 DOM 레이어(`page/player.js`)에 정밀하게 배치하여 한글 글꼴 힌팅과 선명도를 유지합니다.

### 2.5 편집기 실시간 인메모리 연동 (`current-project.js`)
- **동작 방식**: `playentry.org/ws` 편집기에서 작업 중인 프로젝트를 저장하지 않고도 Dorongi 런타임으로 즉시 테스트할 수 있습니다.
- **기술적 구현**: 실행을 중단시키는 엔트리 기본 `exportProject()` 대신, 브라우저 메모리에 상주하는 `Entry.container`, `Entry.scene`, `Entry.variableContainer`, `Entry.dataTable`을 무부작용(Non-destructive)으로 직접 스냅샷 직렬화합니다.

### 2.6 호환성 검증 및 안전한 원본 복귀 (Fallback Gate)
Dorongi는 지원하지 않는 기능이 포함된 작품을 무리하게 실행하여 빈 화면이 표시되는 현상을 방지합니다.
- `page/gate.js`가 컴파일 결과물을 검사하여 엔진에 적합하지 않은 경우 자동으로 정품 엔트리 런타임(iframe)으로 복원합니다.
- 하단 컨트롤 바(Dock)의 **"엔트리 원본으로"** 버튼을 눌러 언제든 즉시 공식 실행기로 전환할 수 있습니다.

### 2.7 실시간 모니터링 HUD 및 팝업
- 확장 프로그램 아이콘을 누르면 열리는 팝업에서 현재 실행 중인 프로젝트의 **FPS**, **프레임 소요 시간(ms)**, **로직 소요 시간(ms)**, **렌더 소요 시간(ms)**, **실행 티어(Tier 1~3 / Native)**, **초당 처리 명령어 수**를 실시간으로 확인할 수 있습니다.

---

## 3. 기술 사양 (Technical Specifications)

| 항목 | 사양 및 구현 내용 |
|---|---|
| **제품 버전** | `4.0.0` |
| **확장 규격** | Chrome Manifest V3 (MV3) |
| **지원 브라우저** | Chromium 기반 브라우저 (Google Chrome, Microsoft Edge, Whale, Brave 등) |
| **대상 플랫폼** | `https://playentry.org/*` (작품 상세 페이지, 커뮤니티 뷰, `/ws` 편집기) |
| **실행 엔진** | EniwanVM (독자 레지스터 머신 가상 머신) |
| **컴파일러 구조** | AOT 바이트코드 컴파일러 (블록 AST → ISA 4-워드 튜플) |
| **실행 티어** | Dual-Tier (Tier 1: Bytecode Register Machine, Tier 2: Structured Native JIT) |
| **렌더링 백엔드** | WebGL 1.0/2.0 (`PolygonBatcher` + `SpritePass`) + DOM 오버레이 |
| **화면 갱신 설정 (Render Hz)** | 30, 60, 120, 144, 240, Display VSync (`requestAnimationFrame`) |
| **로직 갱신 설정 (Logic Hz)** | 30, 60, 120, 240, 무제한 (`performance.now()` 고정 타임스텝 누적기) |
| **터보 설정** | 1x, 2x, 4x, 8x, Uncapped (무제한 명령어 예산) |
| **요구 권한 (Permissions)** | `storage` (사용자 렌더/로직 Hz 설정 보관용) |
| **호스트 권한 (Host Permissions)** | `https://playentry.org/*` (외부 도메인 무단 접근 없음) |
| **외부 네트워크 통신** | **없음** (공식 엔트리 에셋 CDN 및 GraphQL 외의 제3자 외부 서버와 일체 통신하지 않음) |
| **개발 언어** | JavaScript (ES Modules, WebGL GLSL) |
| **호환성 안전장치** | `page/gate.js` 기반 사전 정적 판정 및 원본 iframe 폴백 |
| **아키텍처 세부 문서** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |

---

## 4. 지원 기능 및 호환성 한계 (Compatibility & Limits)

### 4.1 공식 지원 블록 범주
- **시작 / 이벤트**: 시작하기 클릭 시, 키보드 누름/뗌, 마우스 클릭/터치, 신호 보내기 및 받기
- **흐름 / 함수**: 조건문(만약 참이라면), 반복문(계속 반복, n번 반복, 조건 반복), 흐름 멈추기, 사용자 정의 함수(매개변수 및 반환값 지원)
- **움직임 / 좌표**: 좌표 이동, 방향 회전, 이동 방향으로 이동, 벽에 닿으면 튕기기
- **생김새**: 모양 바꾸기, 크기 조절, 색조(HSV) 효과, 밝기 효과, 투명도 효과, 보이기/숨기기
- **붓 / 도형**: 펜 내리기/올리기, 선 굵기/색상 지정, 다각형 그리기 및 면 채우기 (WebGL 가속)
- **자료 / 데이터**: 변수 읽기/쓰기, 리스트 조작, 데이터 테이블 읽기
- **연산 / 수학**: 사칙연산, 삼각함수, 난수 생성, 문자열 처리, 논리 연산
- **소리 / 오디오**: Web Audio API 기반 효과음 재생 및 볼륨 제어
- **복제본 (Clones)**: 복제본 동적 생성 및 삭제, 복제본 개별 로컬 변수
- **기타 인터랙션**: 글상자(Text), 말풍선(Bubble), 대답(Input Dialog), 초시계(Timer), 닉네임 조회

### 4.2 호환성 검증 관문 (Gate Fallback Triggers)
다음 조건 중 하나라도 감지되면 Dorongi는 실행을 강제하지 않고 안전하게 정품 엔트리 런타임으로 복귀합니다:

| 코드 | 발생 원인 | 처리 결과 |
|---|---|---|
| `no-draw` | 펜/도형 드로잉 블록도 없고, 화면에 그릴 유효한 모양(에셋)도 없음 | 원본 엔트리 iframe 복원 및 배너 알림 |
| `local-picture` | 엔트리 서버에 정상 업로드되지 않은 로컬 임시 이미지가 포함됨 | 원본 엔트리 iframe 복원 및 배너 알림 |
| `unsupported` | 컴파일러가 지원하지 않는 블록(센서, AI 등)이 감지됨 | 원본 엔트리 iframe 복원 (팝업에서 강제 실행 가능) |
| `no-thread` | 실행을 시작할 유효한 이벤트 엔트리 포인트가 없음 | 원본 엔트리 iframe 복원 |

### 4.3 현재 미지원 기능
- **하드웨어 연결 블록**: 아두이노, 마이크로비트 등 외부 센서 및 시리얼 통신 블록
- **인공지능 / 데이터 분석 특수 블록**: 인공지능 비디오/오디오 인식, 텍스트 감정 분석 블록
- **물리 엔진 블록**: 엔트리 내장 Box2D 물리 강체 시뮬레이션 블록

---

## 5. 성능 설계 원칙 (Performance Architecture)

Dorongi는 "모든 엔트리 작품이 무조건 수십 배 빨라진다"는 비현실적인 주장을 하지 않습니다. 대신 **구체적인 병목 지점의 오버헤드를 구조적으로 절감**하도록 설계되었습니다:

1. **객체 가비지 컬렉션(GC) 압력 최소화**:
   엔트리 인터프리터가 매 틱마다 생성하는 임시 상태 객체와 이벤트 디스패치 객체를 제거하고, TypedArray로 사전 할당된 레지스터 세트 위에서 연산합니다.
2. **GPU 드로우 콜 통합 (Batching)**:
   수만 개의 3D 선분과 삼각형 면을 한 프레임에 그릴 때, 수천 번의 개별 캔버스 컨텍스트 호출 대신 수십 킬로바이트의 단일 버텍스 버퍼로 묶어 WebGL에 전송합니다.
3. **불필요한 동기 렌더링 회피**:
   시뮬레이션 연산이 렌더 주기보다 빠른 경우, 중간 상태의 화면 그리기를 건너뛰고 오직 최종 물리 프레임만 GPU에 전달하여 CPU 자원을 절약합니다.

> [!NOTE]  
> 텍스트 중심의 단순한 퀴즈나 가벼운 스프라이트 1~2개로 구성된 정적 작품의 경우, 원본 엔트리 런타임과 Dorongi 간의 체감 성능 차이가 크지 않을 수 있습니다. Dorongi의 진가는 고밀도 연산 및 기하학적 렌더링이 집중된 고난도 작품에서 발휘됩니다.

---

## 6. 설치 및 사용 방법 (Installation & Usage)

Dorongi는 Chrome 웹스토어 외에도 GitHub 저장소에서 직접 다운로드하여 간편하게 설치할 수 있습니다.

### 6.1 일반 사용자 설치 (Chrome / Edge / Whale)

1. **저장소 다운로드**:
   - 본 저장소([GitHub: axolotl-rosi/Dorongi](https://github.com/axolotl-rosi/Dorongi)) 상단의 **`Code`** 초록색 버튼 클릭 → **`Download ZIP`**을 선택하여 파일을 다운로드합니다.
   - 다운로드한 ZIP 파일의 압축을 원하는 폴더에 풉니다.
2. **브라우저 확장 프로그램 페이지 접속**:
   - 크롬 주소창에 `chrome://extensions`를 입력하고 접속합니다. (웨일: `whale://extensions`, 엣지: `edge://extensions`)
3. **개발자 모드 활성화**:
   - 우측 상단의 **`개발자 모드 (Developer mode)`** 토글 스위치를 켭니다.
4. **확장 프로그램 로드**:
   - 좌측 상단의 **`압축해제된 확장 프로그램을 로드 (Load unpacked)`** 버튼을 클릭합니다.
   - 압축을 해제한 폴더(`manifest.json` 파일이 위치한 폴더)를 선택합니다.
5. **설치 완료**:
   - 확장 프로그램 목록에 **Dorongi**가 등록되면 즉시 사용 준비가 끝납니다!

> [!TIP]  
> 배포용 패키지에는 사전 컴파일된 `vendor/eniwanvm/` 엔진이 이미 포함되어 있으므로 `npm` 빌드나 별도의 개발 도구 설치가 필요하지 않습니다.

### 6.2 사용 방법

- **작품 감상 시**:
  - [playentry.org](https://playentry.org)의 작품 페이지를 방문하면 호환되는 작품의 경우 무대 영역이 Dorongi 고성능 캔버스로 자동 전환됩니다.
  - 표지 화면의 **▶ (재생)** 버튼을 누르면 EniwanVM 가상 머신에서 즉시 실행됩니다.
- **작품 제작 및 편집 시 (`/ws`)**:
  - 엔트리 편집기에서 블록을 수정 중인 상태에서도 Dorongi가 브라우저 메모리의 최신 코드를 즉시 감지하여 저장 없이 바로 테스트할 수 있습니다.
- **실시간 설정 및 모니터링**:
  - 브라우저 상단 도구 모음의 Dorongi 아이콘을 클릭하여 팝업을 열면 FPS, 렌더/로직 시간, 명령어 수가 실시간으로 표시됩니다.
  - 슬라이더 및 선택창을 통해 실행 중에도 실시간으로 화면 갱신율(Render Hz), 로직 속도(Logic Hz), 터보 배속을 조절할 수 있습니다.
- **원본 런타임 복귀**:
  - 하단 독(Dock)의 **"엔트리 원본으로"** 버튼을 누르면 언제든지 공식 엔트리 플레이어로 즉시 복원됩니다.

---

## 7. 보안 및 권한 설계 (Security & Isolation)

Dorongi는 사용자의 보안과 브라우저 무결성을 철저히 보호하도록 설계되었습니다:

1. **최소 권한 원칙 (Principle of Least Privilege)**:
   - 오직 사용자의 프레임레이트 및 배속 설정 저장을 위한 `storage` 권한과 대상 도메인(`https://playentry.org/*`)에 대한 실행 권한만을 요청합니다. 쿠키, 외부 네트워크, 북마크, 히스토리 등의 민감한 권한은 일체 요구하지 않습니다.
2. **격리 월드와 페이지 월드의 안전한 메시지 검증**:
   - 확장 프로그램 내부 통신(`content.js` ↔ `page/*.js`) 시 `event.source === window`와 `event.origin === location.origin`을 모두 검증하여 타사 악성 스크립트나 외부 샌드박스 프레임의 위조 메시지를 원천 차단합니다.
   - `chrome.runtime.onMessage` 핸들러는 `sender.id === chrome.runtime.id`를 대조하여 다른 확장 프로그램의 오인 호출을 차단합니다.
3. **입력 데이터 및 통계 살균 (Sanitization)**:
   - 팝업에서 전달되는 Hz 설정값은 엄격한 화이트리스트 검사를 거치며, 무한 루프나 비정상 수치 주입을 방지합니다.
   - 팝업으로 반환되는 모든 성능 지표는 `sanitizeStats`를 통해 유한한 숫자와 정제된 문자열로만 변환됩니다.
4. **동적 코드 생성(CSP) 안전장치**:
   - `eval`, `document.write`, 문자열 기반 `setTimeout`의 사용을 일체 배제합니다.
   - JIT 네이티브 티어(`structured-native.js`)는 사전 검증된 숫자 연산자만 조합하여 함수를 생성하며, 브라우저 CSP 제한으로 인해 생성이 거부될 경우 즉시 안전한 ISA 인터프리터로 자동 복귀합니다.

---

## 8. 라이선스 및 지식재산권 (License & Notices)

### 한국어 (Korean)

**Dorongi는 소스 공개형(Source-Available) 소프트웨어이며, OSI 기준의 오픈소스 소프트웨어가 아닙니다.**  
Dorongi의 독자적인 소스코드와 문서는 **Dorongi Source-Available License v1.0**의 적용을 받습니다. 라이선스 전문은 [`Dorongi_LICENSE_v1.0.txt`](Dorongi_LICENSE_v1.0.txt)에서 확인하실 수 있습니다.

- **무료 공식 이용**: 일반 사용자 및 교육자는 공식 배포된 Dorongi를 무료로 다운로드, 설치 및 실행할 수 있습니다.
- **콘텐츠 수익화 허용**: Dorongi를 도구로 사용하여 엔트리 작품을 실행, 플레이, 녹화, 스트리밍하거나 유튜브/방송 등에서 수익을 창출하는 행위는 전면 허용됩니다.
- **비공개 학습 및 연구**: 공개된 코드를 열람 및 분석하고, 개인적인 학습·연구·테스트를 위해 비공개로 수정 및 실험할 수 있습니다.
- **사전 서면 허가 필요**: Dorongi 자체 코드의 상업적 재사용, 무단 복제본 외부분포, 수정판/파생 버전의 대외 공개 및 배포는 저작권자의 사전 서면 허가가 필요합니다.
- **출처 및 명칭 보호**: 저작자 **Axolotl_rosi**와 프로젝트 명칭 **Dorongi**의 지식재산권이 보호됩니다. 공식 버전을 사칭하거나 무단 로고를 사용하는 행위는 금지됩니다.

- **저작권자**: Copyright (c) 2026 **Axolotl_rosi**
- **개발 그룹**: **Eniwan Studio** (개발팀의 명칭이며 별도의 법인 저작권자가 아님)

#### 제3자 자료 고지 (Third-Party Notices)
- 삼각함수 호환성 보정 테이블(`vendor/eniwanvm/vm-core.js`)은 **EntryJS** (Copyright 2015 Entry Labs, **Apache License 2.0**)의 일부 코드를 기반으로 합니다.
- 상세 고지는 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 및 [`licenses/entryjs/`](licenses/entryjs/) 디렉터리를 참고하십시오. 본 라이선스는 제3자 라이선스가 보장하는 독립적인 권리를 제한하지 않습니다.

---

## 9. English Overview

**Dorongi** is an Entry-compatible high-performance browser extension built by **Eniwan Studio** (Copyright (c) 2026 **Axolotl_rosi**).

Unlike conventional tools that simply adjust browser frame timers, Dorongi compiles Entry block projects Ahead-of-Time (AOT) into a custom 4-word register machine bytecode (**EniwanVM ISA**) and renders scenes through an allocation-free **WebGL dynamic batching pipeline**.

### Key Highlights
- **Decoupled Timing**: Independently configure logic simulation rates (Fixed Timestep) and display rendering refresh rates (up to 240 Hz / VSync).
- **Native JIT Tier**: Compiles pure recursive mathematical blocks into structured native JavaScript functions with graceful CSP fallback.
- **In-Memory Editor Integration**: Directly snapshots `/ws` editor models in memory, enabling instant preview of unsaved blocks.
- **Zero-Allocation Execution**: Employs flat TypedArray register pools to eliminate per-tick Garbage Collection (GC) stutters.
- **Safety Gate**: Verifies block and asset compatibility before launch, seamlessly falling back to native Entry iframe if unsupported blocks are encountered.

### Licensing Notice
Dorongi is released under the **Dorongi Source-Available License v1.0** (not an OSI-approved open-source license).
- **Free Use & Content Creation**: Free to install and run. Creating monetized YouTube videos, livestreams, or tutorials using Dorongi is fully permitted.
- **No Unauthorized Commercial Redistribution**: Commercial redistribution, public mirroring, or releasing modified derivative builds requires prior written authorization from Axolotl_rosi.
- **Third-Party Acknowledgement**: Contains trigonometric lookup components adapted from EntryJS under the Apache License 2.0. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

For complete technical specifications and compiler internals, please see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
