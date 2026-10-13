# Dorongi — 크롬 확장

playentry.org 작품 페이지와 편집기에서 **엔트리 런타임 대신 Dorongi로 돌린다.**
편집기에서는 현재 메모리에 열린 프로젝트 JSON을 바로 읽으므로 저장하지 않은 변경도
그대로 실행한다.

## 설치

```bash
npm run build:extension       # public/eniwanvm/ → extension/vendor/, 아이콘 생성
npm run verify:extension      # 파일·사본·관문·에셋·닉네임 정적 점검 42개
npm run verify:extension:current # /ws의 현재 프로젝트를 읽고 GraphQL을 생략하는 실제 크롬 점검
npm run verify:extension:e2e  # 실제 크롬에 올려서 20개 (창이 잠깐 뜹니다)
```

크롬 → `chrome://extensions` → **개발자 모드** 켜기 → **압축해제된 확장 프로그램을 로드**
→ 이 `extension/` 폴더.

## 쓰는 법

- playentry.org 작품 페이지를 연다. 돌릴 수 있는 작품이면 무대 자리가 Dorongi 실행기로
  바뀐다. 표지의 **▶** 를 누르면 시작한다.
- 편집기(`/ws`)에서는 현재 Entry 모델을 직접 직렬화한다. 서버에 마지막으로 저장된 작품을
  다시 받지 않으므로 편집 중인 블록·변수·리스트·테이블·장면이 실행 대상이다.
- 브라우저 도구 모음의 아이콘을 누르면 팝업이 열린다. 위쪽은 **지금 돌고 있는 작품의
  실측값**(FPS·프레임/로직/렌더 시간·티어·명령어 수), 아래쪽은 렌더 Hz·로직 Hz·터보
  설정이다. 설정은 돌고 있는 작품에 바로 먹는다.
- 실행기 아래 독에서 일시정지·재시작·전체화면, 그리고 **"엔트리 원본으로"** 로 언제든
  되돌아갈 수 있다.

## 못 돌리는 작품은 원본으로 돌려보낸다

Dorongi에는 변수·리스트·연산·제어·펜·도형·글상자·키/마우스·소리·복제본·**모양(스프라이트)
그림·장면·대화·대답·초시계·닉네임**까지 있다. 그래도 못 돌릴 작품은 있으므로, 얹기 전에
`page/gate.js`가 컴파일러와 분석기의 **실제 산출물**을 보고 판정한다:

| 코드 | 뜻 |
|---|---|
| `no-draw` | 펜·도형도, 받을 수 있는 모양도 하나도 없다 |
| `local-picture` | 받을 수 없는 모양이 있다 — 엔트리에 올라간 적 없는 그림 |
| `unsupported` | 컴파일러가 못 옮긴 블록이 있다 (팝업에서 강행 가능) |
| `no-thread` | 실행할 시작 블록이 없다 |

모양은 엔트리 서버 주소(`/uploads/…`)로 미리 받아 둔다. 받을 수 없는 모양이 하나라도
있으면 `local-picture`로 물러난다 — 등장인물만 빠진 무대도 빈 무대다.

판정이 `run: false`면 원래 엔트리 iframe을 그대로 되살리고 이유를 띠로 알린다.
빈 무대는 느린 것보다 나쁘기 때문이다.

## 구조

```
manifest.json      MV3. playentry.org만, storage 권한만.
content.js         격리 월드. 무대 자리를 찾아 호스트를 심고, 설정을 전달하고,
                   폴백 요청이 오면 원본 iframe을 되살린다.
page/main.js       페이지 월드 진입점. 호스트를 훑어 실행기를 올린다.
page/current-project.js  편집 중인 Entry 모델을 부작용 없이 project JSON으로 복사한다.
page/gate.js       호환성 판정 — 순수 함수라 Node에서 그대로 테스트된다.
page/player.js     표지·HUD·독·입력·글상자 그리기.
page/entry-project.js  작품 id → GraphQL로 project.json(+장면 목록).
page/entry-user.js 닉네임 블록을 쓰는 작품에만, 시작 전 한 번 GraphQL로 닉네임.
popup/             실측값 + 설정.
vendor/eniwanvm/    public/eniwanvm/의 기계 사본 — 직접 고치지 말 것.
```

`vendor/`는 `tools/build-extension.mjs`가 찍어 낸다. 원본은 `public/eniwanvm/` 한 곳이고,
사본이 뒤처지면 `npm run verify:extension`이 잡아낸다.

## 실행기는 자리가 아니라 작품에 묶인다

playentry의 뷰 코드는 클릭 한 번에도 무대를 통째로 다시 그린다. 그때 자리(DOM 노드)는
새것이 되지만 작품은 그대로다. **자리를 기준으로 세면 다시 그릴 때마다 실행기를 새로
올리게 되고, 작품이 처음부터 다시 불러와진다** — 표지가 안 넘어가고, 누를 때마다 첫
로드가 반복되고, 실행기가 쌓인다. 그래서:

- `page/main.js`는 실행기를 **작품 id로** 센다. 자리가 바뀌면 `player.attach(host)`로
  같은 실행기를 옮겨 심는다(캔버스는 옮겨도 WebGL 컨텍스트를 잃지 않는다).
- `content.js`는 자리 노드를 **한 번만 만들어** 계속 재사용하고, iframe이 새 노드로
  바뀌면 항목의 프레임만 갈아 끼운다.
- `page/player.js`는 우리 콘솔의 이벤트가 페이지로 올라가지 않게 루트에서 막는다.
  (`pointerup`만 예외 — 무대 밖에서 손을 떼는 걸 window에서 받아야 한다.)

`npm run verify:extension:e2e`가 이 세 가지를 실제 크롬에서 지킨다.

## 페이지에서 오는 것은 전부 의심한다

확장은 페이지보다 센 권한으로 돈다. 그래서 **페이지가 우리에게 말을 걸 수 있는 통로**
마다 보낸 쪽과 값의 모양을 확인한다. `page/*.js`는 페이지 월드에 올라가므로, 거기 도착한
메시지가 우리 팝업에서 온 것인지 그 페이지의 다른 스크립트가 넣은 것인지 **구분할 방법이
없다**는 전제로 쓰였다.

- **메시지**: `postMessage` 수신부는 `event.source === window`와 `event.origin ===
  location.origin`을 **둘 다** 본다. 앞의 것만 보면 같은 창의 다른 출처(샌드박스 프레임
  등)가 통과한다.
- **확장 내부 메시지**: `runtime.onMessage`는 `sender.id === runtime.id`를 확인한다 —
  웹페이지나 다른 확장도 우리 id로 `runtime.sendMessage`를 할 수 있다.
- **설정값**: 화면에 실제로 있는 선택지(`RENDER_HZ`/`LOGIC_HZ`/`TURBO`) 안에 드는
  숫자만 받는다. `Number(x) || 기본값`은 `logicHz: 1e9`를 통과시켜 탭을 멈춘다.
- **실측값**: 페이지가 답한 값은 `content.js`의 `sanitizeStats`에서 유한한 숫자와 길이를
  자른 글자로만 바뀐 뒤 팝업에 간다(팝업은 받은 값을 바로 `toFixed`에 넣는다).
- **동적 컴파일 경계가 한 곳이다**: Dorongi 네이티브 티어만 검증된 ISA operand와
  JSON 인코딩 상수로 JS 함수를 만든다. 작품의 식별자나 임의 문자열을 JS 문법으로
  복사하지 않는다. CSP가 함수 생성을 막으면 ISA 실행으로 자동 복귀한다. 나머지
  모듈에서는 `eval`·`Function`·`document.write`·문자열 `setTimeout`을 금지한다.

`npm run verify:extension`의 "경계" 절이 이 항목들을 지킨다 — 한 줄 지우면 깨진다.
