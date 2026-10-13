/* 이 파일은 public/eniwanvm/compiler.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
/**
 * EniwanVM 3단계 — AOT 컴파일러. 엔트리 블록 트리 → ISA 명령 스트림.
 *
 * 서버가 `.ent`를 받은 순간 여기까지 끝내 두면 브라우저는 Int32Array 하나를
 * 넘겨받아 바로 돌린다(콜드 스타트에 해석 비용이 없다).
 *
 * **지원하지 않는 블록은 조용히 넘기지 않는다.** `program.unsupported`에
 * 타입별 개수로 쌓아 보고한다 — 모르는 블록을 no-op으로 삼키면 작품이 "돌긴 도는데
 * 틀린" 상태가 되고, 그건 느린 것보다 나쁘다. 호출자는 이 목록을 보고
 * 기존 엔진으로 되돌릴지 결정한다.
 */

import {
    INSTR_WORDS,
    OP_HALT, OP_YIELD, OP_JMP, OP_JZ, OP_JNZ, OP_CALL, OP_RET,
    OP_CONST, OP_CONSTSTR, OP_MOV, OP_LOADVAR, OP_STOREVAR, OP_ADDVAR, OP_LOADHOST,
    OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MOD, OP_QUOT, OP_UNARY, OP_RAND, OP_CONCAT,
    OP_LT, OP_GT, OP_EQ, OP_NE, OP_LE, OP_GE, OP_AND, OP_OR, OP_NOT,
    OP_LISTGET, OP_LISTSET, OP_LISTLEN, OP_LISTPUSH, OP_LISTINS, OP_LISTDEL,
    OP_PENDOWN, OP_PENUP, OP_SETCOLOR, OP_SETCOLORREG, OP_SETTHICK,
    OP_LOCATEXY, OP_MOVEXY, OP_FILLBEGIN, OP_FILLEND, OP_STAMP, OP_ERASEALL,
    OP_SETALPHA, OP_ADDALPHA, OP_TEXTWRITE, OP_LOADKEY,
    OP_SETFILLCOLOR, OP_SETFILLCOLORREG, OP_ADDTHICK,
    UN_NEG, UN_ABS, UN_FLOOR, UN_CEIL, UN_ROUND, UN_SQRT,
    UN_SIN, UN_COS, UN_TAN, UN_ASIN, UN_ACOS, UN_ATAN, UN_LN, UN_LOG,
    UN_SQUARE, UN_FACTORIAL, UN_FRAC,
    OP_STOREHOST,
    HOST_MOUSE_X, HOST_MOUSE_Y, HOST_MOUSE_DOWN, HOST_TIMER,
    HOST_MOUSE_DX, HOST_MOUSE_DY, HOST_WHEEL, HOST_POINTER_LOCKED,
    HOST_DEPTH, HOST_DEPTH_TEST,
    HOST_IS_ENIWAN, HOST_IS_TESSVM, HOST_SCROLL_X, HOST_CLIPBOARD, HOST_CURSOR,
    OP_SETENTX, OP_SETENTY, OP_MOVEDIR, OP_SETROT, OP_ADDROT, OP_SETDIR, OP_ADDDIR,
    OP_SETSIZE, OP_ADDSIZE, OP_SETVISIBLE, OP_SETEFFECT, OP_ADDEFFECT,
    OP_SETSHAPE, OP_NEXTSHAPE, OP_LOADENT,
    OP_CLONE, OP_DELETECLONE, OP_CLEARCLONES, OP_SLEEP,
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
    OP_SETVARVISIBLE, OP_STRCOUNT, OP_ISTYPE, OP_DISTANCE, OP_TOUCHING,
    OP_MOVEANGLE, OP_BOUNCE, OP_TURNTIME,
    OP_TABLECOEFF, OP_TABLELOOKUP, OP_OBJECTCLICKED, OP_POINTTO,
    OP_BGM, OP_STOPBGM, OP_BROADCASTWAIT, OP_NEIGHBORSCENE, OP_TABLEVISIBLE,
    OP_SUB_LL, OP_MUL_LL, OP_DIV_LL, OP_MOD_LL, OP_QUOT_LL,
    OP_LT_LL, OP_GT_LL, OP_LE_LL, OP_GE_LL, OP_LISTGET_L, OP_LISTSET_LL,
    DATE_YEAR, DATE_MONTH, DATE_DAY, DATE_HOUR, DATE_MINUTE, DATE_SECOND, DATE_DAY_OF_WEEK,
    TIMER_START, TIMER_STOP, TIMER_RESET,
    ZORDER_FRONT, ZORDER_FORWARD, ZORDER_BACKWARD, ZORDER_BACK,
    DIALOG_SPEAK, DIALOG_THINK, DIALOG_REMOVE,
    HOST_ANSWER, HOST_NICKNAME, HOST_BOOST_MODE, HOST_DEVICE_TYPE,
    HOST_TOUCH_SUPPORTED,
    SND_WAIT, SND_SECOND, SND_FROMTO,
    EF_COLOR, EF_BRIGHTNESS, EF_TRANSPARENCY,
    ENT_X, ENT_Y, ENT_ROTATION, ENT_DIRECTION, ENT_SIZE,
    ENT_PICTURE_INDEX, ENT_PICTURE_NAME,
} from './isa.js';
import { compileStructuredFunction } from './structured-native.js';
import { normalizeProject, stageOf } from './project.js';

/** 효과 드롭다운 값 → 효과 번호. 엔진의 `change_effect_amount` 분기와 같다. */
const EFFECTS = {
    color: EF_COLOR,
    brightness: EF_BRIGHTNESS,
    transparency: EF_TRANSPARENCY,
    opacity: EF_TRANSPARENCY,
};

/** `coordinate_object`의 두 번째 드롭다운 → 엔티티 속성 번호. */
const ENT_PROPS = {
    x: ENT_X,
    y: ENT_Y,
    rotation: ENT_ROTATION,
    direction: ENT_DIRECTION,
    size: ENT_SIZE,
    picture_index: ENT_PICTURE_INDEX,
    picture_name: ENT_PICTURE_NAME,
};

/**
 * **예약 변수** — 엔트리에 대응 블록이 아예 없는 EniwanVM 확장을 "변수"로 노출한다.
 *
 * 왜 이 방식인가: 1인칭 마우스룩에 필요한 상대 델타나 깊이 버퍼 제어는 엔트리
 * 블록 목록에 없다. 새 블록 타입을 만들면 그 작품은 엔트리 편집기에서 열리지
 * 않고 `make-ent --check`도 통과하지 못한다. 반면 **변수 읽기/쓰기는 평범한
 * 엔트리 문법**이라, 이름만 예약하면 작품이 문법적으로 멀쩡한 채로 확장을 쓴다.
 *
 * 쓰는 쪽은 그냥 이 이름의 변수를 작품에 선언하고 평소처럼 읽거나 넣으면 된다.
 * 선언된 실제 변수 슬롯은 쓰이지 않고 남는다(해롭지 않다 — `--check`를
 * 통과시키기 위한 자리다). EniwanVM이 아닌 일반 엔트리 런타임에서 돌리면
 * 그냥 값이 0인 보통 변수가 되므로, 작품이 깨지지는 않고 기능만 빠진다.
 */
const HOST_VARS = {
    // ── 이 런타임인지 묻는 이름. **정본은 `IsEniwanVM`이다.**
    //    엔트리에서 돌리면 아무도 건드리지 않는 0짜리 변수라, 작품은
    //    `IsEniwanVM = 1`인지로 분기해 확장 기능을 쓸지 말지 스스로 고른다.
    //    아래 두 이름(`is_Eniwan`/`EV_Eniwan`)은 이 이름을 정하기 전에 쓰인 작품을
    //    그대로 받기 위해 남겨 둔 별칭이다 — 새로 쓸 때는 `IsEniwanVM`을 쓴다.
    iseniwanvm: HOST_IS_ENIWAN,
    is_eniwan: HOST_IS_ENIWAN,
    ev_eniwan: HOST_IS_ENIWAN,
    // ── 상대 입력
    ev_mousedx: HOST_MOUSE_DX,          // 지난 읽기 이후 마우스 X 이동량(px). 읽으면 소비
    ev_mousedy: HOST_MOUSE_DY,          // 같은 Y. 화면 좌표계라 아래로 갈 때 양수
    ev_wheel: HOST_WHEEL,               // 휠 세로 누적량. 읽으면 소비
    ev_scrollx: HOST_SCROLL_X,          // 휠 가로 누적량. 읽으면 소비
    ev_pointerlocked: HOST_POINTER_LOCKED, // 포인터 락. 읽으면 1/0, 쓰면 잠금 요청
    ev_lock: HOST_POINTER_LOCKED,       // 같은 슬롯의 짧은 이름
    // ── 브라우저가 가진 것
    ev_clipboard: HOST_CLIPBOARD,       // 읽기=사용자가 붙여넣은 글, 쓰기=복사 요청
    ev_cursor: HOST_CURSOR,             // 무대 커서 모양. css 커서 키워드만 먹는다
    // ── 렌더 상태
    ev_depth: HOST_DEPTH,               // 다음에 그릴 도형의 깊이(작을수록 앞)
    ev_depthtest: HOST_DEPTH_TEST,      // 0이 아니면 깊이 검사 on

    /*
     * ── 다른 런타임(TessVM)에서 쓰이던 이름들.
     *
     * 같은 일을 하는 이름을 둘로 늘리는 게 아니라, **그 이름으로 이미 쓰인 작품을
     * 그대로 받기 위한** 것이다. 기능 이름(클립보드·커서·락·델타·스크롤)만 받고,
     * `$TESSVM`은 호환 프로필을 켰을 때만 1이 되는 별도 슬롯이다. Dorongi가
     * 무조건 TessVM인 척하지 않으면서 이미 배포된 TessVM 작품을 그대로 받는다.
     */
    $delta_x: HOST_MOUSE_DX,
    $delta_y: HOST_MOUSE_DY,
    $scroll_y: HOST_WHEEL,
    $scroll_x: HOST_SCROLL_X,
    $mouse_lock: HOST_POINTER_LOCKED,
    $m_lock: HOST_POINTER_LOCKED,
    $clipboard: HOST_CLIPBOARD,
    $cursor: HOST_CURSOR,
    $tessvm: HOST_IS_TESSVM,
};

const TESS_COMPAT_VARS = new Set([
    '$tessvm', '$clipboard', '$cursor', '$mouse_lock', '$m_lock',
    '$delta_x', '$delta_y', '$scroll_x', '$scroll_y',
]);

/** 변수 이름이 예약 이름이면 호스트 슬롯 번호, 아니면 undefined. */
export function hostSlotOf(name) {
    if (typeof name !== 'string') return undefined;
    return HOST_VARS[name.trim().toLowerCase()];
}

export { HOST_VARS };

/**
 * `calc_operation`의 드롭다운 값 → UNARY 번호.
 *
 * 전부 엔진 번들(`public/lib/entry-js/dist/entry.js`의 calc_operation func)에서
 * 확인한 이름이다. **추측으로 적으면 안 된다** — 제곱근은 `square_root`가 아니라
 * `root`이고, `unnatural`은 부호 반전이 아니라 소수부다. 없는 이름을 적으면
 * 그 블록은 미지원으로 떨어져 조용히 0이 된다.
 */
const UNARY_OPS = {
    root: UN_SQRT,
    square: UN_SQUARE, factorial: UN_FACTORIAL,
    abs: UN_ABS, floor: UN_FLOOR, ceil: UN_CEIL, round: UN_ROUND,
    sin: UN_SIN, cos: UN_COS, tan: UN_TAN,
    asin: UN_ASIN, acos: UN_ACOS, atan: UN_ATAN,
    // 엔진은 `operator.split('_')[0]`으로 _radian 접미사를 떼고 똑같이 처리한다
    // (= 라디안 변형도 결국 도 단위로 돌려준다). 그 동작을 그대로 흉내낸다.
    asin_radian: UN_ASIN, acos_radian: UN_ACOS, atan_radian: UN_ATAN,
    ln: UN_LN, log: UN_LOG,
    unnatural: UN_FRAC,
    // 드롭다운에는 없지만 **엔진에서는 도는** 이름. `calc_operation`의 마지막
    // 분기가 `Math[operator](value)`라서, 블록을 기계로 찍어 낸 작품에 들어 있는
    // `sqrt`도 엔트리에서는 그냥 돈다. 여기서 빠뜨리면 그 작품만 미지원으로
    // 떨어진다(실제로 89곳이 그랬다).
    sqrt: UN_SQRT,
};

/** `get_date` 드롭다운 → OP_DATE 필드 번호. */
const DATE_FIELDS = {
    YEAR: DATE_YEAR, MONTH: DATE_MONTH, DAY: DATE_DAY,
    HOUR: DATE_HOUR, MINUTE: DATE_MINUTE, SECOND: DATE_SECOND,
    DAY_OF_WEEK: DATE_DAY_OF_WEEK,
};

/** `choose_project_timer_action` 드롭다운 → OP_TIMERACT 동작 번호. */
const TIMER_ACTIONS = { START: TIMER_START, STOP: TIMER_STOP, RESET: TIMER_RESET };

/**
 * `change_object_index` 드롭다운 → OP_SETINDEX 위치 번호.
 *
 * 엔진 드롭다운 값은 `FRONT`/`FORWARD`/`BACKWARD`/`BACK`이다. 엔트리에서
 * **objects[0]이 맨 앞**이라서(무대 정렬이 배열을 거꾸로 훑는다) "앞으로
 * 가져오기"는 인덱스를 **줄이는** 쪽이다 — 부호를 거꾸로 적으면 가려짐이 반대가
 * 되고, 그건 화면을 봐야만 알 수 있는 버그가 된다.
 */
const ZORDER_LOCATIONS = {
    FRONT: ZORDER_FRONT, FORWARD: ZORDER_FORWARD,
    BACKWARD: ZORDER_BACKWARD, BACK: ZORDER_BACK,
};

const CMP_OPS = {
    EQUAL: OP_EQ, NOT_EQUAL: OP_NE,
    GREATER: OP_GT, LESS: OP_LT,
    GREATER_OR_EQUAL: OP_GE, LESS_OR_EQUAL: OP_LE,
};

// 곱셈은 `TIMES`가 아니라 **`MULTI`**다(엔진 calc_basic func + tools/lib/spec-dsl.mjs
// `OPS = { '*': 'MULTI' }`). 여기를 TIMES로 적어 뒀더니 horse-restore의 곱셈 1,748곳이
// 전부 미지원으로 떨어져 0이 됐다 — 느린 것보다 나쁜, "돌긴 도는데 틀린" 상태였다.
const BASIC_OPS = {
    PLUS: OP_ADD, MINUS: OP_SUB, MULTI: OP_MUL, DIVIDE: OP_DIV,
};

const LOCAL_BINARY_OPS = new Map([
    [OP_SUB, OP_SUB_LL], [OP_MUL, OP_MUL_LL], [OP_DIV, OP_DIV_LL],
    [OP_MOD, OP_MOD_LL], [OP_QUOT, OP_QUOT_LL],
    [OP_LT, OP_LT_LL], [OP_GT, OP_GT_LL], [OP_LE, OP_LE_LL], [OP_GE, OP_GE_LL],
]);

function isBlock(node) {
    return node && typeof node === 'object' && typeof node.type === 'string';
}

/** Entry가 실행 블록 수에 포함하는 직렬화 블록을 재귀적으로 센다. */
function serializedBlockCount(value) {
    if (Array.isArray(value)) return value.reduce((n, item) => n + serializedBlockCount(item), 0);
    if (!isBlock(value)) return 0;
    let count = 1;
    for (const param of value.params || []) count += serializedBlockCount(param);
    for (const body of value.statements || []) count += serializedBlockCount(body);
    return count;
}

/**
 * 함수 머리에서 매개변수 순서를 뽑는다.
 *
 * 함정: 매개변수 칸은 배열이 아니라 **params를 타고 내려가는 사슬**이다
 * (`function_field_label.params[1]` → 다음 칸 → …). 머리의 params를 평평하게
 * 읽으면 두 번째 이후 인자를 전부 놓친다 — drawguideedge는 인자가 4개인데 1개로 보인다.
 */
export function functionParamIds(head) {
    const ids = [];
    // Most Entry function heads are a single linked field chain. Imported and
    // older projects may put another field in a sibling parameter, though. A
    // first-child walk silently lost those arguments (and every reference to
    // them compiled as zero). Traverse the complete head in visual/depth-first
    // order and collect only the parameter slot owned by a field node.
    const visit = (node, depth = 0) => {
        if (!isBlock(node) || depth > 128) return;
        if (/^function_field_(string|boolean|number)$/.test(node.type)) {
            const slot = (node.params || []).find((p) => isBlock(p) && /Param_/.test(p.type));
            if (slot && !ids.includes(slot.type)) ids.push(slot.type);
        }
        for (const param of node.params || []) visit(param, depth + 1);
    };
    for (const param of head.params || []) visit(param);
    return ids;
}

/** Find the definition hat even when comments/loose blocks precede it. */
function functionHead(fn) {
    for (const thread of fn.content || []) {
        for (const block of thread || []) {
            if (isBlock(block) && block.type.startsWith('function_create')) return block;
        }
    }
    return null;
}

/**
 * 함수 정의를 본문 뭉치들과 반환식으로 쪼갠다.
 *
 * 함정 둘:
 * - 본문은 머리 블록(`function_create` / `function_create_value`)의 `statements[0]`
 *   안에 있다. 스레드의 형제 블록이 아니다.
 * - **반환 블록이라는 건 없다.** 레지스트리에 `function_return`류가 아예 없고,
 *   값 함수의 반환값은 머리 `function_create_value`의 **마지막 param 슬롯**에 담긴
 *   식이다. 본문을 다 돌린 뒤 그 식을 평가해 돌려준다.
 */
function functionShape(fn) {
    const bodies = [];
    let returnExpr = null;
    for (const thread of fn.content || []) {
        for (const block of thread || []) {
            if (!isBlock(block)) continue;
            if (block.type.startsWith('function_create')) {
                for (const s of block.statements || []) bodies.push(s);
                if (block.type === 'function_create_value') {
                    const params = block.params || [];
                    returnExpr = params.length ? params[params.length - 1] : null;
                }
            }
        }
    }
    return { bodies, returnExpr };
}

class Emitter {
    constructor() {
        this.code = [];          // 평평한 [op,a,b,c, op,a,b,c, …]
        this.consts = [];
        this.constIndex = new Map();
        this.strings = [];
        this.stringIndex = new Map();
    }

    get pc() { return this.code.length / INSTR_WORDS; }

    emit(op, a = 0, b = 0, c = 0) {
        this.code.push(op, a, b, c);
        return this.pc - 1;
    }

    /** 나중에 채울 점프 — 명령 위치를 돌려주고 patch로 메운다. */
    patch(at, slot, value) {
        this.code[at * INSTR_WORDS + slot] = value;
    }

    constIdx(value) {
        const n = Number(value);
        const key = Number.isFinite(n) ? n : 0;
        if (this.constIndex.has(key)) return this.constIndex.get(key);
        const idx = this.consts.length;
        this.consts.push(key);
        this.constIndex.set(key, idx);
        return idx;
    }

    stringIdx(value) {
        const s = String(value);
        if (this.stringIndex.has(s)) return this.stringIndex.get(s);
        const idx = this.strings.length;
        this.strings.push(s);
        this.stringIndex.set(s, idx);
        return idx;
    }
}

class Scope {
    /**
     * 레지스터는 프레임 안에서 스택처럼 쓴다. 식을 컴파일하기 전 `mark()`를 찍고
     * 끝나면 `release(mark)`로 되감으면, 임시 레지스터가 영원히 쌓이지 않는다.
     * 고수위(`high`)가 그 프레임이 필요한 레지스터 수가 된다.
     */
    constructor(paramCount) {
        this.next = paramCount;      // 0..paramCount-1 은 인자가 점유
        this.high = paramCount;
        this.paramCount = paramCount;
    }

    mark() { return this.next; }
    release(mark) { this.next = mark; }

    alloc() {
        const r = this.next;
        this.next += 1;
        if (this.next > this.high) this.high = this.next;
        return r;
    }
}

export class Compiler {
    constructor(project, options = {}) {
        // `.ent`의 script/content는 JSON 문자열이다. 입구에서 파싱하지 않으면
        // 스레드가 0개인 프로그램이 에러 없이 나온다 — 멱등이라 두 번 불러도 괜찮다.
        this.project = normalizeProject(project);
        this.em = new Emitter();
        this.unsupported = new Map();
        // 일부러 넘긴 블록(꾸밈만 하는 것들). 미지원과 섞으면 관문 판정이 틀어진다.
        this.ignored = new Map();
        // Entry executor의 지연을 피하려고 넣은 운반 블록처럼, EniwanVM에서는
        // 의미가 없어 컴파일 단계에서 지운 항목. 미지원/무시와 구분해 보고한다.
        this.optimized = new Map();
        // Entry의 일반 반복은 매 회 executor frame을 양보한다. 작품이 명시적으로
        // 지연 제거 표식을 넣은 반복이나, 대규모 정점/데이터 파싱 반복은 한 tick 안에서 동기 실행한다.
        this.isDataIntensive = isDataIntensiveProject(this.project);
        this.legacyLoopYield = options.legacyLoopYield !== undefined
            ? Boolean(options.legacyLoopYield)
            : !this.isDataIntensive;
        this.maxRegisters = options.maxRegisters || 256;
        // 오브젝트의 처음 좌표·방향·크기와 모양·소리 주소. 블록만 봐서는 알 수 없다.
        this.stage = stageOf(this.project);
        // 신호(message) id → 번호. 보내는 쪽과 받는 쪽이 같은 번호를 봐야 한다.
        this.messageIndex = new Map();
        // 지금 컴파일 중인 루프들. `반복 중단`/`계속하기`가 여기를 보고 점프한다.
        this.loops = [];
        this.functionExitPatches = null;
        this.emittedClone = false;
        this.usesTouching = false;

        this.varIndex = new Map();
        this.vars = [];
        this.listIndex = new Map();
        this.lists = [];
        this.tableIndex = new Map();
        this.tables = [];
        this.functions = [];
        this.funcIndex = new Map();
        this.usedHostSlots = new Set();
        this.usesTessVM = false;
        this.threads = [];
        // text_write 등 "어느 오브젝트의 글상자인가"가 필요한 블록용. 함수 본문을
        // 컴파일할 때는 호출자를 알 수 없으므로 -1이다.
        this.currentObject = -1;
        // 지금 컴파일 중인 오브젝트가 글상자인가. `hide`/`show`의 의미가 갈린다
        // (아래 해당 case 참고). 함수 본문에서는 알 수 없으니 보수적으로 true다.
        this.currentObjectIsText = true;
    }

    /** `hostSlotOf` + "이 작품이 썼다"고 기록. 호스트가 확장을 켤 근거가 된다. */
    _hostSlot(name) {
        let resolvedName = String(name ?? '').trim().toLowerCase();
        let slot = hostSlotOf(resolvedName);
        // 실제 Entry 블록은 표시 이름이 아니라 임의 variable id를 params에 넣는다.
        // 전역 변수 정의를 따라가 이름을 다시 확인해야 `$TESSVM` 같은 예약 변수가
        // 서버 작품에서도 동작한다. 오브젝트 변수는 TessVM 규격대로 제외한다.
        if (slot === undefined) {
            const index = this.varIndex.get(String(name));
            const variable = index === undefined ? null : this.vars[index];
            if (variable && !(variable.ownerObject >= 0)) {
                resolvedName = String(variable.name ?? '').trim().toLowerCase();
                slot = hostSlotOf(resolvedName);
            }
        }
        if (slot !== undefined) {
            this.usedHostSlots.add(slot);
            if (TESS_COMPAT_VARS.has(resolvedName)) this.usesTessVM = true;
        }
        return slot;
    }

    /**
     * 함수 지역변수 id → 그 프레임의 레지스터. 함수 밖(오브젝트 스레드)이거나
     * 이 함수에 없는 id면 `undefined`.
     *
     * 모르는 id를 0으로 조용히 넘기지 않는 이유: 엔진에서 그런 블록은 0을 주지만,
     * **우리 쪽 레이아웃 버그도 똑같이 0으로 보인다.** 둘을 구별할 수 없으니
     * 미지원으로 세서 관문에 걸리게 둔다 — 틀린 그림이 제일 나쁘다.
     */
    _localSlot(id, scope) {
        if (!scope || !scope.locals) return undefined;
        return scope.locals.get(String(id ?? ''));
    }

    note(type) {
        this.unsupported.set(type, (this.unsupported.get(type) || 0) + 1);
    }

    /**
     * **일부러 아무 일도 하지 않는** 블록. 미지원과 따로 센다.
     *
     * `변수 보이기`처럼 화면 꾸밈만 하는 블록을 미지원으로 세면, 멀쩡히 돌아가는
     * 작품이 호환성 관문에서 통째로 걸러진다. 그렇다고 조용히 삼키면 "왜 변수
     * 창이 안 뜨지"를 아무 단서 없이 찾게 된다 — 그래서 숫자로는 남긴다.
     */
    ignore(type) {
        this.ignored.set(type, (this.ignored.get(type) || 0) + 1);
    }

    optimize(type) {
        this.optimized.set(type, (this.optimized.get(type) || 0) + 1);
    }

    /** 신호 이름 → 번호. 처음 보는 이름이면 자리를 만든다. */
    messageSlot(id) {
        const key = String(id ?? '');
        if (this.messageIndex.has(key)) return this.messageIndex.get(key);
        const idx = this.messageIndex.size;
        this.messageIndex.set(key, idx);
        return idx;
    }

    /** 루프 하나를 연다. 안쪽의 `반복 중단`/`계속하기`가 뛸 자리를 모은다. */
    _openLoop(top) {
        const frame = { top, breaks: [], continues: [] };
        this.loops.push(frame);
        return frame;
    }

    _closeLoop(frame, exitPc, continuePc = frame.top) {
        this.loops.pop();
        for (const at of frame.breaks) this.em.patch(at, 1, exitPc);
        for (const at of frame.continues) this.em.patch(at, 1, continuePc);
    }

    /**
     * 모양·소리처럼 "목록에서 하나 고르기" 슬롯. 드롭다운이면 컴파일 때 번호가
     * 정해지고, 값 블록이면 런타임에 찾는다(번호/id/이름 순).
     * @returns {number} 0 이상이면 확정된 번호, -1이면 런타임 조회
     */
    _assetIndex(value, list) {
        if (isBlock(value) || value === null || value === undefined) return -1;
        const key = String(value);
        const byId = list.findIndex((a) => a.id === key);
        if (byId >= 0) return byId;
        const byName = list.findIndex((a) => a.name === key);
        if (byName >= 0) return byName;
        const n = Number(key);
        if (Number.isFinite(n) && n >= 1 && n <= list.length) return Math.round(n) - 1;
        return -1;
    }

    /** 지금 컴파일 중인 오브젝트의 모양 목록(함수 본문에서는 비어 있다). */
    get _pictures() {
        const object = this.stage.objects[this.currentObject];
        return object ? object.pictures : [];
    }

    get _sounds() {
        const object = this.stage.objects[this.currentObject];
        return object ? object.sounds : [];
    }

    varSlot(name) {
        const key = String(name);
        if (this.varIndex.has(key)) return this.varIndex.get(key);
        const idx = this.vars.length;
        this.vars.push({ name: key, initial: 0 });
        this.varIndex.set(key, idx);
        return idx;
    }

    listSlot(name) {
        const key = String(name);
        if (this.listIndex.has(key)) return this.listIndex.get(key);
        const idx = this.lists.length;
        this.lists.push({ name: key, initial: [] });
        this.listIndex.set(key, idx);
        return idx;
    }

    tableSlot(id) {
        const key = String(id ?? '');
        if (this.tableIndex.has(key)) return this.tableIndex.get(key);
        const idx = this.tables.length;
        this.tables.push({ id: key, name: key, fields: [], rows: [] });
        this.tableIndex.set(key, idx);
        return idx;
    }

    // ── 식 ──────────────────────────────────────────────────────────────
    /** `node`를 평가해 값이 담긴 레지스터 번호를 돌려준다. */
    expr(node, scope) {
        const em = this.em;

        // 리터럴
        if (node === null || node === undefined) {
            const r = scope.alloc();
            em.emit(OP_CONST, r, em.constIdx(0));
            return r;
        }
        if (typeof node === 'number') {
            const r = scope.alloc();
            em.emit(OP_CONST, r, em.constIdx(Number.isFinite(node) ? node : 0));
            return r;
        }
        if (typeof node === 'string' && !isBlock(node)) {
            // Entry's primitive `number` and `text` blocks both return their
            // field value verbatim. Numeric consumers coerce it later through
            // getNumberValue/parseFloat. Eagerly turning "001" into 1 corrupts
            // list data, IDs and concatenation before that consumer is known.
            const r = scope.alloc();
            em.emit(OP_CONSTSTR, r, em.stringIdx(node));
            return r;
        }
        if (!isBlock(node)) {
            const r = scope.alloc();
            em.emit(OP_CONST, r, em.constIdx(0));
            return r;
        }

        const type = node.type;
        const p = node.params || [];

        // 매개변수 참조 — 레지스터 0..n-1 이 곧 인자다.
        if (/Param_/.test(type)) {
            const idx = scope.params ? scope.params.indexOf(type) : -1;
            if (idx >= 0) return idx;
            // Some duplicated Entry functions retain the generated parameter
            // type from their source function. Entry still binds the only
            // visible slot by position. Do the same when the target function
            // is unambiguous; with multiple slots an unknown id remains an
            // error instead of guessing the wrong argument.
            if (scope.params?.length === 1) return 0;
            const r = scope.alloc();
            this.note(type);
            em.emit(OP_CONST, r, em.constIdx(0));
            return r;
        }

        switch (type) {
            case 'number':
            case 'angle':
                return this.expr(p[0] === undefined ? 0 : p[0], scope);
            case 'text':
                return this.expr(p[0] === undefined ? '' : p[0], scope);
            case 'True': case 'true': {
                const r = scope.alloc(); em.emit(OP_CONST, r, em.constIdx(1)); return r;
            }
            case 'False': case 'false': {
                const r = scope.alloc(); em.emit(OP_CONST, r, em.constIdx(0)); return r;
            }
            case 'get_variable': {
                const r = scope.alloc();
                const host = this._hostSlot(p[0]);
                if (host === undefined) em.emit(OP_LOADVAR, r, this.varSlot(p[0]));
                else em.emit(OP_LOADHOST, r, host);
                return r;
            }
            case 'positive_number':
            case 'wildcard_string':
            case 'wildcard_boolean':
            case 'get_boolean_value':
                return this.expr(p[0], scope);
            case 'negative_number': {
                const src = this.expr(p[0], scope);
                const r = scope.alloc();
                em.emit(OP_UNARY, r, src, UN_NEG);
                return r;
            }
            case 'get_func_variable': {
                const slot = this._localSlot(p[0], scope);
                const r = scope.alloc();
            if (slot === undefined) {
                this.note(type);
                em.emit(OP_CONST, r, em.constIdx(0));
            } else {
                em.emit(OP_LOADLOCAL, r, slot);
            }
                return r;
            }
            case 'calc_basic': {
                const op = BASIC_OPS[p[1]];
                if (op === undefined) { this.note(`calc_basic:${p[1]}`); return this.expr(0, scope); }
                return this.binary(op, p[0], p[2], scope);
            }
            case 'quotient_and_mod': {
                // paramsKeyMap LEFTHAND:1 RIGHTHAND:3 OPERATOR:5 — 0·2·4는 UI 라벨이다.
                // 0·1·2로 읽으면 피연산자가 라벨(null)이 되어 결과가 0이 된다.
                const op = String(p[5]).toUpperCase() === 'MOD' ? OP_MOD : OP_QUOT;
                return this.binary(op, p[1], p[3], scope);
            }
            case 'calc_operation': {
                // paramsKeyMap LEFTHAND:1 VALUE:3
                const name = String(p[3] || '').toLowerCase();
                const fn = UNARY_OPS[name];
                if (fn === undefined) { this.note(`calc_operation:${p[3]}`); return this.expr(0, scope); }
                const mark = scope.mark();
                const src = this.expr(p[1], scope);
                scope.release(mark);
                const r = scope.alloc();
                em.emit(OP_UNARY, r, src, fn);
                return r;
            }
            case 'calc_rand': {
                // 표준 Entry AST는 [라벨, 최솟값, 라벨, 최댓값, 라벨]이다.
                // 간소화된 옛 AST의 [최솟값, 최댓값]도 계속 받는다.
                const standard = p.length >= 4;
                return this.binary(OP_RAND, standard ? p[1] : p[0],
                    standard ? p[3] : p[1], scope);
            }
            case 'change_rgb_to_hex': {
                // paramsKeyMap RED:0 GREEN:1 BLUE:2. 세 인자를 연속 레지스터로 넘긴다.
                const values = p.slice(0, 3).map((value) => this.expr(value, scope));
                const args = scope.next;
                scope.alloc(); scope.alloc(); scope.alloc();
                for (let i = 0; i < 3; i += 1) {
                    if (values[i] !== args + i) em.emit(OP_MOV, args + i, values[i]);
                }
                const r = scope.alloc();
                em.emit(OP_RGBHEX, r, args);
                return r;
            }
            case 'change_hex_to_rgb': {
                const src = this.expr(p[0], scope);
                const channel = { r: 0, g: 1, b: 2 }[String(p[1] ?? 'r').toLowerCase()] ?? 0;
                const r = scope.alloc();
                em.emit(OP_HEXRGB, r, src, channel);
                return r;
            }
            case 'boolean_basic_operator': {
                const op = CMP_OPS[p[1]];
                if (op === undefined) { this.note(`boolean:${p[1]}`); return this.expr(0, scope); }
                return this.binary(op, p[0], p[2], scope);
            }
            case 'boolean_and_or': {
                const op = String(p[1]).toUpperCase() === 'OR' ? OP_OR : OP_AND;
                return this.binary(op, p[0], p[2], scope);
            }
            case 'boolean_not': {
                const mark = scope.mark();
                // Entry의 boolean_not은 실제 피연산자가 가운데 슬롯(params[1])에
                // 들어간다. 일부 오래된/간소화 AST만 params[0]을 쓰므로 둘 다
                // 받는다. params[0]만 읽으면 표준 블록의 null 라벨을 NOT해서
                // 결과가 언제나 참이 된다(빈 공간도 도형 클릭으로 판정됨).
                const operand = p[1] !== undefined && p[1] !== null ? p[1] : p[0];
                const src = this.expr(operand, scope);
                scope.release(mark);
                const r = scope.alloc();
                em.emit(OP_NOT, r, src);
                return r;
            }
            // ── 문자·리스트 값 블록. 전부 "라벨 끼워진" 홀수 슬롯 배치다.
            case 'is_included_in_list': {
                const mark = scope.mark();
                const src = this.expr(p[3], scope);
                scope.release(mark);
                const r = scope.alloc();
                em.emit(OP_INLIST, r, this.listSlot(p[1]), src);
                return r;
            }
            case 'char_at': return this.binary(OP_CHARAT, p[1], p[3], scope);
            case 'index_of_string': return this.binary(OP_STRIDX, p[1], p[3], scope);
            case 'length_of_string': return this.unary(OP_STRLEN, p[1], scope);
            case 'reverse_of_string': return this.unary(OP_STRREV, p[1], scope);
            case 'change_string_case': {
            const compact = p.length < 4;
            const mode = String(compact ? p[1] : p[3]).toLowerCase();
            const upper = mode.includes('upper') ? 1 : 0;
            return this.unary(OP_STRCASE, compact ? p[0] : p[1], scope, upper);
            }
            // 인자가 셋인 두 블록만 **연속한 레지스터 세 칸**에 모아 넘긴다
            // (ISA 쪽 주석 참고). 결과 레지스터는 임시들보다 **위에** 잡는다 —
            // 먼저 풀어 버리면 결과가 첫 인자 자리와 겹쳐 덮어쓴다.
            case 'substring':
            case 'replace_string': {
                const s0 = this.expr(p[1], scope);
                const s1 = this.expr(p[3], scope);
                const s2 = this.expr(p[5], scope);
                const b0 = scope.alloc();
                const b1 = scope.alloc();
                const b2 = scope.alloc();
                em.emit(OP_MOV, b0, s0);
                em.emit(OP_MOV, b1, s1);
                em.emit(OP_MOV, b2, s2);
                const r = scope.alloc();
                em.emit(type === 'substring' ? OP_SUBSTR : OP_REPLACE, r, b0);
                return r;
            }
            case 'coordinate_object': {
                const prop = ENT_PROPS[String(p[3] ?? 'x')];
                if (prop === undefined) { this.note(`${type}:${p[3]}`); return this.expr(0, scope); }
                const target = String(p[1] ?? 'self');
                let objectIndex = -1;
                if (target !== 'self') {
                    objectIndex = this.stage.objects.findIndex((o) => o.id === target);
                    if (objectIndex < 0) { this.note(type); return this.expr(0, scope); }
                }
                const r = scope.alloc();
                em.emit(OP_LOADENT, r, prop, objectIndex);
                return r;
            }
            // 소리 길이는 project.json에 적혀 있다 — 상수로 박는다.
            case 'get_sound_duration': {
                const idx = this._assetIndex(p[1], this._sounds);
                if (idx < 0) { this.note(type); return this.expr(0, scope); }
                return this.expr(this._sounds[idx].duration, scope);
            }
            case 'get_sound_volume':
            case 'get_sound_speed': {
                const r = scope.alloc();
                em.emit(OP_SOUNDSTATE, r, type === 'get_sound_speed' ? 1 : 0);
                return r;
            }
            // ── 아래 세 블록의 슬롯 번호는 전부 "라벨 끼워진" 배치다.
            //    VALUE1:1 VALUE2:3 처럼 **홀수 자리**에 값이 있고 짝수 자리는 UI
            //    텍스트다. 0부터 순서대로 읽으면 피연산자가 null이 되어 조용히 0이 된다.
            case 'combine_something': {
                return this.binary(OP_CONCAT, p[1], p[3], scope);
            }
            case 'value_of_index_from_list': {
                // params: [_, 리스트, _, 인덱스, _]
            const indexNode = p[3];
            if (isBlock(indexNode) && indexNode.type === 'get_func_variable') {
                const local = this._localSlot((indexNode.params || [])[0], scope);
                if (local !== undefined) {
                    const r = scope.alloc();
                    em.emit(OP_LISTGET_L, r, this.listSlot(p[1]), local);
                    this.optimize('local_list_get_superinstruction');
                    return r;
                }
            }
                const mark = scope.mark();
                const idxReg = this.expr(p[3], scope);
                scope.release(mark);
                const r = scope.alloc();
                em.emit(OP_LISTGET, r, this.listSlot(p[1]), idxReg);
                return r;
            }
            case 'length_of_list': {
                // params: [_, 리스트, _]
                const r = scope.alloc();
                em.emit(OP_LISTLEN, r, this.listSlot(p[1]));
                return r;
            }
            case 'get_table_count': {
                const r = scope.alloc();
                const property = String(p[1] ?? 'ROW').toUpperCase() === 'COL' ? 1 : 0;
                em.emit(OP_TABLECOUNT, r, this.tableSlot(p[0]), property);
                return r;
            }
            case 'get_value_from_table': {
                const args = scope.next;
                scope.alloc(); scope.alloc();
                const row = this.expr(p[1], scope);
                const col = this.expr(p[2], scope);
                if (row !== args) em.emit(OP_MOV, args, row);
                if (col !== args + 1) em.emit(OP_MOV, args + 1, col);
                const r = scope.alloc();
                em.emit(OP_TABLEGET, r, this.tableSlot(p[0]), args);
                return r;
            }
            case 'get_value_from_last_row': {
                const table = this.tableSlot(p[0]);
                const args = scope.next;
                scope.alloc(); scope.alloc();
                em.emit(OP_TABLECOUNT, args, table, 0);
                const col = this.expr(p[1], scope);
                if (col !== args + 1) em.emit(OP_MOV, args + 1, col);
                const r = scope.alloc();
                em.emit(OP_TABLEGET, r, table, args);
                return r;
            }
            case 'calc_values_from_table': {
                const args = scope.next;
                scope.alloc(); scope.alloc();
                const col = this.expr(p[1], scope);
                const calc = this.expr(String(p[2] ?? 'SUM'), scope);
                if (col !== args) em.emit(OP_MOV, args, col);
                if (calc !== args + 1) em.emit(OP_MOV, args + 1, calc);
                const r = scope.alloc();
                em.emit(OP_TABLECALC, r, this.tableSlot(p[0]), args);
                return r;
            }
            case 'get_table_fields':
                return this.expr(p[0] ?? '', scope);
            case 'get_value_from_cell': {
                const cell = this.expr(p[1], scope);
                const r = scope.alloc();
                em.emit(OP_TABLECELLGET, r, this.tableSlot(p[0]), cell);
                return r;
            }
            case 'get_coefficient': {
                const args = scope.next;
                scope.alloc(); scope.alloc();
                const first = this.expr(p[1], scope);
                const second = this.expr(p[2], scope);
                if (first !== args) em.emit(OP_MOV, args, first);
                if (second !== args + 1) em.emit(OP_MOV, args + 1, second);
                const r = scope.alloc();
                em.emit(OP_TABLECOEFF, r, this.tableSlot(p[0]), args);
                return r;
            }
            case 'get_value_v_lookup': {
                const args = scope.next;
                scope.alloc(); scope.alloc(); scope.alloc();
                const field = this.expr(p[1], scope);
                const value = this.expr(p[2], scope);
                const resultField = this.expr(p[3], scope);
                if (field !== args) em.emit(OP_MOV, args, field);
                if (value !== args + 1) em.emit(OP_MOV, args + 1, value);
                if (resultField !== args + 2) em.emit(OP_MOV, args + 2, resultField);
                const r = scope.alloc();
                em.emit(OP_TABLELOOKUP, r, this.tableSlot(p[0]), args);
                return r;
            }
            case 'get_block_count': {
                const key = String(p[0] ?? 'all');
                let objects = this.project.objects || [];
                if (key === 'self') objects = objects.slice(this.currentObject, this.currentObject + 1);
                else if (key.startsWith('object-')) {
                    const id = key.slice(7);
                    objects = objects.filter((object) => object.id === id);
                } else if (key.startsWith('scene-')) {
                    const id = key.slice(6);
                    const sceneIndex = this.stage.scenes.findIndex((scene) => scene.id === id);
                    objects = objects.filter((object) => (object.sceneIndex || 0) === sceneIndex);
                } else if (key !== 'all') objects = [];
                return this.expr(objects.reduce((n, object) => n + serializedBlockCount(object.script || []), 0), scope);
            }
            case 'coordinate_mouse': {
                // params: [_, 축, _] — VALUE:1
                const r = scope.alloc();
                em.emit(OP_LOADHOST, r, String(p[1]).toLowerCase() === 'y' ? HOST_MOUSE_Y : HOST_MOUSE_X);
                return r;
            }
            case 'count_match_string':
                return this.binary(OP_STRCOUNT, p[0], p[2], scope);
            case 'is_type': {
                const src = this.expr(p[0], scope);
                const kind = String(p[2] ?? 'number').toLowerCase();
                const r = scope.alloc();
                em.emit(OP_ISTYPE, r, src, kind === 'en' ? 1 : kind === 'ko' ? 2 : 0);
                return r;
            }
            case 'distance_something': {
                const target = String(p[1] ?? 'mouse');
                let objectIndex = -1;
                if (target !== 'mouse') {
                    objectIndex = this.stage.objects.findIndex((o) => o.id === target || o.name === target);
                    if (objectIndex < 0) { this.note(type); return this.expr(0, scope); }
                }
                const r = scope.alloc();
                em.emit(OP_DISTANCE, r, objectIndex);
                return r;
            }
            case 'reach_something': {
                this.usesTouching = true;
                const target = String(p[1] ?? 'mouse');
                let objectIndex = -1;
                if (target === 'wall' || target === 'edge') objectIndex = -2;
                else if (target !== 'mouse') {
                    objectIndex = this.stage.objects.findIndex((o) => o.id === target || o.name === target);
                    if (objectIndex < 0) { this.note(type); return this.expr(0, scope); }
                }
                const r = scope.alloc();
                em.emit(OP_TOUCHING, r, objectIndex);
                return r;
            }
            // 레지스트리에 `is_mouse_pressed`라는 블록은 **없다**. 마우스 눌림은
            // `is_clicked`(엔진: `Entry.stage.isClick`)다.
            case 'is_clicked': {
                const r = scope.alloc();
                em.emit(OP_LOADHOST, r, HOST_MOUSE_DOWN);
                return r;
            }
            case 'is_object_clicked': {
                const r = scope.alloc();
                em.emit(OP_OBJECTCLICKED, r);
                return r;
            }
            case 'is_boost_mode': {
                const r = scope.alloc();
                this.usedHostSlots.add(HOST_BOOST_MODE);
                em.emit(OP_LOADHOST, r, HOST_BOOST_MODE);
                return r;
            }
            case 'is_touch_supported': {
                const r = scope.alloc();
                this.usedHostSlots.add(HOST_TOUCH_SUPPORTED);
                em.emit(OP_LOADHOST, r, HOST_TOUCH_SUPPORTED);
                return r;
            }
            case 'is_current_device_type': {
                this.usedHostSlots.add(HOST_DEVICE_TYPE);
                const actual = scope.alloc();
                const expected = scope.alloc();
                const result = scope.alloc();
                const kind = String(p[0] ?? 'desktop').toLowerCase();
                em.emit(OP_LOADHOST, actual, HOST_DEVICE_TYPE);
                em.emit(OP_CONST, expected,
                    em.constIdx(kind === 'tablet' ? 1 : kind === 'mobile' ? 2 : 0));
                em.emit(OP_EQ, result, actual, expected);
                return result;
            }
            case 'is_press_some_key': {
                // params: [키코드, _] — VALUE:0. 키코드는 리터럴 필드다.
                const r = scope.alloc();
                em.emit(OP_LOADKEY, r, Number(p[0]) || 0);
                return r;
            }
            // 색 선택 블록 — 값은 그냥 `#RRGGBB` 문자열이다.
            case 'color':
            case 'text_color': {
                const r = scope.alloc();
                em.emit(OP_CONSTSTR, r, em.stringIdx(p[0] === undefined ? '#000000' : p[0]));
                return r;
            }
            case 'get_project_timer_value': {
                const r = scope.alloc();
                em.emit(OP_LOADHOST, r, HOST_TIMER);
                return r;
            }
            // 소리 고르기 — 엔진도 `script.getStringField('VALUE')`로 **고른 이름을
            // 그대로** 돌려준다(소리를 재생하는 블록이 그 이름으로 다시 찾는다).
            case 'get_sounds': {
                const r = scope.alloc();
                em.emit(OP_CONSTSTR, r, em.stringIdx(p[0] === undefined ? '' : String(p[0])));
                return r;
            }
            case 'get_date': {
                // paramsKeyMap VALUE:1 — 앞뒤 슬롯은 UI 텍스트다.
                const field = DATE_FIELDS[String(p[1] || '').toUpperCase()];
                if (field === undefined) { this.note(`${type}:${p[1]}`); return this.expr(0, scope); }
                const r = scope.alloc();
                em.emit(OP_DATE, r, field);
                return r;
            }
            // 닉네임은 **매 프레임 물어볼 값이 아니다**(엔진도 `window.user`를 읽는다).
            // 호스트가 시작할 때 한 번 받아 문자 슬롯에 넣어 두고, 작품은 그걸 읽는다.
            case 'get_nickname': {
                // 호스트가 "이 작품에만" 사용자 정보를 받아 오도록 표를 남긴다.
                this.usedHostSlots.add(HOST_NICKNAME);
                const r = scope.alloc();
                em.emit(OP_LOADHOST, r, HOST_NICKNAME);
                return r;
            }
            case 'get_user_name': {
                this.usedHostSlots.add(HOST_NICKNAME);
                const r = scope.alloc();
                em.emit(OP_LOADHOST, r, HOST_NICKNAME);
                return r;
            }
            case 'get_canvas_input_value': {
                const r = scope.alloc();
                em.emit(OP_LOADHOST, r, HOST_ANSWER);
                return r;
            }
            case 'get_pictures':
                // 이미지 선택 드롭다운은 작품 JSON의 picture id를 값으로 준다.
                // 모양 변경 명령이 id → 이름 → 1-based 번호 순서로 해석한다.
                return this.expr(p[0] ?? '', scope);
            case 'text_read': {
                const target = String(p[0] ?? 'self');
                const objectIndex = target === 'self' || target === ''
                    ? this.currentObject
                    : this.stage.objects.findIndex((o) => o.id === target || o.name === target);
                if (objectIndex < 0) { this.note(type); return this.expr('', scope); }
                const r = scope.alloc();
                em.emit(OP_TEXTREAD, r, objectIndex);
                return r;
            }
            default:
                break;
        }

        // 값 반환 함수 호출
        if (type.startsWith('func_')) return this.call(node, scope, true);

        // 요청 범위 밖의 확장/AI/하드웨어 블록은 유령 reporter다. 값 자리에는
        // Entry의 빈 reporter처럼 0을 남기고, 작품의 나머지 실행은 계속한다.
        this.ignore(type);
        return this.expr(0, scope);
    }

    binary(op, lhs, rhs, scope) {
        const fused = LOCAL_BINARY_OPS.get(op);
        if (fused !== undefined
            && isBlock(lhs) && lhs.type === 'get_func_variable'
            && isBlock(rhs) && rhs.type === 'get_func_variable') {
            const left = this._localSlot((lhs.params || [])[0], scope);
            const right = this._localSlot((rhs.params || [])[0], scope);
            if (left !== undefined && right !== undefined) {
                const r = scope.alloc();
                this.em.emit(fused, r, left, right);
                this.optimize('local_binary_superinstruction');
                return r;
            }
        }
        const mark = scope.mark();
        const a = this.expr(lhs, scope);
        const b = this.expr(rhs, scope);
        scope.release(mark);
        const r = scope.alloc();
        this.em.emit(op, r, a, b);
        return r;
    }

    /** 인자 하나짜리 — `binary`와 같은 요령이다(먼저 풀고 결과를 그 자리에 잡는다). */
    unary(op, operand, scope, c = 0) {
        const mark = scope.mark();
        const src = this.expr(operand, scope);
        scope.release(mark);
        const r = scope.alloc();
        this.em.emit(op, r, src, c);
        return r;
    }

    /**
     * 함수 호출. 인자를 **연속한 레지스터**에 쌓아 그 시작 번호를 넘긴다 —
     * 피호출자의 프레임은 거기서 시작하므로 인자 복사가 아예 없다(슬라이딩 윈도우).
     */
    call(node, scope, wantValue) {
        const em = this.em;
        const name = node.type.slice('func_'.length);
        const fnIdx = this.funcIndex.get(name);
        if (fnIdx === undefined) {
            this.note(node.type);
            if (!wantValue) return -1;
            return this.expr(0, scope);
        }
        const arity = this.functions[fnIdx].arity;
        const args = node.params || [];

        // 반환 레지스터는 인자 영역보다 **아래**에 잡아야 한다. 피호출자의 프레임은
        // argStart에서 시작해 그 위를 전부 덮어쓰므로, 위에 잡으면 돌아왔을 때
        // 반환값이 이미 지워져 있다(조용히 0이 되는 종류의 버그다).
        const ret = wantValue ? scope.alloc() : -1;

        // 인자 레지스터는 반드시 연속이어야 한다 — 먼저 자리를 잡고 그 자리에 쓴다.
        const argStart = scope.next;
        for (let i = 0; i < arity; i += 1) scope.alloc();
        for (let i = 0; i < arity; i += 1) {
            const mark = scope.mark();
            const value = args[i] === undefined || args[i] === null ? 0 : args[i];
            const src = this.expr(value, scope);
            scope.release(mark);
            if (src !== argStart + i) em.emit(OP_MOV, argStart + i, src);
        }
        em.emit(OP_CALL, fnIdx, argStart, ret);
        scope.release(argStart);   // 인자 영역만 반납 — ret은 아래에 있어 살아남는다
        return ret;
    }

    // ── 문장 ────────────────────────────────────────────────────────────
    statements(list, scope) {
        for (const block of list || []) {
            if (!isBlock(block)) continue;
            this.statement(block, scope);
        }
    }

    statement(block, scope) {
        const em = this.em;
        const type = block.type;
        const p = block.params || [];
        const body = block.statements || [];

        // Entry의 `continue_repeat` 부작용을 파라미터 평가 중 일으켜 반복의 암묵적
        // 프레임 양보를 없애는 운반 블록이다. 호스트 종류와 슬롯 위치는 중요하지
        // 않다. EniwanVM 반복은 이 표식을 직접 이해하므로 바깥 statement도 실행하지 않는다.
        if (isFrameSkipCarrier(block)) {
            this.optimize(`frame_skip_carrier:${type}`);
            return;
        }
        const mark = scope.mark();

        switch (type) {
            case 'set_variable': {
                const src = this.expr(p[1], scope);
                const host = this._hostSlot(p[0]);
                if (host === undefined) em.emit(OP_STOREVAR, this.varSlot(p[0]), src);
                else em.emit(OP_STOREHOST, host, src);
                break;
            }
            case 'set_func_variable': {
                const slot = this._localSlot(p[0], scope);
                if (slot === undefined) { this.note(type); break; }
                const src = this.expr(p[1] === undefined ? 0 : p[1], scope);
                // 지역변수는 레지스터다 — 쓰기는 옮기기 하나로 끝난다(보정은 읽는 쪽).
            em.emit(OP_MOV, slot, src);
                break;
            }
            case 'change_variable': {
                const src = this.expr(p[1], scope);
                const host = this._hostSlot(p[0]);
                if (host === undefined) {
                    em.emit(OP_ADDVAR, this.varSlot(p[0]), src);
                } else {
                    // 호스트 슬롯에는 "상대 변경"이 없다. 읽어서 더한 뒤 다시 쓴다.
                    const cur = scope.alloc();
                    em.emit(OP_LOADHOST, cur, host);
                    const sum = scope.alloc();
                    em.emit(OP_ADD, sum, cur, src);
                    em.emit(OP_STOREHOST, host, sum);
                }
                break;
            }
            case 'change_value_list_index': {
            if (isBlock(p[1]) && p[1].type === 'get_func_variable'
                && isBlock(p[2]) && p[2].type === 'get_func_variable') {
                const indexLocal = this._localSlot((p[1].params || [])[0], scope);
                const valueLocal = this._localSlot((p[2].params || [])[0], scope);
                if (indexLocal !== undefined && valueLocal !== undefined) {
                    em.emit(OP_LISTSET_LL, this.listSlot(p[0]), indexLocal, valueLocal);
                    this.optimize('local_list_set_superinstruction');
                    break;
                }
            }
                const idx = this.expr(p[1], scope);
                const src = this.expr(p[2], scope);
                em.emit(OP_LISTSET, this.listSlot(p[0]), idx, src);
                break;
            }
            case 'add_value_to_list': {
                const src = this.expr(p[0], scope);
                em.emit(OP_LISTPUSH, this.listSlot(p[1]), src);
                break;
            }
            case 'insert_value_to_list': {
                const src = this.expr(p[0], scope);
                const idx = this.expr(p[2], scope);
                em.emit(OP_LISTINS, this.listSlot(p[1]), idx, src);
                break;
            }
            case 'remove_value_from_list': {
                // params: [인덱스, 리스트, _] — add_value_to_list와 같은 순서다
                // (리스트가 **두 번째**). 뒤집으면 "null"이라는 유령 리스트가 생긴다.
                const idx = this.expr(p[0], scope);
                em.emit(OP_LISTDEL, this.listSlot(p[1]), idx);
                break;
            }
            case 'set_value_from_table': {
                const args = scope.next;
                scope.alloc(); scope.alloc(); scope.alloc();
                const row = this.expr(p[1], scope);
                const col = this.expr(p[2], scope);
                const value = this.expr(p[3], scope);
                if (row !== args) em.emit(OP_MOV, args, row);
                if (col !== args + 1) em.emit(OP_MOV, args + 1, col);
                if (value !== args + 2) em.emit(OP_MOV, args + 2, value);
                em.emit(OP_TABLESET, this.tableSlot(p[0]), args);
                break;
            }
            case 'append_row_to_table': {
                const property = String(p[1] ?? 'ROW').toUpperCase() === 'COL' ? 1 : 0;
                em.emit(OP_TABLEAPPEND, this.tableSlot(p[0]), property);
                break;
            }
            case 'set_value_from_cell': {
                const args = scope.next;
                scope.alloc(); scope.alloc();
                const cell = this.expr(p[1], scope);
                const value = this.expr(p[2], scope);
                if (cell !== args) em.emit(OP_MOV, args, cell);
                if (value !== args + 1) em.emit(OP_MOV, args + 1, value);
                em.emit(OP_TABLECELLSET, this.tableSlot(p[0]), args);
                break;
            }
            case 'insert_row_to_table':
            case 'delete_row_from_table': {
                const index = this.expr(p[1], scope);
                const property = String(p[2] ?? 'ROW').toUpperCase() === 'COL' ? 1 : 0;
                em.emit(type === 'insert_row_to_table' ? OP_TABLEINSERT : OP_TABLEDELETE,
                    this.tableSlot(p[0]), index, property);
                break;
            }
            case 'save_current_table':
                this.ignore(type);
                break;
            case 'open_table':
            case 'open_table_chart':
            case 'close_table_chart':
                em.emit(OP_TABLEVISIBLE, this.tableSlot(p[0]),
                    type === 'open_table' ? 1 : type === 'open_table_chart' ? 2 : 0);
                break;
            case 'open_table_wait': {
                this.ignore('open_table_wait:ui');
                if (staticNumber(p[1]) !== 0) em.emit(OP_SLEEP, this.expr(p[1], scope));
                else this.optimize('zero_wait');
                break;
            }
            case 'repeat_inf': {
                // L: 본문 ; YIELD ; JMP L   — 틱마다 본문 한 바퀴
                const top = em.pc;
                const loop = this._openLoop(top);
                this.statements(body[0], scope);
                em.emit(OP_YIELD);
                em.emit(OP_JMP, top);
                this._closeLoop(loop, em.pc);
                break;
            }
            case 'repeat_while_true': {
                // OPTION(p[1])은 'until' 또는 'while'이고 **기본값이 'until'**이다.
                // 엔진은 'until'일 때 조건을 뒤집는다(entry.js: `value = !value`).
                // 옵션을 무시하면 루프가 정반대로 돌거나 즉시 끝난다.
                const until = String(p[1] ?? 'until') !== 'while';
                const top = em.pc;
                const cond = this.expr(p[0], scope);
                const exit = em.emit(until ? OP_JNZ : OP_JZ, cond, 0);
                scope.release(mark);
                const loop = this._openLoop(top);
                this.statements(body[0], scope);
        if (this.legacyLoopYield && !hasDelayRemoval(body[0])) em.emit(OP_YIELD);
                em.emit(OP_JMP, top);
                em.patch(exit, 2, em.pc);
                this._closeLoop(loop, em.pc);
                break;
            }
            case 'repeat_basic': {
                // 횟수를 레지스터에 두고 센다. 엔트리는 반복마다 프레임을 양보하므로
                // 본문 끝에 YIELD가 들어간다 — 딜레이 제거 트릭이 있으면 빼야 하지만,
                // 그 판단은 컴파일 시점에 본문 마지막 블록을 보고 내린다.
                const counter = scope.alloc();
                const n = this.expr(p[0], scope);
                em.emit(OP_MOV, counter, n);
                const top = em.pc;
                const zero = scope.alloc();
                em.emit(OP_CONST, zero, em.constIdx(0));
                const cond = scope.alloc();
                em.emit(OP_GT, cond, counter, zero);
                const exit = em.emit(OP_JZ, cond, 0);
                const explicitFastLoop = hasDelayRemoval(body[0]);
                const dataLoop = isDataChunkLoop(p[0]);
                const sync = !this.legacyLoopYield || explicitFastLoop || dataLoop;
                if (sync && !explicitFastLoop) this.optimize('implicit_loop_yield_removed');
                // `반복 중단`은 세던 횟수를 버리고 나가고, `계속하기`는 **카운터를
                // 줄이는 자리로** 뛴다 — 루프 머리로 바로 뛰면 횟수가 줄지 않아
                // 무한 루프가 된다.
                const loop = this._openLoop(top);
                this.statements(body[0], scope);
                const continuePc = em.pc;
                const one = scope.alloc();
                em.emit(OP_CONST, one, em.constIdx(1));
                em.emit(OP_SUB, counter, counter, one);
                if (!sync) em.emit(OP_YIELD);
                em.emit(OP_JMP, top);
                em.patch(exit, 2, em.pc);
                this._closeLoop(loop, em.pc, continuePc);
                break;
            }
            case '_if': {
                const cond = this.expr(p[0], scope);
                const skip = em.emit(OP_JZ, cond, 0);
                scope.release(mark);
                this.statements(body[0], scope);
                em.patch(skip, 2, em.pc);
                break;
            }
            case 'if_else': {
                const cond = this.expr(p[0], scope);
                const toElse = em.emit(OP_JZ, cond, 0);
                scope.release(mark);
                this.statements(body[0], scope);
                const done = em.emit(OP_JMP, 0);
                em.patch(toElse, 2, em.pc);
                this.statements(body[1], scope);
                em.patch(done, 1, em.pc);
                break;
            }
            case 'wait_until_true': {
                // 딜레이 제거 트릭(continue_repeat가 조건에 박힌 꼴)은 반복 쪽에서
                // 이미 처리했다. 여기 남은 건 평범한 "될 때까지 기다리기"다.
                if (hasDelayRemoval([block])) break;
                // top: cond ; 참이면 exit ; 아니면 한 틱 쉬고 다시
                const top = em.pc;
                const cond = this.expr(p[0], scope);
                const exit = em.emit(OP_JNZ, cond, 0);
                scope.release(mark);
                em.emit(OP_YIELD);
                em.emit(OP_JMP, top);
                em.patch(exit, 2, em.pc);
                break;
            }
            case 'start_drawing': em.emit(OP_PENDOWN); break;
            case 'stop_drawing': em.emit(OP_PENUP); break;
            case 'brush_erase_all': em.emit(OP_ERASEALL); break;
            case 'brush_stamp': em.emit(OP_STAMP); break;
            case 'start_fill': em.emit(OP_FILLBEGIN); break;
            case 'stop_fill': em.emit(OP_FILLEND); break;
            // 선 색과 채우기 색은 엔진에서 별개 상태다(brush vs paint).
            case 'set_color':
            case 'set_fill_color': {
                const fill = type === 'set_fill_color';
                const value = p[0];
                // 슬롯에는 보통 `color` 블록이 들어 있고, 리터럴 문자열로 올 때도 있다.
                const literal = typeof value === 'string' ? value
                    : (isBlock(value) && value.type === 'color' ? (value.params || [])[0] : null);
                if (typeof literal === 'string') {
                    em.emit(fill ? OP_SETFILLCOLOR : OP_SETCOLOR, em.stringIdx(literal));
                } else {
                    const src = this.expr(value, scope);
                    em.emit(fill ? OP_SETFILLCOLORREG : OP_SETCOLORREG, src);
                }
                break;
            }
            case 'set_thickness': {
                const src = this.expr(p[0], scope);
                em.emit(OP_SETTHICK, src);
                break;
            }
            // change_thickness는 **상대** 변경이다(엔진: `brush.thickness += v`,
            // 최소 1 클램프). set과 같이 묶으면 굵기가 매번 리셋된다.
            case 'change_thickness': {
                const src = this.expr(p[0], scope);
                em.emit(OP_ADDTHICK, src);
                break;
            }
            case 'set_brush_tranparency': {     // 엔진 쪽 철자 그대로다(tranparency)
                const src = this.expr(p[0], scope);
                em.emit(OP_SETALPHA, src);
                break;
            }
            case 'set_random_color':
                em.emit(OP_RANDOMCOLOR);
                break;
            case 'change_brush_transparency': {
                const src = this.expr(p[0], scope);
                em.emit(OP_ADDALPHA, src);
                break;
            }
            case 'text_write': {
                const src = this.expr(p[0], scope);
                em.emit(OP_TEXTWRITE, src, this.currentObject);
                break;
            }
            case 'text_append':
            case 'text_prepend':
            case 'text_flush': {
                const src = type === 'text_flush' ? this.expr('', scope) : this.expr(p[0], scope);
                const mode = type === 'text_append' ? 0 : type === 'text_prepend' ? 1 : 2;
                em.emit(OP_TEXTMUTATE, this.currentObject, src, mode);
                break;
            }
            case 'text_change_font_color':
            case 'text_change_bg_color':
            case 'text_change_font':
            case 'text_change_effect': {
                const args = scope.next;
                scope.alloc(); scope.alloc();
                const value = this.expr(p[0] ?? '', scope);
                const mode = this.expr(p[1] ?? '', scope);
                if (value !== args) em.emit(OP_MOV, args, value);
                if (mode !== args + 1) em.emit(OP_MOV, args + 1, mode);
                const kind = type === 'text_change_font_color' ? 0
                    : type === 'text_change_bg_color' ? 1
                        : type === 'text_change_font' ? 2 : 3;
                em.emit(OP_TEXTSTYLE, this.currentObject, args, kind);
                break;
            }
            case 'locate_xy': {
                const x = this.expr(p[0], scope);
                const y = this.expr(p[1], scope);
                em.emit(OP_LOCATEXY, x, y);
                break;
            }
            case 'move_to_angle': {
                const angle = this.expr(p[0], scope);
                const distance = this.expr(p[1], scope);
                em.emit(OP_MOVEANGLE, angle, distance);
                break;
            }
            case 'bounce_wall':
                em.emit(OP_BOUNCE);
                break;
            case 'locate_object_time': {
                const args = scope.next;
                scope.alloc(); scope.alloc(); scope.alloc();
                const target = String(p[1] ?? 'mouse');
                if (target === 'mouse') {
                    em.emit(OP_LOADHOST, args, HOST_MOUSE_X);
                    em.emit(OP_LOADHOST, args + 1, HOST_MOUSE_Y);
                } else {
                    const objectIndex = this.stage.objects.findIndex((o) => o.id === target || o.name === target);
                    if (objectIndex < 0) { this.note(type); break; }
                    em.emit(OP_LOADENT, args, ENT_X, objectIndex);
                    em.emit(OP_LOADENT, args + 1, ENT_Y, objectIndex);
                }
                const duration = this.expr(p[0], scope);
                if (duration !== args + 2) em.emit(OP_MOV, args + 2, duration);
                em.emit(OP_GLIDEXY, args);
                break;
            }
            case 'rotate_by_time':
            case 'direction_relative_duration': {
                const args = scope.next;
                scope.alloc(); scope.alloc();
                const duration = this.expr(p[0], scope);
                const amount = this.expr(p[1], scope);
                if (duration !== args) em.emit(OP_MOV, args, duration);
                if (amount !== args + 1) em.emit(OP_MOV, args + 1, amount);
                em.emit(OP_TURNTIME, args, type === 'direction_relative_duration' ? 1 : 0);
                break;
            }
            case 'move_x': {
                const x = this.expr(p[0], scope);
                const zero = scope.alloc();
                em.emit(OP_CONST, zero, em.constIdx(0));
                em.emit(OP_MOVEXY, x, zero);
                break;
            }
            case 'move_y': {
                const zero = scope.alloc();
                em.emit(OP_CONST, zero, em.constIdx(0));
                const y = this.expr(p[0], scope);
                em.emit(OP_MOVEXY, zero, y);
                break;
            }
            case 'locate_x': {
                em.emit(OP_SETENTX, this.expr(p[0], scope));
                break;
            }
            case 'locate_y': {
                em.emit(OP_SETENTY, this.expr(p[0], scope));
                break;
            }
            // `이동 방향으로 N 움직이기` — 회전과 이동방향을 **더한** 쪽으로 간다
            // (엔진: `cos((rotation + direction - 90)°)`). 둘 중 하나만 쓰면
            // 회전시킨 오브젝트가 엉뚱한 쪽으로 걷는다.
            case 'move_direction': {
                em.emit(OP_MOVEDIR, this.expr(p[0], scope));
                break;
            }
            case 'rotate_absolute': {
                em.emit(OP_SETROT, this.expr(p[0], scope));
                break;
            }
            case 'rotate_relative': {
                em.emit(OP_ADDROT, this.expr(p[0], scope));
                break;
            }
            case 'direction_relative': {
                em.emit(OP_ADDDIR, this.expr(p[0], scope));
                break;
            }
            case 'direction_absolute': {
                em.emit(OP_SETDIR, this.expr(p[0], scope));
                break;
            }
            case 'set_scale_size': {
                em.emit(OP_SETSIZE, this.expr(p[0], scope));
                break;
            }
            case 'change_scale_size': {
                em.emit(OP_ADDSIZE, this.expr(p[0], scope));
                break;
            }
            case 'stretch_scale_size':
                em.emit(OP_STRETCH, String(p[0] ?? 'WIDTH').toUpperCase() === 'HEIGHT' ? 1 : 0,
                    this.expr(p[1], scope));
                break;
            case 'reset_scale_size':
                em.emit(OP_RESETSCALE);
                break;
            case 'hide':
            case 'show':
                em.emit(OP_SETVISIBLE, type === 'show' ? 1 : 0);
                break;
            // 효과는 엔진의 `sprite.effect`를 그대로 흉내낸다. 투명도만 단위가
            // 다르다(엔진은 `alpha = 1 - 값/100`으로 들고 있다) — 그 변환은 VM이 한다.
            case 'change_effect_amount':
            case 'add_effect_amount': {
                const effect = EFFECTS[String(p[0] ?? '').toLowerCase()];
                if (effect === undefined) { this.note(`${type}:${p[0]}`); break; }
                const src = this.expr(p[1], scope);
                em.emit(type === 'add_effect_amount' ? OP_ADDEFFECT : OP_SETEFFECT, effect, src);
                break;
            }
            case 'set_effect_volume': {
                // 구형 블록 이름이지만 동작은 현재의 "효과를 만큼 바꾸기"와 같다.
                const effect = EFFECTS[String(p[0] ?? '').toLowerCase()];
                if (effect === undefined) { this.note(`${type}:${p[0]}`); break; }
                em.emit(OP_ADDEFFECT, effect, this.expr(p[1], scope));
                break;
            }
            // 엔진의 블록 이름은 복수형 `erase_all_effects`다. 단수형은 예전
            // 작품에서 보이는 표기라 같이 받는다 — 틀린 이름 하나 때문에
            // "효과 지우기만 안 먹는" 작품이 되면 원인을 찾기 어렵다.
            case 'erase_all_effect':
            case 'erase_all_effects': {
                const zero = scope.alloc();
                em.emit(OP_CONST, zero, em.constIdx(0));
                em.emit(OP_SETEFFECT, EF_COLOR, zero);
                em.emit(OP_SETEFFECT, EF_BRIGHTNESS, zero);
                em.emit(OP_SETEFFECT, EF_TRANSPARENCY, zero);
                break;
            }
            case 'change_to_some_shape': {
                const idx = this._assetIndex(p[0], this._pictures);
                if (idx >= 0) em.emit(OP_SETSHAPE, idx);
                else em.emit(OP_SETSHAPE, -1, this.expr(p[0], scope));
                break;
            }
            // `N번째 모양으로 바꾸기`. 엔진은 `getPicture`를 그대로 쓰므로
            // id → 이름 → **1부터 세는 번호** 순으로 찾는다. 런타임 값일 수
            // 있어서 늘 b=src 경로로 보낸다(VM이 같은 순서로 찾는다).
            case 'change_to_nth_shape':
                em.emit(OP_SETSHAPE, -1, this.expr(p[0], scope));
                break;
            // 이름과 축이 반대다 — 엔진의 `flip_x`는 scaleY를 뒤집는다.
            case 'flip_x':
            case 'flip_y':
                em.emit(OP_FLIP, type === 'flip_x' ? 0 : 1);
                break;
            case 'change_to_next_shape':
                // 필드 이름의 철자가 엔진에서 `DRIECTION`이다(오타가 그대로 굳었다).
                // 바르게 적으면 항상 `next`로 읽혀 `이전 모양`이 조용히 안 먹는다.
                em.emit(OP_NEXTSHAPE, String(p[0] ?? 'next') === 'prev' ? -1 : 1);
                break;
            case 'create_clone': {
                // 'self'(-1)와 "그런 오브젝트 없음"을 같은 -1로 섞으면, 삭제된
                // 오브젝트를 복제하라는 코드가 조용히 **자기 복제**로 바뀐다.
                const target = String(p[0] ?? 'self');
                let objectIndex = -1;
                if (target !== 'self') {
                    objectIndex = this.stage.objects.findIndex((o) => o.id === target);
                    if (objectIndex < 0) { this.note(type); break; }
                }
                em.emit(OP_CLONE, objectIndex);
                this.emittedClone = true;
                break;
            }
            case 'delete_clone':
                em.emit(OP_DELETECLONE);
                break;
            case 'remove_all_clones':
                em.emit(OP_CLEARCLONES, -1);
                break;
            case 'wait_second': {
                if (staticNumber(p[0]) === 0) {
                    this.optimize('zero_wait');
                    // Entry still yields one executor frame for `0초 기다리기`.
                    // Removing the block makes a repeat_inf body run twice as often
                    // when it also reaches the loop's own frame boundary.
                    if (this.legacyLoopYield && !this.isDataIntensive) em.emit(OP_YIELD);
                    break;
                }
                em.emit(OP_SLEEP, this.expr(p[0], scope));
                break;
            }
            // 소리 재생 10종. 이름이 다 다르지만 모양은 셋뿐이다 — 그냥 재생,
            // N초 재생, A초부터 B초까지. 각각 "기다리는 판"이 따로 있다.
            // `_with_block`은 소리 칸이 드롭다운이 아니라 블록 슬롯인 판이고,
            // 의미는 같다. 이름 하나를 빼먹으면 그 작품의 소리만 조용히 안 난다.
            case 'sound_something':
            case 'sound_something_with_block':
            case 'sound_something_wait':
            case 'sound_something_wait_with_block':
            case 'sound_something_second':
            case 'sound_something_second_with_block':
            case 'sound_something_second_wait':
            case 'sound_something_second_wait_with_block':
            case 'sound_from_to':
            case 'sound_from_to_and_wait': {
                let flags = /_wait/.test(type) ? SND_WAIT : 0;
                if (/_second/.test(type)) flags |= SND_SECOND;
                else if (/^sound_from_to/.test(type)) flags |= SND_FROMTO | (type === 'sound_from_to_and_wait' ? SND_WAIT : 0);
                // 묶음 세 칸을 **붙여서** 잡는다(ISA 쪽 주석 참고).
                const idx = this._assetIndex(p[0], this._sounds);
                const name = idx >= 0 ? null : this.expr(p[0], scope);
                const arg1 = (flags & (SND_SECOND | SND_FROMTO)) ? this.expr(p[1], scope) : null;
                const arg2 = (flags & SND_FROMTO) ? this.expr(p[2], scope) : null;
                const b0 = scope.alloc();
                const b1 = scope.alloc();
                const b2 = scope.alloc();
                if (name !== null) em.emit(OP_MOV, b0, name);
                if (arg1 !== null) em.emit(OP_MOV, b1, arg1);
                if (arg2 !== null) em.emit(OP_MOV, b2, arg2);
                em.emit(OP_PLAYSOUND, idx, b0, flags);
                break;
            }
            case 'sound_silent_all':
                em.emit(OP_STOPSOUND, String(p[0] ?? 'all') === 'thisOnly' ? 1 : 0);
                break;
            case 'play_bgm': {
                const idx = this._assetIndex(p[0], this._sounds);
                const name = idx >= 0 ? scope.alloc() : this.expr(p[0], scope);
                em.emit(OP_BGM, idx, name);
                break;
            }
            case 'stop_bgm':
                em.emit(OP_STOPBGM);
                break;
            case 'sound_volume_set':
            case 'sound_volume_change': {
                const src = this.expr(p[0], scope);
                em.emit(OP_VOLUME, src, type === 'sound_volume_change' ? 1 : 0);
                break;
            }
            case 'sound_speed_set':
            case 'sound_speed_change': {
                const src = this.expr(p[0], scope);
                em.emit(OP_SPEED, src, type === 'sound_speed_change' ? 1 : 0);
                break;
            }
            case 'message_cast': {
                em.emit(OP_BROADCAST, this.messageSlot(p[0]));
                break;
            }
            case 'message_cast_wait':
                em.emit(OP_BROADCASTWAIT, this.messageSlot(p[0]));
                break;

            // ── 무대·장면·대화·질문 ───────────────────────────────────
            // 여기부터는 "엔트리에 맡기면 되는" 블록들이 아니다. 한 블록이라도
            // 엔진으로 넘기면 그 작품은 엔진 속도로 떨어지므로 VM에서 직접 한다.
            case 'change_object_index': {
                const where = ZORDER_LOCATIONS[String(p[0] ?? '').toUpperCase()];
                if (where === undefined) { this.note(`${type}:${p[0]}`); break; }
                em.emit(OP_SETINDEX, where);
                break;
            }
            case 'start_scene': {
                // 드롭다운 값은 **장면 id**다. 목록에 없는 id면 엔진도 아무 일을
                // 하지 않는다(`getSceneById`가 비면 블록을 건너뛴다) — 그래도
                // 미지원으로 세어 둔다. 지워진 장면을 가리키는 작품은 사람이
                // 알아야 하고, 조용히 넘기면 "왜 장면이 안 바뀌나"가 된다.
                let idx = this.stage.scenes.findIndex((s) => s.id === String(p[0] ?? ''));
                // 오래된 온라인 작품은 scene 목록 없이 지워진 장면 id만 블록에
                // 남아 있기도 한다. 실제 장면이 하나뿐이면 그 장면을 다시 시작하는
                // 뜻으로 해석할 수 있고, 이를 미지원 블록으로 표시할 이유도 없다.
                if (idx < 0 && this.stage.scenes.length === 1) idx = 0;
                if (idx < 0) { this.note(`${type}:${p[0]}`); break; }
                em.emit(OP_STARTSCENE, idx);
                break;
            }
            case 'start_neighbor_scene':
                em.emit(OP_NEIGHBORSCENE, String(p[0] ?? 'next') === 'prev' ? -1 : 1);
                break;
            case 'locate':
            case 'see_angle_object': {
                const target = String(p[0] ?? 'mouse');
                let objectIndex = -1;
                if (target !== 'mouse') {
                    objectIndex = this.stage.objects.findIndex((o) => o.id === target || o.name === target);
                    if (objectIndex < 0) { this.ignore(type); break; }
                }
                if (type === 'see_angle_object') em.emit(OP_POINTTO, objectIndex);
                else if (objectIndex < 0) {
                    const x = scope.alloc(), y = scope.alloc();
                    em.emit(OP_LOADHOST, x, HOST_MOUSE_X);
                    em.emit(OP_LOADHOST, y, HOST_MOUSE_Y);
                    em.emit(OP_LOCATEXY, x, y);
                } else {
                    const x = scope.alloc(), y = scope.alloc();
                    em.emit(OP_LOADENT, x, ENT_X, objectIndex);
                    em.emit(OP_LOADENT, y, ENT_Y, objectIndex);
                    em.emit(OP_LOCATEXY, x, y);
                }
                break;
            }
            case 'move_xy_time': {
                const slot = scope.next;
                scope.alloc(); scope.alloc(); scope.alloc();
                const currentX = scope.alloc(), currentY = scope.alloc();
                em.emit(OP_LOADENT, currentX, ENT_X, -1);
                em.emit(OP_LOADENT, currentY, ENT_Y, -1);
                const dx = this.expr(p[1], scope), dy = this.expr(p[2], scope);
                em.emit(OP_ADD, slot, currentX, dx);
                em.emit(OP_ADD, slot + 1, currentY, dy);
                const sec = this.expr(p[0], scope);
                if (sec !== slot + 2) em.emit(OP_MOV, slot + 2, sec);
                em.emit(OP_GLIDEXY, slot);
                break;
            }
            case 'locate_xy_time': {
                // x, y, 초를 **연속한 세 레지스터**에 둔다. 여러 틱에 걸쳐 같은
                // 명령으로 되돌아오므로(OP_GLIDEXY가 pc를 되돌린다) 목표값이
                // 그동안 제자리에 있어야 한다.
                //
                // 엔진 paramsKeyMap은 VALUE1=초, VALUE2=x, VALUE3=y다 — 순서가
                // 블록에 보이는 대로가 아니라서, 뒤집으면 "2초 동안 (3,5)로"가
                // "3초 동안 (5,2)로"가 된다.
                const slot = scope.next;
                scope.alloc(); scope.alloc(); scope.alloc();
                const sec = this.expr(p[0], scope);
                const x = this.expr(p[1], scope);
                const y = this.expr(p[2], scope);
                if (x !== slot) em.emit(OP_MOV, slot, x);
                if (y !== slot + 1) em.emit(OP_MOV, slot + 1, y);
                if (sec !== slot + 2) em.emit(OP_MOV, slot + 2, sec);
                em.emit(OP_GLIDEXY, slot);
                break;
            }
            case 'dialog': {
                const src = this.expr(p[0], scope);
                const mode = String(p[1] ?? 'speak') === 'think' ? DIALOG_THINK : DIALOG_SPEAK;
                em.emit(OP_DIALOG, src, mode);
                break;
            }
            case 'dialog_time': {
                const src = this.expr(p[0], scope);
                const mode = String(p[2] ?? 'speak') === 'think' ? DIALOG_THINK : DIALOG_SPEAK;
                em.emit(OP_DIALOG, src, mode);
                const seconds = this.expr(p[1], scope);
                em.emit(OP_SLEEP, seconds);
                em.emit(OP_DIALOG, -1, DIALOG_REMOVE);
                break;
            }
            case 'remove_dialog':
                em.emit(OP_DIALOG, -1, DIALOG_REMOVE);
                break;
            case 'choose_project_timer_action': {
                const action = TIMER_ACTIONS[String(p[1] ?? '').toUpperCase()];
                if (action === undefined) { this.note(`${type}:${p[1]}`); break; }
                em.emit(OP_TIMERACT, action);
                break;
            }
            case 'reset_project_timer':
                em.emit(OP_TIMERACT, TIMER_RESET);
                break;
            case 'ask_and_wait': {
                const src = this.expr(p[0], scope);
                em.emit(OP_ASK, src);
                break;
            }
            // 대답·초시계 창을 띄우고 감추는 블록. 무대에 그리는 게 전부다.
            case 'set_visible_answer':
            case 'set_visible_project_timer':
                this.ignore(type);
                break;
            case 'show_variable':
            case 'hide_variable':
                em.emit(OP_SETVARVISIBLE, this.varSlot(p[0]), 0,
                    type === 'show_variable' ? 1 : 0);
                break;
            case 'show_list':
            case 'hide_list':
                em.emit(OP_SETVARVISIBLE, this.listSlot(p[0]), 1,
                    type === 'show_list' ? 1 : 0);
                break;
            // 편집기에서만 존재하는 생성/속성/교육용 메타 블록. 작품 실행 중에는
            // 부작용이 없지만 타입을 명시해 미지원 경고와 구분한다.
            case 'analizyDataAddButton':
            case 'variableAddButton':
            case 'listAddButton':
            case 'messageAddButton':
            case 'functionAddButton':
            case 'function_name':
            case 'showFunctionPropsButton':
            case 'function_create':
            case 'function_create_value':
            case 'function_field_label':
            case 'function_field_string':
            case 'function_field_boolean':
            case 'function_param_string':
            case 'function_param_boolean':
            case 'check_object_property':
            case 'check_block_execution':
            case 'switch_scope':
            case 'is_answer_submited':
            case 'check_lecture_goal':
            case 'check_variable_by_name':
            case 'show_prompt':
            case 'check_goal_success':
            case 'register_score':
                this.ignore(type);
                break;
            case 'stop_repeat':
            case 'continue_repeat': {
                const loop = this.loops[this.loops.length - 1];
                // 루프 밖의 `반복 중단`은 엔트리에서도 아무 일도 하지 않는다.
                // 여기서 미지원으로 세면 멀쩡한 작품이 관문에 걸린다.
                if (!loop) { this.ignore(type); break; }
                const at = em.emit(OP_JMP, 0);
                (type === 'stop_repeat' ? loop.breaks : loop.continues).push(at);
                break;
            }
            case 'stop_object': {
                const modes = { all: 0, thisOnly: 1, thisThread: 2, otherThread: 3, other_objects: 4 };
                const mode = modes[String(p[0] ?? 'all')];
                if (mode === undefined) this.note(`${type}:${p[0]}`);
        else if (mode === 2 && this.functionExitPatches) {
          this.functionExitPatches.push(em.emit(OP_JMP, 0));
        } else em.emit(OP_STOP, mode);
                break;
            }
            case 'restart_project':
                em.emit(OP_RESTART);
                break;
            default: {
                if (type.startsWith('func_')) { this.call(block, scope, false); break; }
                // 요청 범위 밖의 확장/AI/하드웨어 문장은 유령 블록으로 건너뛴다.
                // 뒤의 명령은 계속 컴파일한다.
                this.ignore(type);
                break;
            }
        }
        scope.release(mark);
    }

    // ── 전체 ────────────────────────────────────────────────────────────
    compile() {
        const em = this.em;
        const project = this.project;

        // 1) 변수·리스트·테이블을 먼저 등록해 초기값을 보존한다.
        for (const v of project.variables || []) {
            if (v && v.variableType === 'list') {
                const id = v.id === undefined || v.id === null ? '' : String(v.id);
                const name = String(v.name ?? id);
                const idx = this.listSlot(id || name);
                // Entry block parameters normally store the stable variable id while
                // hand-written/older projects can store the display name. They are
                // two aliases for one slot, not two independent lists.
                if (id) this.listIndex.set(id, idx);
                if (name) this.listIndex.set(name, idx);
                this.lists[idx].id = id;
                this.lists[idx].name = name;
                this.lists[idx].initial = (v.array || []).map((e) => (e && e.data !== undefined ? e.data : e));
                this.lists[idx].visible = v.visible === true;
                this.lists[idx].x = Number(v.x) || 0;
                this.lists[idx].y = Number(v.y) || 0;
            } else if (v) {
                const id = v.id === undefined || v.id === null ? '' : String(v.id);
                const name = String(v.name ?? id);
                const idx = this.varSlot(id || name);
                // The real Entry JSON declares {id, name}, then references `id` in
                // set/change/get blocks. Keep both spellings on the same VM cell.
                if (id) this.varIndex.set(id, idx);
                if (name) this.varIndex.set(name, idx);
                this.vars[idx].id = id;
                this.vars[idx].name = name;
                this.vars[idx].initial = v.value === undefined ? 0 : v.value;
            this.vars[idx].visible = v.visible === true;
            this.vars[idx].x = Number(v.x) || 0;
            this.vars[idx].y = Number(v.y) || 0;
            const owner = v.object === undefined || v.object === null
                ? -1
                : this.stage.objects.findIndex((object) => object.id === String(v.object));
            this.vars[idx].ownerObject = owner;
                this.vars[idx].hostSlot = owner < 0 ? hostSlotOf(name) : undefined;
                // `IsEniwanVM`은 선언돼 있으면 **값까지 1로 바꿔 둔다.**
                //
                // 읽기는 어차피 호스트 슬롯으로 돌아가므로 실행에는 영향이 없다.
                // 그런데 변수 목록을 그대로 비춰 주는 쪽(대시보드 변수 패널, 검증
                // 스크립트)에서 같은 이름이 0으로 보이면 "확장이 안 켜졌나"로 읽힌다.
                // 한 이름이 두 값을 갖지 않게 여기서 맞춘다.
                if (hostSlotOf(name) === HOST_IS_ENIWAN) this.vars[idx].initial = 1;
            }
        }

        for (const source of project.tables || []) {
            if (!source) continue;
            const id = String(source.id ?? source._id ?? source.name ?? '');
            const idx = this.tableSlot(id);
            const fields = Array.isArray(source.fields) ? source.fields.slice() : [];
            const data = Array.isArray(source.data) ? source.data : [];
            this.tables[idx] = {
                id,
                name: String(source.name ?? id),
                fields,
                rows: data.map((row) => {
                    const values = row && Array.isArray(row.value) ? row.value : row;
                    return Array.isArray(values) ? values.slice() : [];
                }),
            };
        }

        // 2) 함수 서명을 **본문보다 먼저** 전부 등록한다. 상호 재귀가 있으면
        //    호출이 정의보다 앞서 나오므로, 서명이 없으면 미지원으로 떨어진다.
        const fns = (project.functions || []).filter((f) => f && f.id);
        for (const fn of fns) {
            const head = functionHead(fn);
            const params = head ? functionParamIds(head) : [];
            // 함수 지역변수는 **인자 바로 위 레지스터**에 깐다. 엔진이 호출마다
            // localVariables를 깊은 복사해 그 호출만의 사물함으로 쓰는데, 우리
            // 프레임도 호출마다 새 자리(슬라이딩 윈도우)라 성질이 그대로 맞는다
            // — 재귀도 서로의 지역변수를 못 본다.
            const declared = (Array.isArray(fn.localVariables) ? fn.localVariables : [])
                .filter((v) => v && v.id !== undefined);
            const localSlots = new Map();
            const locals = [];
            declared.forEach((v, k) => {
                const slot = params.length + k;
                localSlots.set(String(v.id), slot);
                locals.push({ slot, value: v.value });
            });
            this.funcIndex.set(String(fn.id), this.functions.length);
            this.functions.push({
                name: String(fn.id), params, arity: params.length,
                locals, localSlots,
                pc: -1, frameSize: 0,
            });
        }

        // 3) 함수 본문 컴파일
        fns.forEach((fn, i) => {
            const meta = this.functions[i];
            const scope = new Scope(meta.arity + meta.locals.length);
            scope.params = meta.params;
            scope.locals = meta.localSlots;
            meta.pc = em.pc;
            // 지역변수는 **들어올 때마다** 선언 초기값으로 되돌린다. 슬라이딩
            // 윈도우라 그 자리에는 앞선 호출이 쓰고 간 값이 남아 있다 — 초기화를
            // 빼면 "두 번째 호출부터 결과가 달라지는" 종류의 버그가 된다.
            for (const local of meta.locals) {
                const v = local.value;
                if (typeof v === 'number') {
                    em.emit(OP_CONST, local.slot, em.constIdx(v));
                } else em.emit(OP_CONSTSTR, local.slot, em.stringIdx(String(v ?? '')));
            }
            const { bodies, returnExpr } = functionShape(fn);
            const previousFunctionExitPatches = this.functionExitPatches;
            this.functionExitPatches = [];
            for (const bodyList of bodies) this.statements(bodyList, scope);
            const returnPc = em.pc;
            for (const at of this.functionExitPatches) em.patch(at, 1, returnPc);
            this.functionExitPatches = previousFunctionExitPatches;
            if (returnExpr !== null && returnExpr !== undefined) {
                const mark = scope.mark();
                const src = this.expr(returnExpr, scope);
                em.emit(OP_RET, src);
                scope.release(mark);
            } else {
                em.emit(OP_RET, -1);
            }
            meta.frameSize = Math.max(scope.high, meta.arity + 1);
        });

        // Generate structured JavaScript only after every function signature
        // and bytecode body exists. Cross-function calls can then be resolved
        // without depending on the order Entry serialized the functions in.
        fns.forEach((fn, index) => {
            const meta = this.functions[index];
            const product = compileStructuredFunction(fn, meta, {
                variable: (id) => this._hostSlot(id) === undefined ? this.varSlot(id) : null,
                list: (id) => this.listSlot(id),
                object: (id) => this.stage.objects.findIndex((object) => object.id === id),
                function: (id) => {
                    const targetIndex = this.funcIndex.get(String(id));
                    if (targetIndex === undefined) return null;
                    return { index: targetIndex, arity: this.functions[targetIndex].arity };
                },
            });
            meta.nativeSource = product?.source ?? null;
            meta.nativeDependencies = product?.dependencies ?? [];
            meta.nativeRecursive = product?.recursive ?? false;
            meta.nativeExtended = product?.extended ?? false;
            meta.nativeLoop = product?.nativeLoop ?? false;
        });

        // 4) 오브젝트 스레드
        (project.objects || []).forEach((object, objectIndex) => {
            this.currentObject = objectIndex;
            this.currentObjectIsText = object.objectType === 'textBox';
            for (const thread of object.script || []) {
                if (!Array.isArray(thread) || thread.length === 0) continue;
                const hat = thread[0];
                // Entry also serializes disconnected workspace blocks as
                // threads. Only event hats are executable entry points.
                if (!isBlock(hat) || !(hat.type.startsWith('when_')
                    || hat.type === 'mouse_clicked' || hat.type === 'mouse_click_cancled')) continue;
                const scope = new Scope(0);
                scope.params = [];
                const pc = em.pc;
                this.statements(thread.slice(1), scope);
                em.emit(OP_HALT);
                this.threads.push({
                    objectIndex,
                    objectName: object.name || `object${objectIndex}`,
                    event: hat.type,
                    // 신호(`when_message_cast`)는 **어느 신호인가**까지 맞아야 깨어난다.
                    // 이름을 안 들고 있으면 신호 하나가 모든 신호 스레드를 깨운다.
                    arg: hat.type === 'when_message_cast'
                        ? this.messageSlot((hat.params || [])[1])
                        : hat.type === 'when_some_key_pressed'
                            ? Number((hat.params || [])[1]) || 0 : -1,
                    pc,
                    frameSize: Math.max(scope.high, 1),
                });
            }
        });

        const frameSize = Math.max(
            1,
            ...this.functions.map((f) => f.frameSize),
            ...this.threads.map((t) => t.frameSize),
        );
        if (frameSize > this.maxRegisters) {
            throw new Error(`EniwanVM 컴파일: 프레임 레지스터 ${frameSize}개가 상한 ${this.maxRegisters}을 넘는다`);
        }

        const unsupported = [...this.unsupported.entries()]
            .map(([type, count]) => ({ type, count }))
            .sort((a, b) => b.count - a.count);
        const ignored = [...this.ignored.entries()]
            .map(([type, count]) => ({ type, count }))
            .sort((a, b) => b.count - a.count);
        const optimizations = [...this.optimized.entries()]
            .map(([type, count]) => ({ type, count }))
            .sort((a, b) => b.count - a.count);

        return {
            code: Int32Array.from(em.code),
            consts: Float64Array.from(em.consts),
            strings: em.strings.slice(),
            vars: this.vars,
            lists: this.lists,
            tables: this.tables,
            functions: this.functions,
            threads: this.threads,
            frameSize,
            instructionCount: em.pc,
            unsupported,
            unsupportedTotal: unsupported.reduce((a, u) => a + u.count, 0),
            // 일부러 넘긴 블록(꾸밈 전용). 관문 판정에는 안 쓰고, 보고에만 쓴다.
            ignored,
            ignoredTotal: ignored.reduce((a, u) => a + u.count, 0),
            optimizations,
            optimizedTotal: optimizations.reduce((a, u) => a + u.count, 0),
            // 오브젝트의 처음 상태 + 모양·소리 주소. VM이 엔티티 표를 여기서 만들고,
            // 호스트가 텍스처·오디오를 여기 적힌 주소로 받아 온다.
            objects: this.stage.objects,
            // 장면 목록. VM이 "지금 어느 장면인가"를 들고, `장면 시작하기`가 이
            // 목록의 번호로 갈아탄다.
            scenes: this.stage.scenes,
            messages: [...this.messageIndex.keys()],
            // 복제본을 만드는 작품인가 — 호스트가 엔티티 풀 크기를 고를 근거다.
            usesClones: this.emittedClone
                || this.threads.some((t) => t.event === 'when_clone_start'),
            // 호스트가 이 작품에 어떤 확장을 붙여야 하는지 판정하는 근거.
            // 호스트는 작품 이름이나 사용자 질문이 아니라 이걸 본다.
            usedHostSlots: [...this.usedHostSlots].sort((x, y) => x - y),
            usesTessVM: this.usesTessVM || this.usedHostSlots.has(HOST_IS_TESSVM)
                || this.messageIndex.has('$SCROLL'),
            usesRelativeMouse: this.usedHostSlots.has(HOST_MOUSE_DX)
                || this.usedHostSlots.has(HOST_MOUSE_DY),
            usesDepthBuffer: this.usedHostSlots.has(HOST_DEPTH)
                || this.usedHostSlots.has(HOST_DEPTH_TEST),
            // 호스트는 **쓰는 작품에만** 그 통로를 연다. 쓰지도 않는 작품의 붙여넣기를
            // 가로채거나 커서를 건드리면, 페이지에서 벌어지는 다른 일을 망친다.
            usesClipboard: this.usedHostSlots.has(HOST_CLIPBOARD),
            usesCursor: this.usedHostSlots.has(HOST_CURSOR),
            // 닉네임을 묻는 작품만 사용자 정보를 받아 온다. 안 쓰는 작품까지
            // 물으면 켜 두기만 해도 로그인 정보를 긁는 확장이 된다.
            usesNickname: this.usedHostSlots.has(HOST_NICKNAME),
            usesPointerLock: this.usedHostSlots.has(HOST_POINTER_LOCKED),
            // Per-pixel costume masks are only useful to Entry's touching reporter.
            usesTouching: this.usesTouching,
        };
    }
}

/** `boolean_not(continue_repeat())`라는 정확한 프레임 스킵 표식인가. */
function isFrameSkipMarker(node) {
    return isBlock(node) && node.type === 'boolean_not'
        && (node.params || []).some((child) => isBlock(child) && child.type === 'continue_repeat');
}

/** 파라미터 트리 안에 프레임 스킵 표식이 있는가. statement body는 별도로 검사한다. */
function containsFrameSkipMarker(node) {
    if (!isBlock(node)) return false;
    if (isFrameSkipMarker(node)) return true;
    return (node.params || []).some((child) => containsFrameSkipMarker(child));
}

/** 표식을 파라미터로 운반하는 바깥 statement. 호스트 블록 종류는 제한하지 않는다. */
function isFrameSkipCarrier(block) {
    return isBlock(block) && (block.params || []).some((param) => containsFrameSkipMarker(param));
}

/** 반복 본문의 직접 자식 중 프레임 스킵 운반체가 있는가. */
function hasDelayRemoval(body) {
    return (body || []).some((block) => isFrameSkipCarrier(block));
}

/** 컴파일 시 확정할 수 있는 숫자 리터럴. 동적 표현식은 null이다. */
function staticNumber(node) {
    if (typeof node === 'number' && Number.isFinite(node)) return node;
    if (typeof node === 'string' && node.trim() !== '' && Number.isFinite(Number(node))) {
        return Number(node);
    }
    if (isBlock(node) && node.type === 'number') return staticNumber((node.params || [])[0]);
    return null;
}

/** 3D OBJ 모델 문자열 등 대용량 정점/지오메트리 에셋을 포함하는 프로젝트인가. */
function isDataIntensiveProject(project) {
    if (!project) return false;
    const vars = project.variables || [];
    for (const v of vars) {
        if (v.variableType === 'list') {
            const arr = Array.isArray(v.array) ? v.array : [];
            for (const item of arr) {
                const t = typeof item === 'object' && item !== null ? String(item.data ?? '') : String(item ?? '');
                if (t.length > 5000 && /(?:^|\s)v\s/.test(t) && /(?:^|\s)f\s/.test(t)) return true;
            }
        }
    }
    const lists = project.lists || [];
    for (const l of lists) {
        for (const item of l.initial || []) {
            const t = String(item ?? '');
            if (t.length > 5000 && /(?:^|\s)v\s/.test(t) && /(?:^|\s)f\s/.test(t)) return true;
        }
    }
    return false;
}

/** 대용량 문자열/리스트를 일정 단위(청크)로 쪼개어 정점/데이터를 적재하는 루프인가. */
function isDataChunkLoop(node) {
    if (!node || typeof node !== 'object') return false;
    let hasLen = false;
    let hasChunk = false;
    function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'length_of_string' || n.type === 'length_of_list') hasLen = true;
        if (n.type === 'quotient_and_mod' || (n.type === 'calc_basic' && (n.params || []).includes('DIVIDE'))) hasChunk = true;
        for (const param of n.params || []) walk(param);
        for (const s of n.statements || []) for (const b of s || []) walk(b);
    }
    walk(node);
    return hasLen && hasChunk;
}

/** 편의 함수 — 파싱된 project.json을 프로그램으로. */
export function compileProject(project, options) {
    return new Compiler(project, options).compile();
}

export default compileProject;
