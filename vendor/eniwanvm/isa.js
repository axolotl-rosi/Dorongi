/* 이 파일은 public/eniwanvm/isa.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
/**
 * EniwanVM 3단계 — 명령어 세트(ISA).
 *
 * 컴파일러와 VM이 함께 쓰는 유일한 계약이다. 명령 하나는 Int32Array에 **4워드**
 * (op, a, b, c)로 들어간다 — 고정 폭이라 명령 경계를 계산할 필요가 없고,
 * 점프 대상이 그냥 배열 인덱스가 된다.
 *
 * 왜 레지스터 머신인가: 엔트리 엔진은 블록마다 실행 컨텍스트 객체를 만들어
 * (`script.callReturn()`) GC를 들볶는다. 여기서는 모든 상태가 미리 잡아 둔
 * TypedArray 안에 있어서 **한 틱에 객체를 하나도 만들지 않는다**.
 */

export const INSTR_WORDS = 4;

// ── 제어 ────────────────────────────────────────────────────────────────
export const OP_HALT = 0;        // 스레드 종료
export const OP_YIELD = 1;       // 이 틱 끝 — 다음 틱에 이 다음 명령부터
export const OP_JMP = 2;         // a=대상
export const OP_JZ = 3;          // a=조건reg b=대상 (거짓이면 점프)
export const OP_JNZ = 4;         // a=조건reg b=대상
export const OP_CALL = 5;        // a=함수idx b=인자시작reg c=반환받을reg
export const OP_RET = 6;         // a=반환값reg (없으면 -1)

// ── 값 이동 ─────────────────────────────────────────────────────────────
export const OP_CONST = 10;      // a=dst b=숫자상수idx
export const OP_CONSTSTR = 11;   // a=dst b=문자상수idx
export const OP_MOV = 12;        // a=dst b=src
export const OP_LOADVAR = 13;    // a=dst b=변수idx
export const OP_STOREVAR = 14;   // a=변수idx b=src
export const OP_ADDVAR = 15;     // a=변수idx b=src  (change_variable)
export const OP_LOADHOST = 16;   // a=dst b=호스트값idx (마우스·타이머 등)
export const OP_STOREHOST = 17;  // a=호스트값idx b=src — 렌더 상태(깊이 등)를 작품이 지정

// ── 산술 ────────────────────────────────────────────────────────────────
export const OP_ADD = 20;        // a=dst b=lhs c=rhs
export const OP_SUB = 21;
export const OP_MUL = 22;
export const OP_DIV = 23;
export const OP_MOD = 24;
export const OP_QUOT = 25;       // 몫(내림)
export const OP_UNARY = 26;      // a=dst b=src c=UN_* 함수idx
export const OP_ATAN2 = 27;      // a=dst b=y c=x
export const OP_RAND = 28;       // a=dst b=lo c=hi
export const OP_CONCAT = 29;     // a=dst b=lhs c=rhs (문자 붙이기)

// ── 비교·논리 ───────────────────────────────────────────────────────────
export const OP_LT = 30;
export const OP_GT = 31;
export const OP_EQ = 32;
export const OP_NE = 33;
export const OP_LE = 34;
export const OP_GE = 35;
export const OP_AND = 36;
export const OP_OR = 37;
export const OP_NOT = 38;        // a=dst b=src

// ── 리스트 ──────────────────────────────────────────────────────────────
export const OP_LISTGET = 40;    // a=dst b=리스트idx c=인덱스reg (1-base)
export const OP_LISTSET = 41;    // a=리스트idx b=인덱스reg c=src
export const OP_LISTLEN = 42;    // a=dst b=리스트idx
export const OP_LISTPUSH = 43;   // a=리스트idx b=src
export const OP_LISTINS = 44;    // a=리스트idx b=인덱스reg c=src
export const OP_LISTDEL = 45;    // a=리스트idx b=인덱스reg
export const OP_LISTCLEAR = 46;  // a=리스트idx

// ── 그리기 ──────────────────────────────────────────────────────────────
// 펜 상태는 VM이 들고, 실제 버텍스는 sink로 내보낸다. sink가 PolygonBatcher든
// 테스트용 기록기든 VM은 모른다 — 그래서 GPU 없이도 그림을 검증할 수 있다.
export const OP_PENDOWN = 50;
export const OP_PENUP = 51;
// 엔진에서 선(`sprite.brush`)과 채우기(`sprite.paint`)는 **서로 다른 객체**이고
// 색·투명도를 따로 들고 있다. 하나로 합치면 set_fill_color 한 번이 선 색까지
// 바꿔 버린다 — 그림이 "돌긴 도는데 틀린" 쪽으로 간다.
export const OP_SETCOLOR = 52;      // a=문자상수idx (선)
export const OP_SETCOLORREG = 53;   // a=src (색이 변수/인자로 올 때)
export const OP_SETTHICK = 54;      // a=src — 절대값
export const OP_LOCATEXY = 55;      // a=x reg b=y reg — 펜이 내려와 있으면 선을 긋는다
export const OP_MOVEXY = 56;        // a=dx reg b=dy reg
export const OP_FILLBEGIN = 57;
export const OP_FILLEND = 58;
export const OP_STAMP = 59;
export const OP_ERASEALL = 60;
export const OP_SETALPHA = 61;      // a=src — 붓 투명도(0=불투명 … 100=투명)
export const OP_ADDALPHA = 62;      // a=src — 투명도 상대 변경(선+채우기 둘 다)
export const OP_TEXTWRITE = 63;     // a=src b=오브젝트idx
export const OP_LOADKEY = 64;       // a=dst b=키코드 — 그 키가 눌렸는가
export const OP_SETFILLCOLOR = 65;    // a=문자상수idx (채우기)
export const OP_SETFILLCOLORREG = 66; // a=src
export const OP_ADDTHICK = 67;        // a=src — 상대 변경, 최소 1로 클램프

// ── 오브젝트·복제본 ─────────────────────────────────────────────────────
// 여기부터는 "무대에 오브젝트가 여럿 있고, 각자 좌표·방향·크기·모양·효과를
// 들고 있다"는 모델이 필요하다. 그 상태는 VM이 엔티티 표(원본 + 복제본 풀)로
// 들고 있고, 명령은 **지금 돌고 있는 스레드의 엔티티**에 적용된다 —
// 그래서 같은 코드가 원본에서도 복제본에서도 그대로 돈다.
export const OP_SETXY = 70;        // a=x reg b=y reg (펜이 내려와 있으면 선도 따라간다)
export const OP_SETENTX = 71;      // a=src
export const OP_SETENTY = 72;      // a=src
export const OP_MOVEDIR = 73;      // a=src — 이동 방향(회전+방향)으로 전진
export const OP_SETROT = 74;       // a=src 절대 회전
export const OP_ADDROT = 75;       // a=src 상대 회전
export const OP_SETDIR = 76;       // a=src 절대 이동방향
export const OP_ADDDIR = 77;       // a=src 상대
export const OP_SETSIZE = 78;      // a=src — 엔트리 size(픽셀 평균)
export const OP_ADDSIZE = 79;
export const OP_SETVISIBLE = 80;   // a=0/1 상수
export const OP_SETEFFECT = 81;    // a=EF_* b=src (절대)
export const OP_ADDEFFECT = 82;    // a=EF_* b=src (상대)
export const OP_SETSHAPE = 83;     // a=모양idx(상수) — 음수면 b=src에서 이름/번호로 찾는다
export const OP_NEXTSHAPE = 84;    // a=+1(다음)/-1(이전)
export const OP_LOADENT = 85;      // a=dst b=ENT_* c=오브젝트idx(-1=나)
export const OP_CLONE = 86;        // a=오브젝트idx(-1=나, 자기 상태를 복사)
export const OP_DELETECLONE = 87;  // 복제본이면 지우고 스레드 종료, 원본이면 아무 일 없음
export const OP_CLEARCLONES = 88;  // a=오브젝트idx(-1=나) — 그 오브젝트의 복제본 전부
export const OP_SLEEP = 89;        // a=src (초) — 이 스레드만 그만큼 잔다
// 소리 블록은 10가지(`~재생하기`/`~초 재생하기`/`~부터 ~초까지`/각각의 기다리기
// 판)지만 다루는 값은 셋뿐이다 — 그래서 **연속한 레지스터 세 칸**(b, b+1, b+2)에
// 모아 넘기고 c에 어떤 칸이 의미 있는지를 비트로 적는다.
export const OP_PLAYSOUND = 90;    // a=소리idx(상수, 음수면 b=src로 찾는다) b=묶음 c=SND_*
export const SND_WAIT = 1;         // 끝날 때까지 이 스레드가 기다린다
export const SND_SECOND = 2;       // b+1 = 재생할 초
export const SND_FROMTO = 4;       // b+1 = 시작 초, b+2 = 끝 초
export const OP_STOPSOUND = 91;    // a=0 모든 소리 / 1 이 오브젝트의 소리만
export const OP_VOLUME = 92;       // a=src b=0 절대 / 1 상대
export const OP_BROADCAST = 93;    // a=메시지idx — 그 신호를 받는 스레드를 깨운다
export const OP_INLIST = 94;       // a=dst b=리스트idx c=src — 포함되어 있는가
export const OP_CHARAT = 95;       // a=dst b=문자src c=인덱스src(1-base)
export const OP_STRLEN = 96;       // a=dst b=src
export const OP_STRIDX = 97;       // a=dst b=전체src c=찾을src (1-base, 없으면 0)
// 인자가 셋인 문자 블록은 **연속한 레지스터**를 쓴다(b, b+1, b+2).
// c에 두 번째 인자 번호를 또 싣는 것보다 컴파일러가 붙여 잡는 게 싸다.
export const OP_SUBSTR = 98;       // a=dst b=src(문자, b+1=시작, b+2=끝)
export const OP_REPLACE = 99;      // a=dst b=src(문자, b+1=찾을 것, b+2=바꿀 것)
export const OP_STRCASE = 100;     // a=dst b=src c=0 소문자 / 1 대문자
export const OP_STRREV = 101;      // a=dst b=src
// 엔진의 `flip_x`는 **scaleY**를, `flip_y`는 scaleX를 뒤집는다(이름과 축이
// 반대다). 이름만 보고 맞추면 좌우 뒤집기가 상하로 나온다.
export const OP_FLIP = 102;        // a=0 좌우(scaleY) / 1 상하(scaleX)
// 함수 지역변수 **읽기**. 쓰기는 평범한 OP_MOV다 — 지역변수는 프레임 안의
// 레지스터라서 옮기는 것 말고 할 일이 없다. 읽기에만 전용 명령이 있는 이유는
// 엔진이 `localVariable?.value || 0`로 읽기 때문이다(빈 문자열·NaN → **숫자 0**).
// 쓰는 쪽에서 미리 보정하면 "넣은 값과 다른 값이 들어 있는" 프레임이 되고,
// 나중에 지역변수를 들여다보는 디버거가 거짓을 보게 된다.
export const OP_LOADLOCAL = 103;   // a=dst b=지역변수 레지스터

// ── 무대·장면·대화·질문 ────────────────────────────────────────────────
// "못 하는 블록만 엔트리에 맡기면" 결국 느린 엔진 속도로 떨어진다. 그래서
// 미지원으로 남아 있던 블록들을 VM 안에서 직접 구현한다.
export const OP_DATE = 104;        // a=dst b=DATE_* — 지금 시각
export const OP_TIMERACT = 105;    // a=TIMER_* — 초시계 시작/정지/초기화
export const OP_SETINDEX = 106;    // a=ZORDER_* — 그리는 순서(맨 앞/뒤/앞으로/뒤로)
// a, a+1, a+2 = x, y, 초. 여러 틱에 걸쳐 움직이므로 줄(스레드) 상태를 쓴다.
export const OP_GLIDEXY = 107;
export const OP_DIALOG = 108;      // a=말풍선 문자src b=DIALOG_* (REMOVE면 a 무시)
// a=물어볼 말 src. 대답이 들어올 때까지 **그 줄만** 멈춘다(다른 줄은 계속 돈다).
export const OP_ASK = 109;
export const OP_STARTSCENE = 110;  // a=장면 인덱스

// ── 데이터 테이블 ──────────────────────────────────────────────────────
// Entry.DataTable을 호출하지 않고 VM이 fields/rows를 직접 소유한다.
export const OP_TABLECOUNT = 111;  // a=dst b=table c=0 ROW / 1 COL
export const OP_TABLEGET = 112;    // a=dst b=table c=args(row, col)
export const OP_TABLESET = 113;    // a=table b=args(row, col, value)
export const OP_TABLEAPPEND = 114; // a=table b=0 ROW / 1 COL
export const OP_TABLEINSERT = 115; // a=table b=indexReg c=0 ROW / 1 COL
export const OP_TABLEDELETE = 116; // a=table b=indexReg c=0 ROW / 1 COL
export const OP_TABLECALC = 117;   // a=dst b=table c=args(col, calc-name)
export const OP_TABLECELLGET = 118; // a=dst b=table c=cellReg (A1)
export const OP_TABLECELLSET = 119; // a=table b=args(cell, value)
export const OP_SOUNDSTATE = 120; // a=dst b=0 volume / 1 playback rate
export const OP_SPEED = 121;      // a=src b=0 set / 1 add
export const OP_TEXTREAD = 122;   // a=dst b=object
export const OP_TEXTMUTATE = 123; // a=object b=src c=0 append / 1 prepend / 2 flush
export const OP_TEXTSTYLE = 124;  // a=object b=args(value, mode) c=style kind
export const OP_STOP = 125;       // a=stop target mode
export const OP_RESTART = 126;    // 다음 논리 tick부터 작품 초기 상태로 재시작
export const OP_STRETCH = 127;    // a=0 width / 1 height, b=delta percent
export const OP_RESETSCALE = 128; // 처음 x/y 배율 복원
export const OP_RANDOMCOLOR = 129;
export const OP_RGBHEX = 130;     // a=dst b=args(r, g, b) — "#rrggbb" 문자
export const OP_HEXRGB = 131;     // a=dst b=hex src c=0 r / 1 g / 2 b
export const OP_SETVARVISIBLE = 132; // a=slot b=0 variable/1 list c=0 hide/1 show
export const OP_STRCOUNT = 133;    // a=dst b=문자열 c=찾을 문자열
export const OP_ISTYPE = 134;      // a=dst b=src c=0 number/1 English/2 Korean
export const OP_DISTANCE = 135;    // a=dst b=대상 object(-1=mouse)
export const OP_MOVEANGLE = 136;   // a=angle reg b=distance reg
export const OP_BOUNCE = 137;      // 무대 경계에서 이동 방향 반사
export const OP_TURNTIME = 138;    // a=args(duration, amount) b=0 rotation/1 direction

// 함수 지역값 두 개를 읽고 숫자 연산하는 자주 나오는 명령열.
// LOADLOCAL + LOADLOCAL + OP의 Entry `value || 0` 의미를 그대로 유지한다.
export const OP_SUB_LL = 139;
export const OP_MUL_LL = 140;
export const OP_DIV_LL = 141;
export const OP_MOD_LL = 142;
export const OP_QUOT_LL = 143;
export const OP_LT_LL = 144;
export const OP_GT_LL = 145;
export const OP_LE_LL = 146;
export const OP_GE_LL = 147;
export const OP_LISTGET_L = 148;
export const OP_LISTSET_LL = 149;
export const OP_TOUCHING = 150;       // a=dst b=target object(-1 mouse, -2 wall)

// OP_DATE 필드 번호. 엔진 `get_date`와 같은 순서·같은 보정이다
// (월은 +1, **요일은 0~6 그대로** — 엔진이 `getDay()`를 보정 없이 돌려준다).
export const DATE_YEAR = 0;
export const DATE_MONTH = 1;
export const DATE_DAY = 2;
export const DATE_HOUR = 3;
export const DATE_MINUTE = 4;
export const DATE_SECOND = 5;
export const DATE_DAY_OF_WEEK = 6;

// OP_TIMERACT 동작 번호
export const TIMER_START = 0;
export const TIMER_STOP = 1;
export const TIMER_RESET = 2;

// OP_SETINDEX 위치 번호 (엔진 `change_object_index`의 드롭다운)
export const ZORDER_FRONT = 0;
export const ZORDER_FORWARD = 1;
export const ZORDER_BACKWARD = 2;
export const ZORDER_BACK = 3;

// OP_DIALOG 종류
export const DIALOG_SPEAK = 0;
export const DIALOG_THINK = 1;
export const DIALOG_REMOVE = 2;

// 효과 번호 (OP_SETEFFECT / OP_ADDEFFECT)
export const EF_COLOR = 0;         // 엔진의 effect.hsv
export const EF_BRIGHTNESS = 1;
export const EF_TRANSPARENCY = 2;  // 엔진은 alpha=1-값/100으로 들고 있다

// 엔티티 속성 번호 (OP_LOADENT)
export const ENT_X = 0;
export const ENT_Y = 1;
export const ENT_ROTATION = 2;
export const ENT_DIRECTION = 3;
export const ENT_SIZE = 4;
export const ENT_PICTURE_INDEX = 5;
export const ENT_PICTURE_NAME = 6;   // **문자**를 돌려준다
export const ENT_VISIBLE = 7;

// UNARY 함수 번호
export const UN_NEG = 0;
export const UN_ABS = 1;
export const UN_FLOOR = 2;
export const UN_CEIL = 3;
export const UN_ROUND = 4;
export const UN_SQRT = 5;
export const UN_SIN = 6;
export const UN_COS = 7;
export const UN_TAN = 8;
export const UN_ASIN = 9;
export const UN_ACOS = 10;
export const UN_ATAN = 11;
export const UN_LN = 12;
export const UN_LOG = 13;
export const UN_SQUARE = 14;        // calc_operation 'square'
export const UN_FACTORIAL = 15;     // calc_operation 'factorial'
// 엔트리의 'unnatural'은 **부호 반전이 아니라 소수부**다(entry.js calc_operation:
// `value - floor(value)`, 음수면 `1 - frac`). 이름만 보고 음수화로 적으면
// 좌표가 전부 틀어진다.
export const UN_FRAC = 16;

// 호스트 값 번호 (OP_LOADHOST / OP_STOREHOST)
export const HOST_MOUSE_X = 0;
export const HOST_MOUSE_Y = 1;
export const HOST_MOUSE_DOWN = 2;
export const HOST_TIMER = 3;
export const HOST_TICK = 4;
// ── 아래는 엔트리 블록에 대응 블록이 없는 EniwanVM 확장 입력이다.
//    1인칭 마우스룩에는 "커서가 화면 어디에 있는가"(MOUSE_X/Y)가 아니라
//    "지난 틱 이후 얼마나 움직였는가"가 필요하다. 커서 좌표만 있으면 화면
//    가장자리에서 회전이 멈춘다 — 그래서 포인터 락 + 상대 델타가 따로 있다.
export const HOST_MOUSE_DX = 5;
export const HOST_MOUSE_DY = 6;
export const HOST_WHEEL = 7;
export const HOST_POINTER_LOCKED = 8;
// ── 렌더 상태(작품이 쓴다, OP_STOREHOST)
export const HOST_DEPTH = 9;        // 다음에 그릴 도형들의 깊이(작을수록 앞)
export const HOST_DEPTH_TEST = 10;  // 0이 아니면 깊이 검사 on
// ── 브라우저가 가진 것 중 엔트리에 블록이 없는 것들.
//    엔트리에서 돌리면 전부 "값이 0인 보통 변수"로 남으므로 작품은 깨지지 않고,
//    기능만 빠진다. `HOST_IS_ENIWAN`을 물어 보고 분기하면 된다.
export const HOST_IS_ENIWAN = 11;   // 이 런타임에서만 1. 엔트리에서는 0
export const HOST_SCROLL_X = 12;    // 휠 가로 누적. 읽으면 소비
export const HOST_CLIPBOARD = 13;   // **문자** 슬롯. 읽기=붙여넣은 것, 쓰기=복사 요청
export const HOST_CURSOR = 14;      // **문자** 슬롯. 무대 커서 모양(css 키워드)
// ── 아래 둘은 엔트리 블록이 **있는** 기능이다(묻고 기다리기 / 대답).
// 질문은 호스트가 입력창을 띄워야 하므로 쓰기 요청으로 나가고, 대답은
// 호스트가 넣어 준다. 둘 다 문자다.
export const HOST_ASK = 15;         // **문자** 슬롯. 작품이 물어본 말(쓰기=입력창 요청)
export const HOST_ANSWER = 16;      // **문자** 슬롯. 호스트가 넣어 주는 대답
// 로그인한 사람의 이름(엔진 `get_nickname`은 `window.user.nickname`을 읽는다).
// 호스트가 **시작할 때 한 번** 받아 넣는다 — 블록이 돌 때마다 서버에 물어보면
// 작품 한 번에 수천 번 요청이 나간다.
export const HOST_NICKNAME = 17;    // **문자** 슬롯

export const HOST_BOOST_MODE = 18;
export const HOST_DEVICE_TYPE = 19; // 0 desktop / 1 tablet / 2 mobile
export const HOST_TOUCH_SUPPORTED = 20;
// TessVM 호환 프로필에서만 1. Dorongi 식별은 HOST_IS_ENIWAN이 담당한다.
export const HOST_IS_TESSVM = 21;
export const HOST_SLOTS = 22;

/**
 * **숫자가 아니라 문자**를 담는 슬롯.
 *
 * `host`는 Float64Array라서 클립보드·커서 같은 값을 담을 수 없다. 그 둘만
 * 따로 `hostStr`에 두고, 이 마스크로 어느 쪽을 읽고 쓸지 가른다 —
 * 마스크를 안 두고 슬롯 번호를 직접 비교하면 새 문자 슬롯을 더할 때마다
 * VM 본문의 분기를 고쳐야 한다.
 */
export const HOST_IS_STRING = (() => {
    const mask = new Uint8Array(HOST_SLOTS);
    mask[HOST_CLIPBOARD] = 1;
    mask[HOST_CURSOR] = 1;
    mask[HOST_ASK] = 1;
    mask[HOST_ANSWER] = 1;
    mask[HOST_NICKNAME] = 1;
    return mask;
})();

/**
 * 작품이 쓰면 **호스트가 뭔가 해 줘야 하는** 슬롯 → 그 일의 이름.
 *
 * 값이 바뀌었는가가 아니라 **썼는가**가 기준이다. 같은 글자를 클립보드에 두 번
 * 쓰는 것은 두 번 복사해 달라는 뜻이고, 같은 1을 마우스 락에 두 번 쓰는 것은
 * (사용자가 Esc로 풀었을 수 있으니) 다시 잠가 달라는 뜻이다.
 */
export const HOST_WRITE_ACTIONS = (() => {
    const actions = [];
    actions[HOST_CLIPBOARD] = 'clipboard';
    actions[HOST_CURSOR] = 'cursor';
    actions[HOST_POINTER_LOCKED] = 'mouseLock';
    // 묻고 기다리기 — 호스트가 무대에 입력창을 띄우고 `answer()`로 되돌려 준다.
    actions[HOST_ASK] = 'ask';
    return actions;
})();

/**
 * **읽으면 0으로 비워지는** 슬롯. 델타는 누적량이므로 한 번만 소비돼야 한다.
 *
 * 왜 필요한가: 로직 틱과 렌더 프레임이 분리돼 있어서 한 프레임에 틱이 두 번
 * 돌 수 있다. 그때 두 틱이 같은 델타를 읽으면 회전이 정확히 두 배가 된다
 * ("돌긴 도는데 틀린" 쪽이다). 첫 읽기가 가져가고 나머지는 0을 본다.
 */
export const HOST_CONSUME_ON_READ = (() => {
    const mask = new Uint8Array(HOST_SLOTS);
    mask[HOST_MOUSE_DX] = 1;
    mask[HOST_MOUSE_DY] = 1;
    mask[HOST_WHEEL] = 1;
    mask[HOST_SCROLL_X] = 1;
    return mask;
})();

/** 디버깅·대시보드용 이름표. 숫자만 보이는 역어셈블은 읽을 수 없다. */
export const OP_NAMES = (() => {
    const names = {};
    for (const [k, v] of Object.entries({
        OP_HALT, OP_YIELD, OP_JMP, OP_JZ, OP_JNZ, OP_CALL, OP_RET,
        OP_CONST, OP_CONSTSTR, OP_MOV, OP_LOADVAR, OP_STOREVAR, OP_ADDVAR,
        OP_LOADHOST, OP_STOREHOST,
        OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MOD, OP_QUOT, OP_UNARY, OP_ATAN2, OP_RAND, OP_CONCAT,
        OP_LT, OP_GT, OP_EQ, OP_NE, OP_LE, OP_GE, OP_AND, OP_OR, OP_NOT,
        OP_LISTGET, OP_LISTSET, OP_LISTLEN, OP_LISTPUSH, OP_LISTINS, OP_LISTDEL, OP_LISTCLEAR,
        OP_PENDOWN, OP_PENUP, OP_SETCOLOR, OP_SETCOLORREG, OP_SETTHICK,
        OP_LOCATEXY, OP_MOVEXY, OP_FILLBEGIN, OP_FILLEND, OP_STAMP, OP_ERASEALL,
        OP_SETALPHA, OP_ADDALPHA, OP_TEXTWRITE, OP_LOADKEY,
        OP_SETFILLCOLOR, OP_SETFILLCOLORREG, OP_ADDTHICK,
        OP_SETXY, OP_SETENTX, OP_SETENTY, OP_MOVEDIR,
        OP_SETROT, OP_ADDROT, OP_SETDIR, OP_ADDDIR, OP_SETSIZE, OP_ADDSIZE,
        OP_SETVISIBLE, OP_SETEFFECT, OP_ADDEFFECT, OP_SETSHAPE, OP_NEXTSHAPE,
        OP_LOADENT, OP_CLONE, OP_DELETECLONE, OP_CLEARCLONES, OP_SLEEP,
        OP_PLAYSOUND, OP_STOPSOUND, OP_VOLUME, OP_BROADCAST,
        OP_INLIST, OP_CHARAT, OP_STRLEN, OP_STRIDX, OP_SUBSTR, OP_REPLACE,
        OP_STRCASE, OP_STRREV, OP_FLIP, OP_LOADLOCAL,
        OP_DATE, OP_TIMERACT, OP_SETINDEX, OP_GLIDEXY, OP_DIALOG, OP_ASK, OP_STARTSCENE,
        OP_TABLECOUNT, OP_TABLEGET, OP_TABLESET, OP_TABLEAPPEND,
        OP_TABLEINSERT, OP_TABLEDELETE, OP_TABLECALC, OP_TABLECELLGET, OP_TABLECELLSET,
        OP_SOUNDSTATE, OP_SPEED,
        OP_TEXTREAD, OP_TEXTMUTATE, OP_TEXTSTYLE,
        OP_STOP, OP_RESTART,
        OP_STRETCH, OP_RESETSCALE, OP_RANDOMCOLOR, OP_RGBHEX, OP_HEXRGB,
        OP_SETVARVISIBLE, OP_STRCOUNT, OP_ISTYPE, OP_DISTANCE,
    OP_MOVEANGLE, OP_BOUNCE, OP_TURNTIME,
    OP_SUB_LL, OP_MUL_LL, OP_DIV_LL, OP_MOD_LL, OP_QUOT_LL,
        OP_LT_LL, OP_GT_LL, OP_LE_LL, OP_GE_LL, OP_LISTGET_L, OP_LISTSET_LL,
    OP_TOUCHING,
    })) names[v] = k.slice(3);
    return names;
})();
