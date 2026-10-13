/* 이 파일은 public/eniwanvm/vm-core.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
/**
 * EniwanVM 3단계 — 레지스터 머신 + 스케줄러.
 *
 * 핵심 성질: **한 틱에 객체를 하나도 만들지 않는다.** pc·레지스터·콜스택이 모두
 * 미리 잡아 둔 TypedArray 안에 있어서 GC가 끼어들 틈이 없다. 엔트리 엔진이
 * 블록마다 실행 컨텍스트를 할당하던 비용(그리고 그로 인한 프레임 튐)이 사라진다.
 *
 * 디스패치는 하나의 `switch`다. V8은 밀집한 정수 case를 점프 테이블로 내리므로,
 * 옵코드 번호를 띄워 두긴 했어도 구간별로 뭉쳐 있어 분기 예측이 잘 먹는다.
 *
 * 숫자와 문자를 **따로** 들고 다닌다(`regNum` + `regStr` + `regTag`). 전부 한
 * 배열에 섞으면 V8의 요소 종류가 깨져 산술 경로가 느려진다 — 색 문자열 하나 때문에
 * 기하 계산 전체가 느려지는 걸 피하려는 설계다.
 */

import {
    INSTR_WORDS,
    OP_HALT, OP_YIELD, OP_JMP, OP_JZ, OP_JNZ, OP_CALL, OP_RET,
    OP_CONST, OP_CONSTSTR, OP_MOV, OP_LOADVAR, OP_STOREVAR, OP_ADDVAR, OP_LOADHOST,
    OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MOD, OP_QUOT, OP_UNARY, OP_ATAN2, OP_RAND, OP_CONCAT,
    OP_LT, OP_GT, OP_EQ, OP_NE, OP_LE, OP_GE, OP_AND, OP_OR, OP_NOT,
    OP_LISTGET, OP_LISTSET, OP_LISTLEN, OP_LISTPUSH, OP_LISTINS, OP_LISTDEL, OP_LISTCLEAR,
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
    HOST_DEPTH, HOST_DEPTH_TEST, HOST_SLOTS, HOST_CONSUME_ON_READ,
    HOST_IS_ENIWAN, HOST_IS_TESSVM, HOST_SCROLL_X, HOST_CURSOR,
    HOST_IS_STRING, HOST_WRITE_ACTIONS,
    OP_SETENTX, OP_SETENTY, OP_MOVEDIR, OP_SETROT, OP_ADDROT, OP_SETDIR, OP_ADDDIR,
    OP_SETSIZE, OP_ADDSIZE, OP_SETVISIBLE, OP_SETEFFECT, OP_ADDEFFECT,
    OP_SETSHAPE, OP_NEXTSHAPE, OP_FLIP, OP_LOADENT, OP_LOADLOCAL,
    OP_CLONE, OP_DELETECLONE, OP_CLEARCLONES, OP_SLEEP,
    OP_PLAYSOUND, OP_STOPSOUND, OP_VOLUME, OP_BROADCAST,
    SND_WAIT, SND_SECOND, SND_FROMTO,
    OP_INLIST, OP_CHARAT, OP_STRLEN, OP_STRIDX, OP_SUBSTR, OP_REPLACE,
    OP_STRCASE, OP_STRREV,
    OP_DATE, OP_TIMERACT, OP_SETINDEX, OP_GLIDEXY, OP_DIALOG, OP_ASK, OP_STARTSCENE,
    OP_TABLECOUNT, OP_TABLEGET, OP_TABLESET, OP_TABLEAPPEND,
    OP_TABLEINSERT, OP_TABLEDELETE, OP_TABLECALC, OP_TABLECELLGET, OP_TABLECELLSET,
    OP_SOUNDSTATE, OP_SPEED,
    OP_TEXTREAD, OP_TEXTMUTATE, OP_TEXTSTYLE,
    OP_STOP, OP_RESTART,
    OP_STRETCH, OP_RESETSCALE, OP_RANDOMCOLOR, OP_RGBHEX, OP_HEXRGB,
    OP_SETVARVISIBLE, OP_STRCOUNT, OP_ISTYPE, OP_DISTANCE, OP_TOUCHING,
    OP_MOVEANGLE, OP_BOUNCE, OP_TURNTIME,
    OP_SUB_LL, OP_MUL_LL, OP_DIV_LL, OP_MOD_LL, OP_QUOT_LL,
    OP_LT_LL, OP_GT_LL, OP_LE_LL, OP_GE_LL, OP_LISTGET_L, OP_LISTSET_LL,
    DATE_YEAR, DATE_MONTH, DATE_DAY, DATE_HOUR, DATE_MINUTE, DATE_SECOND, DATE_DAY_OF_WEEK,
    TIMER_START, TIMER_STOP, TIMER_RESET,
    ZORDER_FRONT, ZORDER_FORWARD, ZORDER_BACKWARD, ZORDER_BACK,
    DIALOG_THINK, DIALOG_REMOVE,
    HOST_ASK, HOST_ANSWER, HOST_NICKNAME,
    EF_COLOR, EF_BRIGHTNESS, EF_TRANSPARENCY,
    ENT_X, ENT_Y, ENT_ROTATION, ENT_DIRECTION, ENT_SIZE, ENT_PICTURE_INDEX, ENT_PICTURE_NAME,
    OP_NAMES,
} from './isa.js';
import { buildNativeFunctions } from './native-tier.js';

const TAG_NUM = 0;
const TAG_STR = 1;

/**
 * 문자 호스트 슬롯에 담기는 글자 수 상한.
 *
 * 클립보드는 **작품이 쓰는 값이 브라우저 밖으로 나가는** 유일한 통로다. 상한이
 * 없으면 반복 안에서 리스트를 이어 붙이는 흔한 코드 하나가 수십 MB를 밀어 넣고,
 * 그걸 받는 쪽(클립보드 API)은 메인 스레드에서 멈춰 선다. 1MB면 사람이 복사해
 * 쓸 어떤 글보다 넉넉하다.
 */
const HOST_TEXT_MAX = 1024 * 1024;
// 작품 안의 문자열도 같은 상한을 둔다. 반복문에서 문자열을 두 배씩 붙이는
// 작품은 JS 엔진 한계에 닿기 전에 `Invalid string length`로 런타임 전체를
// 멈출 수 있다. 1 MiB면 엔트리의 글상자·리스트·클립보드 용도로 충분하다.
export const VM_TEXT_MAX = 1024 * 1024;
const DEG = Math.PI / 180;
const SQRT3 = Math.sqrt(3);
const ENTRY_NUMBER_RE = /^-?\d+\.?\d*(?:[eE][+-]?\d+)?$/;

function isEntryNumber(value) {
    return typeof value === 'number'
        || (typeof value === 'string' && ENTRY_NUMBER_RE.test(value));
}

/** Entry Scope.getNumberValue uses parseFloat(value) || 0. */
function entryNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : 0;
}

function entryDecimalPlaces(value) {
    const text = String(value);
    const point = text.indexOf('.');
    return point < 0 ? 0 : Math.min(20, text.length - point - 1);
}

/** Entry's change_variable either performs decimal addition or concatenates. */
function entryChangedValue(current, delta) {
    if (!isEntryNumber(current) || !isEntryNumber(delta)) return boundedConcat(current, delta);
    const fixed = Math.max(entryDecimalPlaces(current), entryDecimalPlaces(delta));
    const sum = entryNumber(current) + entryNumber(delta);
    return Number.isFinite(sum) ? sum.toFixed(fixed) : '0';
}

/**
 * 엔진의 `Entry.preciseTrig` 테이블. 특수각에서는 부동소수 오차 대신 **정확한 값**을
 * 돌려준다 — cos(90)이 6.1e-17이 아니라 딱 0이다. 기하를 쌓아 올리는 작품에서
 * 이 차이가 누적되면 접힌 전개도가 미세하게 안 맞는다.
 */
// Exact-angle compatibility values adapted from EntryJS (Apache-2.0,
// Copyright 2015 Entry Labs). See the bundled third-party notices.
const TRIG_TABLE = {
    [UN_SIN]: { 0: 0, 30: 0.5, 45: Math.SQRT2 / 2, 60: SQRT3 / 2, 90: 1, 120: SQRT3 / 2, 135: Math.SQRT2 / 2, 150: 0.5, 180: 0, 210: -0.5, 225: -Math.SQRT2 / 2, 240: -SQRT3 / 2, 270: -1, 300: -SQRT3 / 2, 315: -Math.SQRT2 / 2, 330: -0.5, 360: 0 },
    [UN_COS]: { 0: 1, 30: SQRT3 / 2, 45: Math.SQRT2 / 2, 60: 0.5, 90: 0, 120: -0.5, 135: -Math.SQRT2 / 2, 150: -SQRT3 / 2, 180: -1, 210: -SQRT3 / 2, 225: -Math.SQRT2 / 2, 240: -0.5, 270: 0, 300: 0.5, 315: Math.SQRT2 / 2, 330: SQRT3 / 2, 360: 1 },
    [UN_TAN]: { 0: 0, 30: SQRT3 / 3, 45: 1, 135: -1, 150: -SQRT3 / 3, 180: 0, 210: SQRT3 / 3, 225: 1, 315: -1, 330: -SQRT3 / 3, 360: 0 },
};
const TRIG_FN = { [UN_SIN]: Math.sin, [UN_COS]: Math.cos, [UN_TAN]: Math.tan };

function preciseTrig(deg, un) {
    const angle = deg % 360;
    const table = TRIG_TABLE[un];
    // 음수 각은 테이블에 없어 Math로 떨어진다 — 엔진과 같은 동작이다.
    if (Object.prototype.hasOwnProperty.call(table, angle)) return table[angle];
    return TRIG_FN[un](angle * DEG);
}

function factorial(n) {
    const k = Math.floor(n);
    if (!(k > 1)) return 1;
    if (k > 170) return Infinity;       // 그 위는 double로 표현이 안 된다
    let acc = 1;
    for (let i = 2; i <= k; i += 1) acc *= i;
    return acc;
}

function boundedText(value) {
    const text = String(value ?? '');
    return text.length <= VM_TEXT_MAX ? text : text.slice(0, VM_TEXT_MAX);
}

function boundedConcat(left, right) {
    const a = String(left ?? '');
    if (a.length >= VM_TEXT_MAX) return a.slice(0, VM_TEXT_MAX);
    const b = String(right ?? '');
    return a + b.slice(0, VM_TEXT_MAX - a.length);
}

function boundedReplace(source, find, replacement) {
    const input = boundedText(source);
    const needle = boundedText(find);
    if (!needle) return input;
    const value = boundedText(replacement);
    let cursor = 0;
    let result = '';
    for (;;) {
        const index = input.indexOf(needle, cursor);
        if (index < 0) return boundedConcat(result, input.slice(cursor));
        result = boundedConcat(result, input.slice(cursor, index));
        result = boundedConcat(result, value);
        if (result.length >= VM_TEXT_MAX) return result;
        cursor = index + needle.length;
    }
}

/** 아무것도 그리지 않는 기본 sink — VM만 돌려 볼 때 쓴다. */
export const nullSink = {
    line() {}, fill() {}, stamp() {}, clear() {}, text() {}, sound() {},
};

/**
 * 엔티티 하나의 붓 상태.
 *
 * 선(brush)과 채우기(paint)는 엔진에서 **별개 상태**다 — 색과 투명도를 따로 둔다.
 * 투명도는 엔트리 값(0=불투명 … 100=투명)으로 보관하고 sink에는 알파로 넘긴다.
 * 채우기 진행 상태(`filling`/`path`)도 여기 있다: 복제본마다 자기 채우기가
 * 따로 돌기 때문에 VM 전역에 하나만 두면 서로의 경로를 밟는다.
 */
function newPen() {
    return {
        down: false, x: 0, y: 0, thickness: 1,
        color: '#ffffff', opacity: 0,
        fillColor: '#ffffff', fillOpacity: 0,
        filling: false, path: [],
    };
}

export class EniwanVM {
    /**
     * @param {object} program compiler.js가 만든 프로그램
     * @param {{sink?:object, logicHz?:number, maxStepsPerTick?:number, maxCallDepth?:number}} [options]
     */
    constructor(program, options = {}) {
        this.program = program;
        this.sink = options.sink || nullSink;
        this.logicHz = options.logicHz || 60;
        this.tickMultiplier = 1;
        // 한 틱이 무한 루프로 브라우저를 얼리는 걸 막는 상한. 넘으면 그 틱을
        // 중단하고 `overrun`을 올린다 — 조용히 멈추는 대신 숫자로 드러낸다.
        this.maxStepsPerTick = options.maxStepsPerTick || 4_000_000;
        this.maxCallDepth = options.maxCallDepth || 64;

        const frameSize = program.frameSize || 16;
        this.frameSize = frameSize;
        // `threadCount`는 **스크립트 수**다(프로그램에 적힌 시작 블록 개수).
        // 복제본이 생기면 같은 스크립트가 여러 줄에서 동시에 도는데, 그 줄 수는
        // `rowCount`다. 0..threadCount-1번 줄은 **원본 오브젝트의 그 스크립트**로
        // 고정해 둔다 — 복제본 없는 작품에서는 예전과 번호가 완전히 같다.
        this.threadCount = program.threads.length;
        this.scriptCount = this.threadCount;

        this.objects = program.objects || [];
        const objectCount = this.objects.length;
        // 엔진은 오브젝트마다 복제본을 361개까지 허용한다(`clonedEntities.length > 360`
        // 일 때만 거절하므로 360개까지 있을 때 하나 더 만든다). 풀 전체 상한은 그보다
        // 넉넉하되 유한하게 둔다 — 무한히 늘리면 램이 아니라 탭이 죽는다.
        this.maxClonesPerObject = options.maxClonesPerObject ?? 361;
        this.maxClones = options.maxClones
            ?? (program.usesClones ? Math.min(objectCount * this.maxClonesPerObject, 2048) : 0);
        this.entityCapacity = objectCount + this.maxClones;

        // 스레드마다 독립 레지스터 창. 슬라이딩 윈도우라 호출마다 base가 argStart만큼
        // 올라가고, argStart는 최대 frameSize다 — 그래서 창은 (깊이+2)×frameSize여야
        // 재귀가 **옆 스레드의 레지스터를 밟지 않는다**. 깊이 상한만으로는 못 막는다.
        this.regCapacity = frameSize * (this.maxCallDepth + 2);
        // 줄은 모자라면 두 배로 늘린다. 틱 안에서는 거의 안 늘어나므로(복제본을
        // 처음 만들 때만) 할당 없는 성질은 그대로다.
        this.rowCapacity = Math.max(this.scriptCount, 1) + (this.maxClones ? 32 : 0);
        this.rowCount = this.scriptCount;
        this._allocRows(this.rowCapacity);
        this._allocEntities(this.entityCapacity);

        this.varNum = new Float64Array(program.vars.length);
        this.varTag = new Uint8Array(program.vars.length);
        this.varStr = new Array(program.vars.length).fill('');
        this.varVisible = new Uint8Array(program.vars.length);
        // Entry 오브젝트 변수는 원본과 각 복제본이 서로 다른 값을 가진다.
        // 전체 변수 대신 지역 변수만 엔티티별로 잡아 큰 작품의 메모리를 아낀다.
        this.varLocalSlot = new Int32Array(program.vars.length).fill(-1);
        this.varOwner = new Int32Array(program.vars.length).fill(-1);
        let localVarCount = 0;
        program.vars.forEach((v, i) => {
            const owner = Number.isInteger(v.ownerObject) ? v.ownerObject : -1;
            this.varOwner[i] = owner;
            if (owner >= 0) this.varLocalSlot[i] = localVarCount++;
        });
        this.localVarCount = localVarCount;
        const localCells = this.entityCapacity * localVarCount;
        this.localVarNum = new Float64Array(localCells);
        this.localVarTag = new Uint8Array(localCells);
        this.localVarStr = new Array(localCells).fill('');
        this.lists = program.lists.map(() => []);
        this.listVisible = new Uint8Array(program.lists.length);
        this.listVersions = new Uint32Array(program.lists.length);
        this.tables = [];

        this.host = new Float64Array(HOST_SLOTS);
        this.tessCompatibility = false;
        this.hostReadCounts = new Uint32Array(HOST_SLOTS);
        // 문자 슬롯(클립보드·커서). 숫자 슬롯과 번호를 공유하고, 어느 쪽을 보는지는
        // `HOST_IS_STRING`이 가른다.
        this.hostStr = new Array(HOST_SLOTS).fill('');
        // 로그인하지 않았을 때의 닉네임은 **공백 한 칸**이다. 엔진이 그렇게
        // 돌려준다(`window.user ? window.user.nickname : ' '`) — 빈 문자로
        // 두면 `닉네임 = ''` 같은 분기를 쓰는 작품이 엔트리와 다르게 돈다.
        // `reset()`에서는 지우지 않는다: 호스트가 한 번 받아 둔 이름을 다시
        // 시작했다고 뺏을 이유가 없다(클립보드와 같은 이유다).
        this.hostStr[HOST_NICKNAME] = ' ';
        /** 작품이 쓴 뒤 호스트가 처리해야 하는 일들. `takeHostWrites()`로 가져간다. */
        this.hostWrites = new Set();
        this.keys = new Uint8Array(256);     // 키코드별 눌림 상태
        this.texts = [];                     // 오브젝트idx → 글상자 내용
        this.textStyles = [];

        // ── 장면 ──
        // 엔진은 **지금 장면의 오브젝트만** 그리고, 그 장면의 코드만 돈다.
        // 장면이 없는 작품(손으로 만든 테스트 project)은 장면 하나짜리로 온다.
        this.scenes = program.scenes && program.scenes.length
            ? program.scenes : [{ id: '', name: '장면 1' }];
        this.objectScene = Int32Array.from(this.objects.map((o) => o.sceneIndex || 0));
        this.sceneIndex = 0;
        /**
         * 그리는 순서 — **맨 앞이 먼저** 오는 오브젝트 번호 목록.
         *
         * 엔트리에서 `objects[0]`이 맨 앞이다(무대 정렬이 배열을 거꾸로 훑는다).
         * `change_object_index`는 이 목록 안에서 자리를 옮긴다. 복제본은 자기
         * 원본의 자리를 쓴다 — 엔진은 복제본을 원본 옆 자식으로 끼워 넣어 더
         * 촘촘하게 다루지만, 그 차이는 "원본과 복제본 중 누가 위냐"에서만 보이고
         * 대신 그리기는 오브젝트 수만큼의 순회로 끝난다.
         */
        this.zorder = Int32Array.from(this.objects.map((_, i) => i));
        // `drawOrder()`가 돌려주는 캐시. 바뀔 때만 다시 만든다.
        this._drawOrderBuf = new Int32Array(this.objects.length);
        this._drawOrderView = this._drawOrderBuf.subarray(0, 0);
        this._drawOrderDirty = true;

        // ── 말풍선 ──
        // 엔티티마다 말풍선 하나. 그리는 건 호스트 몫이라 VM은 글자와 종류만 든다.
        this.dialogs = [];
        this.questions = [];

        // ── 초시계 ──
        // 벽시계가 아니라 **틱**으로 센다(`wait_second`과 같은 이유 — 프레임이
        // 밀려도 작품 속 시간이 로직과 어긋나지 않는다). 엔진처럼 `시작하기`
        // 블록을 만나기 전까지는 **돌지 않는다**: 엔진의 초시계도 `startProjectTimer`
        // 전에는 0이다.
        this.timerRunning = false;
        this.timerTicks = 0;

        this.stats = {
            ticks: 0, steps: 0, calls: 0, nativeCalls: 0, nativeInstructions: 0,
            tailCalls: 0, overruns: 0, budgetPauses: 0,
            lastTickSteps: 0, lastTickMs: 0, lines: 0, fills: 0,
        };

        // Entry 3D projects often implement material lookup as a recursive
        // custom block.  A 12k-face model can call the same deterministic
        // lookup hundreds of thousands of times per frame.  Detect the narrow,
        // side-effect-limited form and memoize its global outputs.  Other
        // custom blocks continue through the normal VM path.
        this.functionMemoProfiles = this._buildFunctionMemoProfiles();
        this.functionMemoCaches = this.functionMemoProfiles.map((p) => (p ? new Map() : null));
        this.callMemoFrames = [];

        // Project-load AOT tier. Only synchronous, side-effect-audited custom
        // functions are admitted. A CSP rejection leaves an all-null table and
        // the ordinary Dorongi bytecode path remains authoritative.
        const native = options.nativeTier === false
            ? { functions: new Array(program.functions.length).fill(null), blocked: false, count: 0 }
            : buildNativeFunctions(program);
        this.nativeFunctions = native.functions;
        this.nativeTierBlocked = native.blocked;
        this.nativeFunctionCount = native.count;
        // Runtime installs an alpha-aware sprite test after image preload.
        // Headless VM tests keep the rotated-bounds fallback.
        this.spriteAlphaHitTest = null;

        this.reset();
    }

    _buildFunctionMemoProfiles() {
        const code = this.program.code;
        const functions = this.program.functions || [];
        const firstThreadPc = Math.min(...(this.program.threads || []).map((t) => t.pc), code.length / INSTR_WORDS);
        const safe = new Set([
            OP_CONST, OP_CONSTSTR, OP_MOV, OP_LOADVAR, OP_STOREVAR, OP_LOADLOCAL,
            OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MOD, OP_QUOT, OP_UNARY, OP_ATAN2,
            OP_CONCAT, OP_LT, OP_GT, OP_EQ, OP_NE, OP_LE, OP_GE, OP_AND, OP_OR, OP_NOT,
            OP_LISTGET, OP_LISTLEN, OP_INLIST, OP_CHARAT, OP_STRLEN, OP_STRIDX,
            OP_SUBSTR, OP_REPLACE, OP_STRCASE, OP_STRREV, OP_STRCOUNT, OP_ISTYPE,
            OP_JMP, OP_JZ, OP_JNZ, OP_CALL, OP_RET,
        ]);
        return functions.map((fn, fi) => {
            const end = fi + 1 < functions.length ? functions[fi + 1].pc : firstThreadPc;
            const readVars = new Set();
            const writeVars = new Set();
            const readLists = new Set();
            let recursive = false;
            let valid = fn.arity <= 8;
            for (let pc = fn.pc; valid && pc < end; pc += 1) {
                const o = pc * INSTR_WORDS;
                const op = code[o], a = code[o + 1], b = code[o + 2];
                if (!safe.has(op)) { valid = false; break; }
                if (op === OP_LOADVAR) readVars.add(b);
                else if (op === OP_STOREVAR) writeVars.add(a);
                else if (op === OP_LISTGET || op === OP_LISTLEN || op === OP_INLIST) readLists.add(b);
                else if (op === OP_CALL) {
                    if (a !== fi) { valid = false; break; }
                    recursive = true;
                }
            }
            if (!valid || !recursive || writeVars.size === 0 || writeVars.size > 8) return null;
            if ([...readVars, ...writeVars].some((v) => this.varOwner[v] >= 0)) return null;
            return {
                arity: fn.arity,
                readVars: [...readVars],
                writeVars: [...writeVars],
                readLists: [...readLists],
            };
        });
    }

    _functionMemoKey(profile, argBase) {
        const parts = [];
        for (let i = 0; i < profile.arity; i += 1) {
            const cell = argBase + i;
            parts.push(this.regTag[cell] === TAG_STR
                ? `s${JSON.stringify(this.regStr[cell])}` : `n${this.regNum[cell]}`);
        }
        for (const v of profile.readVars) {
            parts.push(this.varTag[v] === TAG_STR
                ? `vs${JSON.stringify(this.varStr[v])}` : `vn${this.varNum[v]}`);
        }
        for (const list of profile.readLists) parts.push(`l${list}:${this.listVersions[list]}`);
        return parts.join('|');
    }

    _applyFunctionMemo(entry, retSlot) {
        for (const w of entry.writes) {
            this.varTag[w[0]] = w[1];
            this.varNum[w[0]] = w[2];
            this.varStr[w[0]] = w[3];
        }
        if (retSlot >= 0) {
            if (entry.retTag === TAG_STR) this._setStr(retSlot, entry.retStr);
            else this._setNum(retSlot, entry.retNum);
        }
    }

    // ── 줄(스레드)과 엔티티 저장소 ──────────────────────────────────────
    /** 줄 번호로 색인되는 배열들을 `cap`줄만큼 잡는다. */
    _allocRows(cap) {
        this.regNum = new Float64Array(cap * this.regCapacity);
        this.regTag = new Uint8Array(cap * this.regCapacity);
        this.regStr = new Array(cap * this.regCapacity).fill('');
        // 스레드 상태 — 전부 평평한 배열이다(스레드 객체 배열이 아니다).
        this.pc = new Int32Array(cap);
        this.base = new Int32Array(cap);
        this.alive = new Uint8Array(cap);
        this.depth = new Int32Array(cap);
        // 콜스택: 줄마다 maxCallDepth개의 [복귀pc, 복귀base, 반환reg]
        this.callStack = new Int32Array(cap * this.maxCallDepth * 3);
        this.rowScript = new Int32Array(cap);     // 이 줄이 도는 스크립트 번호
        this.rowEntity = new Int32Array(cap);     // 이 줄이 붙은 엔티티 번호
        this.rowSleep = new Float64Array(cap);    // 남은 대기 틱(0이면 안 잠)
        this.rowWakeTick = new Int32Array(cap).fill(-1); // 이 틱부터 돈다(-1=지금부터)
        // `x y 위치로 N초 동안 이동하기`는 여러 틱에 걸친 블록이다. 목표와 남은
        // 프레임 수를 **줄마다** 들고 있어야 한다 — 엔진도 그 상태를 블록
        // 인스턴스(`script.frameCount`)에 달아 두므로, 같은 블록이 복제본마다
        // 따로 진행된다. VM 전역에 하나만 두면 복제본들이 서로를 끌어당긴다.
        this.rowGlideX = new Float64Array(cap);
        this.rowGlideY = new Float64Array(cap);
        this.rowGlideFrames = new Int32Array(cap).fill(-1); // -1 = 아직 시작 안 함
        this.rowTurnStep = new Float64Array(cap);
        this.rowTurnFrames = new Int32Array(cap).fill(-1);
        // 묻고 기다리기 — 대답이 올 때까지 **이 줄만** 멈춘다.
        this.rowAwaitAnswer = new Uint8Array(cap);
        // 한 논리 틱을 여러 화면 프레임에 나눌 때 이미 끝난 줄을 표시한다.
        this.rowTickDone = new Uint8Array(cap);
    }

    /**
     * 줄을 두 배로 늘린다. 기존 내용을 **그대로 옮긴다** — 레지스터 창은 줄
     * 번호로 위치가 정해지므로 offset 계산이 같아 통째 복사로 충분하다.
     */
    _growRows() {
        const oldTickDone = this.rowTickDone;
        const old = {
            regNum: this.regNum, regTag: this.regTag, regStr: this.regStr,
            pc: this.pc, base: this.base, alive: this.alive, depth: this.depth,
            callStack: this.callStack, rowScript: this.rowScript,
            rowEntity: this.rowEntity, rowSleep: this.rowSleep,
            rowWakeTick: this.rowWakeTick,
            rowGlideX: this.rowGlideX, rowGlideY: this.rowGlideY,
            rowGlideFrames: this.rowGlideFrames,
            rowTurnStep: this.rowTurnStep, rowTurnFrames: this.rowTurnFrames,
            rowAwaitAnswer: this.rowAwaitAnswer,
        };
        const cap = this.rowCapacity * 2;
        this._allocRows(cap);
        this.rowTickDone.set(oldTickDone);
        this.regNum.set(old.regNum);
        this.regTag.set(old.regTag);
        for (let i = 0; i < old.regStr.length; i += 1) this.regStr[i] = old.regStr[i];
        this.pc.set(old.pc);
        this.base.set(old.base);
        this.alive.set(old.alive);
        this.depth.set(old.depth);
        this.callStack.set(old.callStack);
        this.rowScript.set(old.rowScript);
        this.rowEntity.set(old.rowEntity);
        this.rowSleep.set(old.rowSleep);
        this.rowWakeTick.set(old.rowWakeTick);
        this.rowGlideX.set(old.rowGlideX);
        this.rowGlideY.set(old.rowGlideY);
        this.rowGlideFrames.set(old.rowGlideFrames);
        this.rowTurnStep.set(old.rowTurnStep);
        this.rowTurnFrames.set(old.rowTurnFrames);
        this.rowAwaitAnswer.set(old.rowAwaitAnswer);
        this.rowCapacity = cap;
    }

    /** 엔티티 표. 0..objectCount-1은 원본, 그 뒤는 복제본 풀이다. */
    _allocEntities(cap) {
        this.entObject = new Int32Array(cap).fill(-1);
        this.entAlive = new Uint8Array(cap);
        this.entIsClone = new Uint8Array(cap);
        this.entX = new Float64Array(cap);
        this.entY = new Float64Array(cap);
        this.entRot = new Float64Array(cap);
        this.entDir = new Float64Array(cap);
        this.entScaleX = new Float64Array(cap);
        this.entScaleY = new Float64Array(cap);
        this.entW = new Float64Array(cap);
        this.entH = new Float64Array(cap);
        this.entVisible = new Uint8Array(cap);
        this.entShape = new Int32Array(cap);
        // 회전·크기의 중심(모양 픽셀 좌표). 그리는 쪽만 쓰지만 모양을 바꿀 때
        // 같이 갱신해야 하므로 엔티티 상태에 둔다.
        this.entRegX = new Float64Array(cap);
        this.entRegY = new Float64Array(cap);
        // 효과 3종. 투명도는 **엔트리 값**(0=불투명, 100=투명)으로 들고 있다
        // — 엔진 내부의 alpha(=1-값/100)로 바꾸는 건 그리는 쪽 일이다.
        this.entHsv = new Float64Array(cap);
        this.entBright = new Float64Array(cap);
        this.entAlpha = new Float64Array(cap);
        // 글상자도 복제 가능한 엔티티다. 오브젝트 단위 배열만 쓰면 복제본의
        // 내용과 위치가 전부 원본 하나로 합쳐져 사라진다.
        this.entTexts = new Array(cap).fill('');
        this.entTextStyles = new Array(cap);
        // 붓은 엔티티마다 따로다(엔트리에서 붓은 오브젝트에 달려 있고, 복제본은
        // 자기 붓을 가진다). 숫자·문자가 섞여 평범한 객체로 두되, 틱 중에는
        // 새로 만들지 않도록 **미리 다 만들어** 둔다.
        this.pens = new Array(cap);
        for (let i = 0; i < cap; i += 1) this.pens[i] = newPen();
        // 복제본 상한은 **오브젝트마다** 센다(엔진의 `clonedEntities`가 그렇다).
        this.cloneCount = new Int32Array(Math.max(this.objects.length, 1));
    }

    /** 엔티티를 작품에 적힌 처음 상태로 되돌린다. 복제본은 전부 치운다. */
    _resetEntities() {
        this.entAlive.fill(0);
        this.entIsClone.fill(0);
        this.entObject.fill(-1);
        this.cloneCount.fill(0);
        for (let i = 0; i < this.pens.length; i += 1) {
            const pen = this.pens[i];
            pen.down = false; pen.x = 0; pen.y = 0; pen.thickness = 1;
            pen.color = '#ffffff'; pen.opacity = 0;
            pen.fillColor = '#ffffff'; pen.fillOpacity = 0;
            pen.filling = false; pen.path.length = 0;
        }
        this.objects.forEach((object, i) => {
            const s = object.start || {};
            this.entObject[i] = i;
            this.entAlive[i] = 1;
            this.entX[i] = s.x || 0;
            this.entY[i] = s.y || 0;
            this.entRot[i] = s.rotation || 0;
            this.entDir[i] = s.direction === undefined ? 90 : s.direction;
            this.entScaleX[i] = s.scaleX === undefined ? 1 : s.scaleX;
            this.entScaleY[i] = s.scaleY === undefined ? 1 : s.scaleY;
            this.entW[i] = s.width || 0;
            this.entH[i] = s.height || 0;
            this.entVisible[i] = s.visible === false ? 0 : 1;
            this.entShape[i] = s.shape === undefined ? -1 : s.shape;
            this.entRegX[i] = s.regX === null || s.regX === undefined ? this.entW[i] / 2 : s.regX;
            this.entRegY[i] = s.regY === null || s.regY === undefined ? this.entH[i] / 2 : s.regY;
            this.entHsv[i] = 0;
            this.entBright[i] = 0;
            this.entAlpha[i] = 0;
            this.entTexts[i] = boundedText(s.text ?? '');
            this.entTextStyles[i] = {
                color: s.color || '#000000',
                background: s.background || 'transparent',
                font: s.font || `${s.fontSize || 12}px sans-serif`,
                effect: '', mode: '',
            };
            // 붓은 엔티티를 따라다닌다 — 처음 위치는 오브젝트의 처음 위치다.
            this.pens[i].x = this.entX[i];
            this.pens[i].y = this.entY[i];
        });
    }

    reset() {
        const program = this.program;
        this.regNum.fill(0);
        this.regTag.fill(TAG_NUM);
        for (let i = 0; i < this.regStr.length; i += 1) this.regStr[i] = '';

        program.vars.forEach((v, i) => {
            const value = v.initial;
            // Entry.Variable uses parseNumber at construction: ordinary
            // numeric strings become numbers, while leading-zero strings stay
            // strings so IDs such as "0012" are not destroyed.
            const numericString = typeof value === 'string' && isEntryNumber(value);
            if (typeof value === 'number' && Number.isFinite(value)) {
                this.varNum[i] = value; this.varTag[i] = TAG_NUM;
            } else if (numericString && value[0] !== '0') {
                this.varNum[i] = Number(value); this.varTag[i] = TAG_NUM;
            } else if (value === '' || value === null || value === undefined) {
                this.varNum[i] = 0; this.varTag[i] = TAG_NUM;
            } else {
                this.varStr[i] = String(value);
                this.varTag[i] = TAG_STR;
            }
            this.varVisible[i] = v.visible === true ? 1 : 0;
            const local = this.varLocalSlot[i];
            if (local >= 0) {
                for (let entity = 0; entity < this.entityCapacity; entity += 1) {
                    const cell = entity * this.localVarCount + local;
                    this.localVarNum[cell] = this.varNum[i];
                    this.localVarTag[cell] = this.varTag[i];
                    this.localVarStr[cell] = this.varStr[i];
                }
            }
        });
        this.lists = program.lists.map((l) => (l.initial || []).slice());
        this.listVersions.fill(0);
        for (const cache of this.functionMemoCaches) cache?.clear();
        this.callMemoFrames.length = 0;
        program.lists.forEach((l, i) => { this.listVisible[i] = l.visible === true ? 1 : 0; });
        this.tables = (program.tables || []).map((table) => ({
            id: table.id,
            name: table.name,
            fields: (table.fields || []).slice(),
            rows: (table.rows || []).map((row) => row.slice()),
        }));

        this.alive.fill(0);
        this.rowSleep.fill(0);
        this.rowWakeTick.fill(-1);
        this.rowGlideFrames.fill(-1);
        this.rowTurnFrames.fill(-1);
        this.rowAwaitAnswer.fill(0);
        this.rowTickDone.fill(0);
        this.rowCount = this.scriptCount;
        this._inTick = false;
        this.tickInProgress = false;
        this.tickSteps = 0;
        this.tickStartedAt = 0;
        this.volume = 100;
        this.soundSpeed = 1;
        this.sceneIndex = 0;
        for (let i = 0; i < this.zorder.length; i += 1) this.zorder[i] = i;
        this._drawOrderDirty = true;
        this.dialogs = [];
        this.questions = [];
        this.timerRunning = false;
        this.timerTicks = 0;
        program.threads.forEach((t, i) => {
            this.pc[i] = t.pc;
            this.base[i] = i * this.regCapacity;
            this.depth[i] = 0;
            this.rowScript[i] = i;
            // 0..scriptCount-1번 줄은 원본 오브젝트의 스크립트로 못 박혀 있다.
            this.rowEntity[i] = t.objectIndex === undefined ? -1 : t.objectIndex;
            // 지금은 "시작하기 버튼"만 자동으로 깨운다. 클릭·키 이벤트는 호스트가
            // wake()로 깨운다 — 어떤 이벤트가 안 붙었는지 숨기지 않기 위해서다.
            //
            // **지금 장면의 오브젝트만** 깨운다. 엔진의 `fireEvent`도 장면 단위라
            // (`mapEntityIncludeCloneOnScene`), 두 번째 장면의 시작 코드가 첫
            // 장면에서 같이 돌면 안 보이는 데서 변수가 바뀌는 작품이 된다.
            this.alive[i] = t.event === 'when_run_button_click'
                && this._onCurrentScene(t.objectIndex) ? 1 : 0;
        });

        this._resetEntities();
        // 엔티티가 없는 작품(펜만 쓰는 테스트)도 붓은 있어야 한다.
        this.curEntity = this.objects.length ? 0 : 0;
        this.pen = this.pens[0];
        this.texts = this.objects.map((object) => String(object.start?.text ?? ''));
        this.textStyles = this.objects.map((object) => ({
            color: object.start?.color || '#000000',
            background: object.start?.background || 'transparent',
            font: object.start?.font || `${object.start?.fontSize || 12}px sans-serif`,
            effect: '', mode: '',
        }));
        this.accumulatorMs = 0;
        this.lastNowMs = -1;
        this.stats.ticks = 0;
        this.stats.steps = 0;
        this.stats.calls = 0;
        this.stats.nativeCalls = 0;
        this.stats.nativeInstructions = 0;
    this.stats.tailCalls = 0;
        this.stats.overruns = 0;
        this.stats.budgetPauses = 0;
        this.stats.lines = 0;
        this.stats.fills = 0;

        // 누적 입력은 지난 실행분을 다음 실행에 흘려 보내지 않는다.
        this.host[HOST_MOUSE_DX] = 0;
        this.host[HOST_MOUSE_DY] = 0;
        this.host[HOST_WHEEL] = 0;
        this.host[HOST_SCROLL_X] = 0;
        this.hostReadCounts.fill(0);
        this.hostWrites.clear();
        // **블록 하나 돌기 전에** 1이어야 한다. 작품은 보통 첫 줄에서 "여기가
        // 어느 런타임인가"를 묻고 분기하고, 멈춘 작품을 들여다볼 때도 1로 남아
        // 있어야 "엔트리로 돌았나"를 오해하지 않는다.
        this.host[HOST_IS_ENIWAN] = 1;
        this.host[HOST_IS_TESSVM] = this.tessCompatibility ? 1 : 0;
        // 클립보드에 들어와 있던 것은 남긴다 — 사용자가 붙여넣은 값을 다시 시작했다고
        // 뺏을 이유가 없다(엔트리 세이브 매니저 쪽도 매 실행마다 되돌려 넣는다).
        this.hostStr[HOST_CURSOR] = '';

        this.sink.clear();
    }

    /** 문자 슬롯(클립보드 등)에 호스트가 값을 넣는다. 작품이 쓴 것으로 세지 않는다. */
    setHostText(slot, text) {
        if (!HOST_IS_STRING[slot]) return;
        this.hostStr[slot] = String(text ?? '');
        const action = HOST_WRITE_ACTIONS[slot];
        if (action) this.hostWrites.delete(action);
    }

    /**
     * 작품이 호스트에게 요청한 일들을 가져간다(가져가면 비워진다).
     *
     * 호스트가 매 프레임 폴링해야 하는 이유: VM은 브라우저를 모른다. 클립보드
     * 쓰기나 포인터 락은 문서와 사용자 제스처가 있는 쪽에서만 할 수 있다.
     */
    takeHostWrites() {
        if (this.hostWrites.size === 0) return null;
        const taken = [...this.hostWrites];
        this.hostWrites.clear();
        return taken;
    }

    /**
     * 이 오브젝트가 **지금 장면**에 있는가. 오브젝트가 없는 줄(-1)은 장면과
     * 상관없으므로 참으로 본다.
     */
    _onCurrentScene(objectIndex) {
        if (!(objectIndex >= 0)) return true;
        return this.objectScene[objectIndex] === this.sceneIndex;
    }

    /**
     * 작품이 `묻고 기다리기`로 멈춰 있을 때 대답을 넣어 준다.
     *
     * 멈춘 줄만 깨운다 — 엔진도 입력창이 하나라 어느 줄이 물었든 대답 하나로
     * 다 풀린다(`Entry.container.setInputValue`). 대답은 `HOST_ANSWER`에 남아
     * 다음 질문 전까지 `대답` 블록이 읽는다.
     * @returns {number} 풀려난 줄 수
     */
    answer(text) {
        this.hostStr[HOST_ANSWER] = String(text ?? '');
        while (this.questions.length && !this.rowAwaitAnswer[this.questions[0].row]) {
            this.questions.shift();
        }
        const question = this.questions.shift();
        let woken = 0;
        if (question && this.rowAwaitAnswer[question.row]) {
            this.rowAwaitAnswer[question.row] = 0;
            woken = 1;
        }
        this.hostWrites.delete('ask');
        if (this.questions.length) this.hostWrites.add('ask');
        return woken;
    }

    /** 물어본 말. 호스트가 입력창에 띄울 문구다(없으면 빈 문자열). */
    pendingQuestion() {
        while (this.questions.length && !this.rowAwaitAnswer[this.questions[0].row]) {
            this.questions.shift();
        }
        return this.questions[0]?.text ?? '';
    }

    /**
     * 장면을 갈아탄다 — 엔진 `selectScene` + `fireEvent('when_scene_start')`.
     *
     * 엔진이 이때 하는 일(`resetSceneDuringRun`): **지금 장면의** 엔티티를 처음
     * 상태로 되돌리고(복제본은 사라진다) 그 장면에서 돌던 코드를 모두 멈춘다.
     *
     * 같은 장면을 다시 고르는 경우를 조심해야 한다. 엔진 `Entry.scene.selectScene`은
     * `resetSceneDuringRun()`을 **먼저** 부르고 나서 "같은 장면이면" 일찍 빠져나가고,
     * `start_scene` 블록은 그 뒤에 `fireEvent('when_scene_start')`를 **무조건** 부른다
     * (`class/scene.js:444`, `playground/blocks/block_start.js:626`). 즉 같은 장면
     * 시작하기 = **그 장면을 처음부터 다시 돌리기**다. 전에는 여기서 이벤트를 띄우지
     * 않고 끝냈는데, 그러면 장면을 다시 시작하는 작품이 코드가 전부 멈춘 채 화면만
     * 남는다(돌던 줄은 이미 다 죽여 놓았으니까).
     */
    startScene(index) {
        const next = Math.max(0, Math.min(this.scenes.length - 1, Math.floor(index)));
        const prev = this.sceneIndex;

        // 떠나는 장면의 줄을 멈춘다. 복제본의 줄까지 같이 멈춰야 한다 —
        // 안 멈추면 안 보이는 장면의 복제본이 계속 돌며 변수를 바꾼다.
        for (let i = 0; i < this.rowCount; i += 1) {
            const e = this.rowEntity[i];
            if (!this._onCurrentScene(e >= 0 ? this.entObject[e] : -1)) continue;
            this.alive[i] = 0;
            this.rowSleep[i] = 0;
            this.rowGlideFrames[i] = -1;
            this.rowAwaitAnswer[i] = 0;
        }
        // 떠나는 장면의 복제본을 지우고 엔티티를 처음 상태로.
        for (let i = 0; i < this.objects.length; i += 1) {
            if (this.objectScene[i] !== prev) continue;
            this._clearClones(i);
            this.dialogs[i] = null;
        }
        this._resetSceneEntities(prev);

        this.sceneIndex = next;
        this._drawOrderDirty = true;
        // 새 장면의 `장면이 시작되었을 때`를 깨운다. 같은 장면이어도 깨운다(위 주석).
        // `시작하기 버튼`은 다시 돌지 않는다 — 엔진도 그 이벤트는 실행 시작에만 띄운다.
        return this.wake('when_scene_start');
    }

    /**
     * `change_object_index` — 그리는 순서에서 자리를 옮긴다.
     *
     * `zorder`는 **맨 앞이 먼저** 오는 목록이라 "앞으로 가져오기"는 자리를
     * 줄이는 쪽이다. 엔진은 디스플레이 목록에 붓·그림 레이어가 끼어 있어서
     * `offsetCount`로 그만큼 더 넘지만, 결과는 "오브젝트 한 칸"이다 —
     * 우리는 오브젝트만 들고 있으므로 한 칸이 곧 그 한 칸이다.
     */
    _setObjectIndex(objectIndex, where) {
        if (!(objectIndex >= 0)) return;
        const z = this.zorder;
        let at = -1;
        for (let i = 0; i < z.length; i += 1) if (z[i] === objectIndex) { at = i; break; }
        if (at < 0) return;
        let to = at;
        if (where === ZORDER_FRONT) to = 0;
        else if (where === ZORDER_BACK) to = z.length - 1;
        else if (where === ZORDER_FORWARD) to = Math.max(0, at - 1);
        else if (where === ZORDER_BACKWARD) to = Math.min(z.length - 1, at + 1);
        if (to === at) return;
        // 끼워 넣기 — 사이의 오브젝트들은 한 칸씩 밀린다(자리 바꾸기가 아니다.
        // `맨 앞으로`에서 둘을 바꾸면 중간 순서가 뒤집힌다).
        if (to < at) for (let i = at; i > to; i -= 1) z[i] = z[i - 1];
        else for (let i = at; i < to; i += 1) z[i] = z[i + 1];
        z[to] = objectIndex;
        this._drawOrderDirty = true;
    }

    /**
     * 그리는 순서 — **뒤에서 앞으로**, 지금 장면의 오브젝트만.
     *
     * 호스트가 매 프레임 부르므로 바뀔 때만 다시 만든다(`z순서`를 옮기거나
     * 장면을 갈아탈 때). 프레임마다 배열을 새로 만들면 그만큼이 GC 압력이 된다.
     * @returns {Int32Array} 오브젝트 번호 목록(뒤 → 앞)
     */
    drawOrder() {
        if (this._drawOrderDirty) {
            const z = this.zorder;
            let n = 0;
            // 앞이 먼저인 목록을 거꾸로 담으면 뒤 → 앞이 된다.
            for (let i = z.length - 1; i >= 0; i -= 1) {
                if (this._onCurrentScene(z[i])) { this._drawOrderBuf[n] = z[i]; n += 1; }
            }
            this._drawOrderView = this._drawOrderBuf.subarray(0, n);
            this._drawOrderDirty = false;
        }
        return this._drawOrderView;
    }

    /** 한 장면의 원본 엔티티만 처음 상태로. `_resetEntities`의 장면판이다. */
    _resetSceneEntities(sceneIndex) {
        this.objects.forEach((object, i) => {
            if (this.objectScene[i] !== sceneIndex) return;
            const s = object.start;
            this.entAlive[i] = 1;
            this.entX[i] = s.x; this.entY[i] = s.y;
            this.entRot[i] = s.rotation; this.entDir[i] = s.direction;
            this.entScaleX[i] = s.scaleX; this.entScaleY[i] = s.scaleY;
            this.entW[i] = s.width; this.entH[i] = s.height;
            this.entVisible[i] = s.visible === false ? 0 : 1;
            this.entShape[i] = s.shape === undefined ? -1 : s.shape;
            this.entRegX[i] = s.regX === null || s.regX === undefined ? this.entW[i] / 2 : s.regX;
            this.entRegY[i] = s.regY === null || s.regY === undefined ? this.entH[i] / 2 : s.regY;
            this.entHsv[i] = 0; this.entBright[i] = 0; this.entAlpha[i] = 0;
            this.pens[i].x = this.entX[i];
            this.pens[i].y = this.entY[i];
        });
    }

    /**
     * 이벤트 스레드를 깨운다. `event`에 맞는 스크립트를 **살아 있는 엔티티마다**
     * 처음부터 돌린다 — 복제본도 자기 몫의 줄에서 같이 깨어난다.
     *
     * `arg`는 신호 번호다. 신호는 **어느 신호인가**까지 맞아야 깨어난다. 이걸
     * 안 보면 신호 하나가 모든 신호 스레드를 깨우는, 찾기 어려운 버그가 된다.
     */
    wake(event, objectIndex = -1, arg = -1) {
        let woken = 0;
        for (let s = 0; s < this.scriptCount; s += 1) {
            const t = this.program.threads[s];
            if (t.event !== event) continue;
            if (objectIndex >= 0 && t.objectIndex !== objectIndex) continue;
            if (arg >= 0 && t.arg !== arg) continue;
            // 다른 장면의 코드는 깨우지 않는다 — 엔진의 `fireEvent`도 지금
            // 장면만 훑는다(`mapEntityIncludeCloneOnScene`). 신호가 장면을
            // 건너뛰면 안 보이는 데서 변수가 바뀌는 작품이 된다.
            if (!this._onCurrentScene(t.objectIndex)) continue;
            // 원본 엔티티는 자기 전용 줄(번호 = 스크립트 번호)에서 다시 시작한다.
            const origin = t.objectIndex;
            if (!(origin >= 0) || this.entAlive[origin]) {
                this.pc[s] = t.pc;
                this.base[s] = s * this.regCapacity;
                this.depth[s] = 0;
                this.rowSleep[s] = 0;
                this.alive[s] = 1;
                this.rowWakeTick[s] = this._inTick ? this.stats.ticks + 1 : -1;
                woken += 1;
            }
            // 복제본은 줄을 새로 잡는다(같은 스크립트가 복제본마다 따로 돈다).
            if (!(origin >= 0)) continue;
            for (let e = this.objects.length; e < this.entityCapacity; e += 1) {
                if (this.entAlive[e] && this.entObject[e] === origin) {
                    this._spawn(e, s);
                    woken += 1;
                }
            }
        }
        return woken;
    }

    setHost({ mouseX, mouseY, mouseDown, timer, pointerLocked } = {}) {
        if (mouseX !== undefined) this.host[HOST_MOUSE_X] = mouseX;
        if (mouseY !== undefined) this.host[HOST_MOUSE_Y] = mouseY;
        if (mouseDown !== undefined) this.host[HOST_MOUSE_DOWN] = mouseDown ? 1 : 0;
        if (timer !== undefined) this.host[HOST_TIMER] = timer;
        if (pointerLocked !== undefined) this.host[HOST_POINTER_LOCKED] = pointerLocked ? 1 : 0;
    }

    /**
     * 상대 입력을 **더한다**(덮어쓰지 않는다).
     *
     * 왜 `setHost`와 따로인가: 델타는 누적량이고 읽을 때 소비된다. 호스트가
     * 매 프레임 덮어쓰면, 로직 틱이 한 번도 안 돈 프레임(FPS 리미터에 걸린
     * 프레임)의 마우스 움직임이 조용히 사라진다 — 그러면 시점이 "끊긴다".
     * 더하기만 하면 소비되지 않은 분량이 다음 틱까지 살아남는다.
     */
    pushHostDelta(dx = 0, dy = 0, wheel = 0, wheelX = 0) {
        if (dx) this.host[HOST_MOUSE_DX] += dx;
        if (dy) this.host[HOST_MOUSE_DY] += dy;
        if (wheel) this.host[HOST_WHEEL] += wheel;
        if (wheelX) this.host[HOST_SCROLL_X] += wheelX;
    }

    /** 키 눌림 상태. `code`는 엔트리가 쓰는 keyCode 숫자다. */
    setKey(code, down) {
        this.keys[Number(code) & 255] = down ? 1 : 0;
    }

    /** 글상자 내용(text_write). 대시보드·검증에서 읽는다. */
    getText(objectIndex) {
        return this.entTexts[objectIndex] || this.texts[objectIndex] || '';
    }

    /** 레지스터를 숫자로 읽는다(문자가 들어 있으면 그 자리에서 변환). */
    _num(slot) {
        if (this.regTag[slot] === TAG_NUM) return this.regNum[slot];
        return entryNumber(this.regStr[slot]);
    }

    /** LOADLOCAL 후 `_num`을 한 결과. superinstruction이 Entry의 value||0을 보존한다. */
    _localNum(slot) {
        if (this.regTag[slot] === TAG_NUM) return this.regNum[slot] || 0;
        const text = this.regStr[slot];
        if (!text) return 0;
        return entryNumber(text);
    }

    _str(slot) {
        return this.regTag[slot] === TAG_STR ? this.regStr[slot] : String(this.regNum[slot]);
    }

    // ── Native-tier value bridge ──────────────────────────────────────
    // These helpers are deliberately small and mirror the interpreter's
    // coercion rules. Generated functions never reach VM storage directly.
    _nativeNumValue(value) {
        return entryNumber(value);
    }

    _nativeGetVar(variable, entity) {
        const cell = this._localVarCell(variable, entity);
        if (cell >= 0) return this.localVarTag[cell] === TAG_STR
            ? this.localVarStr[cell] : this.localVarNum[cell];
        return this.varTag[variable] === TAG_STR ? this.varStr[variable] : this.varNum[variable];
    }

    _nativeSetVar(variable, value, entity) {
        const cell = this._localVarCell(variable, entity);
        if (typeof value === 'string') {
            const text = boundedText(value);
            if (cell >= 0) { this.localVarStr[cell] = text; this.localVarTag[cell] = TAG_STR; }
            else { this.varStr[variable] = text; this.varTag[variable] = TAG_STR; }
        } else {
            const number = typeof value === 'number' ? value : this._nativeNumValue(value);
            if (cell >= 0) { this.localVarNum[cell] = number; this.localVarTag[cell] = TAG_NUM; }
            else { this.varNum[variable] = number; this.varTag[variable] = TAG_NUM; }
        }
    }

    _nativeAddVar(variable, value, entity) {
        this._nativeSetVar(variable, entryChangedValue(this._nativeGetVar(variable, entity), value), entity);
    }

    _nativeAdd(left, right) {
        return isEntryNumber(left) && isEntryNumber(right)
            ? this._nativeNumValue(left) + this._nativeNumValue(right)
            : boundedConcat(left, right);
    }

    _nativeDiv(left, right) {
        const divisor = this._nativeNumValue(right);
        return divisor === 0 ? 0 : this._nativeNumValue(left) / divisor;
    }

    _nativeMod(left, right) {
        const divisor = this._nativeNumValue(right);
        if (divisor === 0) return 0;
        const n = this._nativeNumValue(left);
        return n - divisor * Math.floor(n / divisor);
    }

    _nativeQuot(left, right) {
        const divisor = this._nativeNumValue(right);
        return divisor === 0 ? 0 : Math.floor(this._nativeNumValue(left) / divisor);
    }

    _nativeConcat(left, right) { return boundedConcat(left, right); }
    _nativeEqual(left, right) {
        const a = typeof left === 'string' && left.length && !Number.isNaN(Number(left)) ? Number(left) : left;
        const b = typeof right === 'string' && right.length && !Number.isNaN(Number(right)) ? Number(right) : right;
        return a === b;
    }
    _nativeNotEqual(left, right) {
        const a = typeof left === 'string' && left.length && !Number.isNaN(Number(left)) ? Number(left) : left;
        const b = typeof right === 'string' && right.length && !Number.isNaN(Number(right)) ? Number(right) : right;
        // Entry deliberately uses loose inequality for NOT_EQUAL.
        // eslint-disable-next-line eqeqeq
        return a != b;
    }

    _nativeListGet(listIndex, index) {
        const list = this.lists[listIndex];
        const at = Math.round(this._nativeNumValue(index)) - 1;
        const value = at >= 0 && at < list.length ? list[at] : 0;
        if (typeof value === 'number') return value;
        const n = Number(value);
        return value !== '' && Number.isFinite(n) ? n : String(value === undefined ? '' : value);
    }

    _nativeListInsert(listIndex, index, value) {
        const list = this.lists[listIndex];
        const at = Math.round(this._nativeNumValue(index)) - 1;
        list.splice(Math.max(0, Math.min(at, list.length)), 0, value);
        this.listVersions[listIndex] += 1;
    }

    _nativeListSet(listIndex, index, value) {
        const list = this.lists[listIndex];
        const at = Math.round(this._nativeNumValue(index)) - 1;
        if (at >= 0 && at < list.length) {
            list[at] = value;
            this.listVersions[listIndex] += 1;
        }
    }

    _nativeListPush(listIndex, value) {
        this.lists[listIndex].push(value);
        this.listVersions[listIndex] += 1;
    }

    _nativeListDelete(listIndex, index) {
        const list = this.lists[listIndex];
        const at = Math.round(this._nativeNumValue(index)) - 1;
        if (at >= 0 && at < list.length) {
            list.splice(at, 1);
            this.listVersions[listIndex] += 1;
        }
    }

    _nativeLocate(x, y) { this._moveTo(this._nativeNumValue(x), this._nativeNumValue(y)); }

    _nativePenDown() { this.pen.down = true; }
    _nativePenUp() { this.pen.down = false; }
    _nativeSetPenColor(value) { this.pen.color = String(value ?? ''); }
    _nativeSetPenThickness(value) { this.pen.thickness = Math.max(0, this._nativeNumValue(value)); }

    _nativeEntityValue(property, objectIndex, entity) {
        const target = objectIndex < 0 ? entity : objectIndex;
        if (!(target >= 0) || target >= this.entityCapacity) {
            return property === ENT_PICTURE_NAME ? '' : 0;
        }
        switch (property) {
            case ENT_X: return this.entX[target];
            case ENT_Y: return this.entY[target];
            case ENT_ROTATION: return this.entRot[target];
            case ENT_DIRECTION: return this.entDir[target];
            case ENT_SIZE: return this._getSize(target);
            case ENT_PICTURE_INDEX: return this.entShape[target] + 1;
            case ENT_PICTURE_NAME: {
                const object = this.objects[this.entObject[target]];
                return object?.pictures[this.entShape[target]]?.name ?? '';
            }
            default: return 0;
        }
    }

    _nativeCallee(index) {
        const native = this.nativeFunctions[index];
        if (!native) return null;
        this.stats.calls += 1;
        this.stats.nativeCalls += 1;
        this.stats.nativeInstructions += native.instructionCount;
        return native;
    }

    _nativeCall0(index, entity) { const n = this._nativeCallee(index); return n ? n.run(this, entity) : 0; }
    _nativeCall1(index, entity, a0) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0) : 0; }
    _nativeCall2(index, entity, a0, a1) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1) : 0; }
    _nativeCall3(index, entity, a0, a1, a2) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2) : 0; }
    _nativeCall4(index, entity, a0, a1, a2, a3) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3) : 0; }
    _nativeCall5(index, entity, a0, a1, a2, a3, a4) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4) : 0; }
    _nativeCall6(index, entity, a0, a1, a2, a3, a4, a5) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4, a5) : 0; }
    _nativeCall7(index, entity, a0, a1, a2, a3, a4, a5, a6) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4, a5, a6) : 0; }
    _nativeCall8(index, entity, a0, a1, a2, a3, a4, a5, a6, a7) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4, a5, a6, a7) : 0; }
    _nativeCall9(index, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8) : 0; }
    _nativeCall10(index, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) : 0; }
    _nativeCall11(index, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) : 0; }
    _nativeCall12(index, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) : 0; }
    _nativeCall13(index, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12) : 0; }
    _nativeCall14(index, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13) : 0; }
    _nativeCall15(index, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14) : 0; }
    _nativeCall16(index, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15) { const n = this._nativeCallee(index); return n ? n.run(this, entity, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15) : 0; }

    _nativeInList(listIndex, value) {
        const needle = String(value);
        return this.lists[listIndex].some((item) => String(item) === needle) ? 1 : 0;
    }

    _nativeCharAt(value, index) {
        const text = String(value ?? '');
        const at = Math.round(this._nativeNumValue(index));
        return at >= 1 && at <= text.length ? text.charAt(at - 1) : '';
    }

    _nativeSubstring(value, begin, end) {
        const text = String(value ?? '');
        let first = Math.round(this._nativeNumValue(begin));
        let last = Math.round(this._nativeNumValue(end));
        if (first > last) [first, last] = [last, first];
        if (first < 1 || last < 1 || first > text.length || last > text.length) return '';
        return text.substring(first - 1, last);
    }

    _nativeReplace(value, find, replacement) {
        return boundedText(String(value ?? '').replace(String(find ?? ''), String(replacement ?? '')));
    }
    _nativeStringCount(value, needle) {
        const source = String(value ?? ''), search = String(needle ?? '');
        if (!search) return 0;
        return source.split(search).length - 1;
    }

    _nativeIsType(value, kind) {
        const text = String(value ?? '');
        if (kind === 1) return /^[a-zA-Z]+$/.test(text) ? 1 : 0;
        if (kind === 2) return /^[ㄱ-ㅎㅏ-ㅣ가-힣]+$/.test(text) ? 1 : 0;
        return text.trim() !== '' && Number.isFinite(Number(text)) ? 1 : 0;
    }

    _nativeUnary(value, operation) {
        const n = this._nativeNumValue(value);
        switch (operation) {
            case UN_NEG: return -n;
            case UN_ABS: return Math.abs(n);
            case UN_FLOOR: return Math.floor(n);
            case UN_CEIL: return Math.ceil(n);
            case UN_ROUND: return Math.round(n);
            case UN_SQRT: return n < 0 ? 0 : Math.sqrt(n);
            case UN_SQUARE: return n * n;
            case UN_FACTORIAL: return factorial(n);
            case UN_SIN: case UN_COS: case UN_TAN: return preciseTrig(n, operation);
            case UN_ASIN: return Math.asin(Math.max(-1, Math.min(1, n))) / DEG;
            case UN_ACOS: return Math.acos(Math.max(-1, Math.min(1, n))) / DEG;
            case UN_ATAN: return Math.atan(n) / DEG;
            case UN_LN: return n <= 0 ? 0 : Math.log(n);
            case UN_LOG: return n <= 0 ? 0 : Math.log10(n);
            case UN_FRAC: return n - Math.floor(n);
            default: return 0;
        }
    }

    _nativeStoreRegister(slot, value) {
        if (typeof value === 'string') this._setStr(slot, value);
        else this._setNum(slot, typeof value === 'number' ? value : this._nativeNumValue(value));
    }

    /** 현재 실행 엔티티에서 변수의 오브젝트별 셀을 찾는다. */
    _localVarCell(variable, entity = this.curEntity) {
        const local = this.varLocalSlot[variable];
        if (local < 0 || entity < 0 || entity >= this.entityCapacity) return -1;
        return this.entObject[entity] === this.varOwner[variable]
            ? entity * this.localVarCount + local
            : -1;
    }

    _setNum(slot, value) {
        this.regNum[slot] = value;
        this.regTag[slot] = TAG_NUM;
    }

    _setStr(slot, value) {
        this.regStr[slot] = boundedText(value);
        this.regTag[slot] = TAG_STR;
    }

    /** 텍스트 블록의 대상. 복제본 스레드면 복제본, 아니면 원본 엔티티다. */
    _textEntity(objectIndex) {
        return this.curEntity >= 0 && this.entObject[this.curEntity] === objectIndex
            ? this.curEntity : objectIndex;
    }

    /** 리스트 값을 레지스터로. 리스트는 숫자/문자가 섞일 수 있다. */
    _loadListValue(slot, value) {
        if (typeof value === 'number') this._setNum(slot, value);
        else {
            const n = Number(value);
            if (value !== '' && Number.isFinite(n)) this._setNum(slot, n);
            else this._setStr(slot, String(value === undefined ? '' : value));
        }
    }

    _regValue(slot) {
        return this.regTag[slot] === TAG_STR ? this.regStr[slot] : this.regNum[slot];
    }

    /** 테이블 열 표기: 1, "1", A, B, AA를 모두 1-base 번호로 바꾼다. */
    _tableColumn(value) {
        const number = Number(value);
        if (value !== '' && Number.isFinite(number)) return Math.trunc(number);
        const text = String(value ?? '').trim().toUpperCase();
        if (!/^[A-Z]+$/.test(text)) return 0;
        let column = 0;
        for (let i = 0; i < text.length; i += 1) column = column * 26 + text.charCodeAt(i) - 64;
        return column;
    }

    _tableValue(table, rowValue, colValue) {
        if (!table) return '';
        const rowNumber = Math.trunc(Number(rowValue));
        const col = this._tableColumn(colValue) - 1;
        if (col < 0 || col >= table.fields.length) return '';
        // Entry 테이블의 1행은 속성명 머리글이고 실제 데이터는 2행부터다.
        if (rowNumber === 1) return table.fields[col] ?? '';
        const row = rowNumber - 2;
        if (row < 0 || row >= table.rows.length) return '';
        return table.rows[row][col] ?? '';
    }

    _tableCell(cell) {
        const match = /^([A-Za-z]+)([1-9]\d*)$/.exec(String(cell ?? '').trim());
        if (!match) return null;
        return { row: Number(match[2]), col: this._tableColumn(match[1]) };
    }

    _tableCalc(table, colValue, operation) {
        if (!table || !table.rows.length) return 0;
        const col = this._tableColumn(colValue) - 1;
        if (col < 0 || col >= table.fields.length) return 0;
        const values = new Array(table.rows.length);
        let sum = 0;
        for (let i = 0; i < table.rows.length; i += 1) {
            const n = Number(table.rows[i][col]);
            values[i] = Number.isFinite(n) ? n : 0;
            sum += values[i];
        }
        switch (String(operation ?? '').toUpperCase()) {
            case 'SUM': return sum;
            case 'MAX': return Math.max(...values);
            case 'MIN': return Math.min(...values);
            case 'AVG': return sum / values.length;
            case 'STDEV': {
                if (values.length < 2) return 0;
                const avg = sum / values.length;
                let squareSum = 0;
                for (const value of values) squareSum += (value - avg) ** 2;
                return Math.sqrt(squareSum / (values.length - 1));
            }
            case 'MEDIAN': {
                values.sort((x, y) => x - y);
                const middle = Math.floor(values.length / 2);
                return (values[middle] + values[values.length - 1 - middle]) / 2;
            }
            default: return 0;
        }
    }

    // ── 그리기 ─────────────────────────────────────────────────────────
    _moveTo(x, y) {
        const pen = this.pen;
        // 엔트리에서 붓은 오브젝트에 달려 있다 — **좌표가 곧 엔티티 좌표**다.
        // 둘을 따로 들고 있으면 `x좌표를 100으로` 뒤에 선이 엉뚱한 데서 이어진다.
        const e = this.curEntity;
        if (e >= 0 && e < this.entX.length) { this.entX[e] = x; this.entY[e] = y; }
        if (pen.filling) pen.path.push(x, y);
        if (pen.down && !pen.filling) {
            this.sink.line(pen.x, pen.y, x, y, pen.thickness, pen.color, 1 - pen.opacity / 100);
            this.stats.lines += 1;
        }
        pen.x = x;
        pen.y = y;
    }

    // ── 엔티티 ─────────────────────────────────────────────────────────
    /**
     * 크기. 엔진에서 size는 퍼센트가 **아니라** 픽셀 평균이다
     * (`(가로·|scaleX| + 세로·|scaleY|)/2`). 퍼센트로 착각하면 `크기를 100으로`가
     * 모양에 따라 전혀 다른 크기를 낸다.
     */
    _getSize(e) {
        return (this.entW[e] * Math.abs(this.entScaleX[e])
            + this.entH[e] * Math.abs(this.entScaleY[e])) / 2;
    }

    /** `크기를 N으로` — 지금 크기와의 **비율**로 두 축을 같이 곱한다. */
    _setSize(e, size) {
        const cur = this._getSize(e);
        if (!(cur > 0)) return;              // 모양이 없으면 기준이 없다
        // 엔진이 `Math.max(1, size)`로 깎는다 — 0이나 음수로 뒤집히지 않는다.
        const scale = Math.max(1, size) / cur;
        this.entScaleX[e] *= scale;
        this.entScaleY[e] *= scale;
    }

    /** 0~359로 접는다. 엔트리의 `Number.mod`는 음수도 양수로 돌린다. */
    _mod360(v) {
        const m = v % 360;
        return m < 0 ? m + 360 : m;
    }

    _setRotation(e, v) {
        // 회전 방식이 'free'가 아니면 엔진은 회전을 **0으로 눌러 버린다**.
        // 이걸 빼면 좌우회전 오브젝트가 EniwanVM에서만 빙빙 돈다.
        const object = this.objects[this.entObject[e]];
        if (object && object.rotateMethod !== 'free') { this.entRot[e] = 0; return; }
        this.entRot[e] = this._mod360(v);
    }

    _setDirection(e, v) {
        const dir = this._mod360(v);
        const object = this.objects[this.entObject[e]];
        if (object && object.rotateMethod === 'vertical') {
            // 좌우회전 방식에서는 돌지 않고 **좌우로 뒤집힌다**(scaleX 부호).
            const wasRight = this.entDir[e] >= 0 && this.entDir[e] < 180;
            const isRight = dir >= 0 && dir < 180;
            if (wasRight !== isRight) this.entScaleX[e] = -this.entScaleX[e];
        }
        this.entDir[e] = dir;
    }

    /** Entry's touching reporter uses the rendered, rotated object bounds. */
    _entityCorners(e, out = new Float64Array(8)) {
        const rad = this.entRot[e] * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const w = this.entW[e];
        const h = this.entH[e];
        const regX = this.entRegX[e];
        const regY = this.entRegY[e];
        const us = [0, w, w, 0];
        const vs = [0, 0, h, h];
        for (let index = 0; index < 4; index += 1) {
            const lx = (us[index] - regX) * this.entScaleX[e];
            const ly = (vs[index] - regY) * this.entScaleY[e];
            out[index * 2] = this.entX[e] + cos * lx - sin * ly;
            out[index * 2 + 1] = this.entY[e] - (sin * lx + cos * ly);
        }
        return out;
    }

    _pointTouchesEntity(e, x, y) {
        if (!this.entAlive[e] || !this.entVisible[e] || !(this.entW[e] > 0) || !(this.entH[e] > 0)) return false;
        const quad = this._entityCorners(e);
        let positive = 0;
        let negative = 0;
        for (let index = 0; index < 4; index += 1) {
            const next = (index + 1) % 4;
            const ax = quad[index * 2];
            const ay = quad[index * 2 + 1];
            const bx = quad[next * 2];
            const by = quad[next * 2 + 1];
            const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
            if (cross > 0) positive += 1;
            else if (cross < 0) negative += 1;
        }
        const inside = positive === 0 || negative === 0;
        if (!inside) return false;
        return this.spriteAlphaHitTest ? this.spriteAlphaHitTest(e, x, y) : true;
    }

    _quadsOverlap(left, right) {
        for (const quad of [left, right]) {
            for (let edge = 0; edge < 4; edge += 1) {
                const next = (edge + 1) % 4;
                const dx = quad[next * 2] - quad[edge * 2];
                const dy = quad[next * 2 + 1] - quad[edge * 2 + 1];
                const axisX = -dy;
                const axisY = dx;
                let leftMin = Infinity; let leftMax = -Infinity;
                let rightMin = Infinity; let rightMax = -Infinity;
                for (let index = 0; index < 4; index += 1) {
                    const lp = left[index * 2] * axisX + left[index * 2 + 1] * axisY;
                    const rp = right[index * 2] * axisX + right[index * 2 + 1] * axisY;
                    leftMin = Math.min(leftMin, lp); leftMax = Math.max(leftMax, lp);
                    rightMin = Math.min(rightMin, rp); rightMax = Math.max(rightMax, rp);
                }
                if (leftMax < rightMin || rightMax < leftMin) return false;
            }
        }
        return true;
    }

    _touching(e, targetObject) {
        if (!this.entAlive[e] || !this.entVisible[e]) return false;
        if (targetObject === -1) {
            return this._pointTouchesEntity(e, this.host[HOST_MOUSE_X], this.host[HOST_MOUSE_Y]);
        }
        const own = this._entityCorners(e);
        if (targetObject === -2) {
            for (let index = 0; index < 4; index += 1) {
                const x = own[index * 2];
                const y = own[index * 2 + 1];
                if (x <= -240 || x >= 240 || y <= -135 || y >= 135) return true;
            }
            return false;
        }
        const other = new Float64Array(8);
        for (let target = 0; target < this.entityCapacity; target += 1) {
            if (target === e || !this.entAlive[target] || !this.entVisible[target]) continue;
            if (this.entObject[target] !== targetObject) continue;
            if (!(this.entW[target] > 0) || !(this.entH[target] > 0)) continue;
            this._entityCorners(target, other);
            if (this._quadsOverlap(own, other)) return true;
        }
        return false;
    }

    /** 무대 벽에 닿은 축만 반사한다. */
    _bounceAtWall(e) {
        const halfW = Math.abs(this.entW[e] * this.entScaleX[e]) / 2;
        const halfH = Math.abs(this.entH[e] * this.entScaleY[e]) / 2;
        const hitX = this.entX[e] - halfW <= -240 || this.entX[e] + halfW >= 240;
        const hitY = this.entY[e] - halfH <= -135 || this.entY[e] + halfH >= 135;
        if (!hitX && !hitY) return;
        const object = this.objects[this.entObject[e]];
        const absolute = this._mod360(this.entRot[e] + this.entDir[e]);
        let reflected = absolute;
        if (hitX) reflected = 360 - reflected;
        if (hitY) reflected = 180 - reflected;
        reflected = this._mod360(reflected);
        if (object && object.rotateMethod === 'free') {
            this._setRotation(e, reflected - this.entDir[e]);
        } else {
            this._setDirection(e, reflected);
        }
    }

    _effect(e, kind) {
        if (kind === EF_COLOR) return this.entHsv[e];
        if (kind === EF_BRIGHTNESS) return this.entBright[e];
        if (kind === EF_TRANSPARENCY) return this.entAlpha[e];
        return 0;
    }

    _setEffect(e, kind, value) {
        // 색깔·밝기는 **깎지 않고 날것으로** 둔다. 엔진은 값을 넣을 때 자르지 않고
        // (`effect.hsv = value`), 그릴 때만 `adjust(brightness,-100,100)`로 쓰면서
        // 그 결과를 되쓰지 않는다. 그래서 `밝기 150 → -100 만큼 바꾸기`는 엔트리에서
        // 50으로 보인다 — 넣을 때 100으로 깎으면 0이 되어 **조용히 다른 그림**이 된다.
        // 색깔도 400이면 엔진은 `|400/100|=4 → 소수부 0` = 효과 없음이 되는데,
        // 0~359로 접으면 40(= 효과 있음)이 되어 색이 달라진다.
        //
        // 투명도만 예외다 — 엔진이 `e.alpha = adjust(e.alpha, 0, 1)`로 **되쓴다**.
        if (kind === EF_COLOR) this.entHsv[e] = value;
        else if (kind === EF_BRIGHTNESS) this.entBright[e] = value;
        else if (kind === EF_TRANSPARENCY) this.entAlpha[e] = Math.max(0, Math.min(100, value));
    }

    _setShape(e, idx) {
        const object = this.objects[this.entObject[e]];
        if (!object || !object.pictures[idx]) return;
        this.entShape[e] = idx;
        // 모양이 바뀌면 **기준 크기도 바뀐다**. 폭/높이를 갱신하지 않으면 그 뒤의
        // `크기를 N으로`가 이전 모양 기준으로 계산돼 조용히 어긋난다.
        //
        // 회전 중심은 엔진처럼(`setImage`) **가운데에서의 치우침을 보존**한다:
        // 새 regX = 새폭/2 + (옛 regX - 옛폭/2). 가운데였으면 계속 가운데다.
        const offX = this.entRegX[e] - this.entW[e] / 2;
        const offY = this.entRegY[e] - this.entH[e] / 2;
        this.entW[e] = object.pictures[idx].width || this.entW[e];
        this.entH[e] = object.pictures[idx].height || this.entH[e];
        this.entRegX[e] = this.entW[e] / 2 + offX;
        this.entRegY[e] = this.entH[e] / 2 + offY;
    }

    /** 에셋을 id → 이름 → **1부터 세는 번호** 순으로 찾는다(엔진 `getPicture`와 같다). */
    _resolveAsset(assets, value) {
        if (value === undefined || value === null || value === '') return -1;
        const key = String(value).trim();
        for (let i = 0; i < assets.length; i += 1) if (assets[i].id === key) return i;
        for (let i = 0; i < assets.length; i += 1) if (assets[i].name === key) return i;
        const n = Number(key);
        if (Number.isFinite(n) && n > 0 && n <= assets.length) return Math.floor(n) - 1;
        return -1;
    }

    _resolveShape(e, value) {
        const object = this.objects[this.entObject[e]];
        return object ? this._resolveAsset(object.pictures, value) : -1;
    }

    /** `(오브젝트)의 x좌푯값` 류. 문자를 돌려주는 속성(모양 이름)도 있다. */
    _loadEnt(dst, prop, e) {
        if (!(e >= 0) || e >= this.entityCapacity) {
            // 없는 엔티티를 물으면 0/빈 문자다 — 던지면 작품 전체가 멈춘다.
            if (prop === ENT_PICTURE_NAME) this._setStr(dst, '');
            else this._setNum(dst, 0);
            return;
        }
        switch (prop) {
            case ENT_X: this._setNum(dst, this.entX[e]); break;
            case ENT_Y: this._setNum(dst, this.entY[e]); break;
            case ENT_ROTATION: this._setNum(dst, this.entRot[e]); break;
            case ENT_DIRECTION: this._setNum(dst, this.entDir[e]); break;
            case ENT_SIZE: this._setNum(dst, this._getSize(e)); break;
            // 모양 번호는 **1부터** 센다(엔트리 쪽 표시와 맞춘다).
            case ENT_PICTURE_INDEX: this._setNum(dst, this.entShape[e] + 1); break;
            case ENT_PICTURE_NAME: {
                const object = this.objects[this.entObject[e]];
                const picture = object ? object.pictures[this.entShape[e]] : null;
                this._setStr(dst, picture ? picture.name : '');
                break;
            }
            default: this._setNum(dst, 0); break;
        }
    }

    /** 오브젝트 번호 → 그 오브젝트의 **원본** 엔티티 번호. */
    _originOf(objectIndex) {
        return objectIndex >= 0 && objectIndex < this.objects.length ? objectIndex : -1;
    }

    // ── 복제본 ─────────────────────────────────────────────────────────
    /**
     * `fromEntity`를 복제한다. 좌표·방향·크기·효과·붓까지 **그대로** 물려받고
     * (엔진의 `addCloneEntity`가 그렇다), 복제본의 `when_clone_start`가 깨어난다.
     */
    _clone(fromEntity, _ti) {
        if (!(fromEntity >= 0) || !this.entAlive[fromEntity]) return -1;
        const objectIndex = this.entObject[fromEntity];
        // 상한은 오브젝트마다 센다. 엔진은 `> 360`에서 거절하므로 361개까지 생긴다.
        if (this.cloneCount[objectIndex] > this.maxClonesPerObject - 1) return -1;
        let slot = -1;
        for (let i = this.objects.length; i < this.entityCapacity; i += 1) {
            if (!this.entAlive[i]) { slot = i; break; }
        }
        // 풀이 꽉 찼다. 조용히 넘기지 않고 overruns로 드러낸다 — "복제본이
        // 가끔 안 생긴다"는 원인 모를 버그로 남는 게 가장 나쁘다.
        if (slot < 0) { this.stats.overruns += 1; return -1; }

        this.entObject[slot] = objectIndex;
        this.entAlive[slot] = 1;
        this.entIsClone[slot] = 1;
        this.entX[slot] = this.entX[fromEntity];
        this.entY[slot] = this.entY[fromEntity];
        this.entRot[slot] = this.entRot[fromEntity];
        this.entDir[slot] = this.entDir[fromEntity];
        this.entScaleX[slot] = this.entScaleX[fromEntity];
        this.entScaleY[slot] = this.entScaleY[fromEntity];
        this.entW[slot] = this.entW[fromEntity];
        this.entH[slot] = this.entH[fromEntity];
        this.entVisible[slot] = this.entVisible[fromEntity];
        this.entShape[slot] = this.entShape[fromEntity];
        this.entRegX[slot] = this.entRegX[fromEntity];
        this.entRegY[slot] = this.entRegY[fromEntity];
        this.entHsv[slot] = this.entHsv[fromEntity];
        this.entBright[slot] = this.entBright[fromEntity];
        this.entAlpha[slot] = this.entAlpha[fromEntity];
        this.entTexts[slot] = this.entTexts[fromEntity] ?? '';
        this.entTextStyles[slot] = { ...(this.entTextStyles[fromEntity] || {}) };
        if (this.localVarCount) {
            const from = fromEntity * this.localVarCount;
            const to = slot * this.localVarCount;
            for (let i = 0; i < this.localVarCount; i += 1) {
                this.localVarNum[to + i] = this.localVarNum[from + i];
                this.localVarTag[to + i] = this.localVarTag[from + i];
                this.localVarStr[to + i] = this.localVarStr[from + i];
            }
        }
        const src = this.pens[fromEntity];
        const dst = this.pens[slot];
        dst.down = src.down; dst.x = src.x; dst.y = src.y;
        dst.thickness = src.thickness; dst.color = src.color; dst.opacity = src.opacity;
        dst.fillColor = src.fillColor; dst.fillOpacity = src.fillOpacity;
        // 채우기는 **물려받지 않는다**. 반쯤 그려진 경로를 복제본이 이어 그리면
        // 원본이 `채우기 끝내기`를 할 때 엉뚱한 도형이 나온다.
        dst.filling = false; dst.path.length = 0;
        this.cloneCount[objectIndex] += 1;

        this._raiseOnEntity('when_clone_start', slot, -1);
        return slot;
    }

    /** 엔티티를 치우고 그 엔티티에 붙은 줄도 모두 끈다. */
    _killEntity(e) {
        if (!this.entAlive[e]) return;
        this.entAlive[e] = 0;
        const objectIndex = this.entObject[e];
        if (this.entIsClone[e] && objectIndex >= 0 && this.cloneCount[objectIndex] > 0) {
            this.cloneCount[objectIndex] -= 1;
        }
        this.entIsClone[e] = 0;
        for (let i = 0; i < this.rowCount; i += 1) {
            if (this.rowEntity[i] === e) { this.alive[i] = 0; this.rowSleep[i] = 0; }
        }
        const pen = this.pens[e];
        pen.filling = false;
        pen.path.length = 0;
    }

    /** `(오브젝트)의 복제본 모두 삭제하기` — 원본은 건드리지 않는다. */
    _clearClones(objectIndex) {
        for (let i = this.objects.length; i < this.entityCapacity; i += 1) {
            if (this.entAlive[i] && this.entIsClone[i]
                && (objectIndex < 0 || this.entObject[i] === objectIndex)) {
                this._killEntity(i);
            }
        }
    }

    /** 줄 하나를 잡아 `script`를 `entity`에서 처음부터 돌린다. */
    _spawn(entity, script) {
        let row = -1;
        for (let i = this.scriptCount; i < this.rowCount; i += 1) {
            if (!this.alive[i]) { row = i; break; }
        }
        if (row < 0) {
            if (this.rowCount >= this.rowCapacity) this._growRows();
            row = this.rowCount;
            this.rowCount += 1;
        }
        const thread = this.program.threads[script];
        this.pc[row] = thread.pc;
        this.base[row] = row * this.regCapacity;
        this.depth[row] = 0;
        this.rowScript[row] = script;
        this.rowEntity[row] = entity;
        this.rowSleep[row] = 0;
        this.alive[row] = 1;
        // 틱 중에 깨운 줄은 **다음 틱**부터 돈다. 그래야 "몇 번째 줄이었나"에
        // 따라 같은 작품이 다르게 도는 일이 없다.
        this.rowWakeTick[row] = this._inTick ? this.stats.ticks + 1 : -1;
        // 레지스터를 비워 둔다 — 아까 그 줄을 쓰던 다른 복제본의 값이 남아
        // 있으면 "첫 프레임만 이상한" 버그가 된다.
        const from = row * this.regCapacity;
        for (let i = from; i < from + this.regCapacity; i += 1) {
            this.regNum[i] = 0;
            this.regTag[i] = TAG_NUM;
            this.regStr[i] = '';
        }
        return row;
    }

    /** 한 엔티티에서 `event` 스크립트들을 깨운다(복제본 시작 등). */
    _raiseOnEntity(event, entity, arg) {
        const objectIndex = this.entObject[entity];
        let woken = 0;
        for (let s = 0; s < this.scriptCount; s += 1) {
            const t = this.program.threads[s];
            if (t.event !== event || t.objectIndex !== objectIndex) continue;
            if (arg >= 0 && t.arg !== arg) continue;
            this._spawn(entity, s);
            woken += 1;
        }
        return woken;
    }

    // ── 실행 ───────────────────────────────────────────────────────────
    /**
     * 논리 틱 하나를 명령 예산만큼 진행한다. 예산에 닿으면 같은 틱의 같은
     * 스레드에서 다음 화면 프레임에 이어 간다. 이미 YIELD까지 간 다른 줄은
     * 다시 실행하지 않아, 무거운 렌더 루프가 작품 시간을 여러 번 앞당기지 않는다.
     * @returns {{steps:number, complete:boolean}}
     */
    runTickChunk() {
        if (!this.tickInProgress) {
            this.tickInProgress = true;
            this.tickSteps = 0;
            this.tickStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
            this.rowTickDone.fill(0);
            this.restartRequested = false;
            if (this.timerRunning) {
                this.timerTicks += 1;
                this.host[HOST_TIMER] = this.timerTicks / this.logicHz;
            }
        }

        this._inTick = true;
        let steps = 0;
        let paused = false;
        for (let i = 0; i < this.rowCount; i += 1) {
            if (this.rowTickDone[i]) continue;
            if (!this.alive[i] || this.rowWakeTick[i] > this.stats.ticks
                || this.rowAwaitAnswer[i]) {
                this.rowTickDone[i] = 1;
                continue;
            }
            if (this.rowSleep[i] > 0) {
                this.rowSleep[i] -= 1;
                this.rowTickDone[i] = 1;
                continue;
            }
            const pauseCount = this.stats.budgetPauses;
            steps += this._runThread(i);
            if (this.stats.budgetPauses > pauseCount) {
                paused = true;
                break;
            }
            this.rowTickDone[i] = 1;
            if (this.restartRequested) break;
        }
        this.tickSteps += steps;

        if (this.restartRequested) {
            this._inTick = false;
            this.reset();
            return { steps, complete: true };
        }
        if (paused) return { steps, complete: false };

        this._inTick = false;
        this.tickInProgress = false;
        this.stats.ticks += 1;
        this.stats.steps += this.tickSteps;
        this.stats.lastTickSteps = this.tickSteps;
        this.stats.lastTickMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())
            - this.tickStartedAt;
        return { steps, complete: true };
    }

    /**
     * 살아 있는 모든 스레드를 한 틱씩 전진시킨다.
     * 각 스레드는 YIELD·HALT를 만나거나 스텝 예산을 다 쓸 때까지 돈다.
     */
    runTick() {
        const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        let steps = 0;
        // `rowCount`는 복제본이 생기면 틱 중에도 늘어난다. 새로 생긴 줄은
        // **그 틱 안에서** 한 번 돈다 — 엔진이 `when_clone_start`를 복제 직후에
        // 돌리는 것과 같은 순서다.
        this._inTick = true;
        this.restartRequested = false;
        // 초시계는 `시작하기`를 만난 뒤부터 **틱으로** 흐른다. 벽시계를 쓰면
        // 프레임이 밀릴 때 작품 속 시간이 로직 틱과 어긋난다.
        if (this.timerRunning) {
            this.timerTicks += 1;
            this.host[HOST_TIMER] = this.timerTicks / this.logicHz;
        }
        for (let i = 0; i < this.rowCount; i += 1) {
            if (!this.alive[i]) continue;
            // 이 틱 안에서 깨어난 줄(복제본 시작·신호)은 다음 틱부터 돈다.
            if (this.rowWakeTick[i] > this.stats.ticks) continue;
            // 대답을 기다리는 줄만 멈춘다 — 엔진도 입력창이 떠 있어도 다른
            // 오브젝트의 코드는 계속 돈다.
            if (this.rowAwaitAnswer[i]) continue;
            if (this.rowSleep[i] > 0) { this.rowSleep[i] -= 1; continue; }
            steps += this._runThread(i);
            if (this.restartRequested) break;
        }
        this._inTick = false;
        if (this.restartRequested) {
            this.reset();
            return steps;
        }
        this.stats.ticks += 1;
        this.stats.steps += steps;
        this.stats.lastTickSteps = steps;
        this.stats.lastTickMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
        return steps;
    }

    _runThread(ti) {
        const code = this.program.code;
        const consts = this.program.consts;
        const strings = this.program.strings;
        const budget = this.maxStepsPerTick;
        let pc = this.pc[ti];
        let base = this.base[ti];
        let steps = 0;
        // 이 줄이 어느 엔티티의 것인지 **여기서 한 번만** 정한다. 옵코드마다
        // 다시 찾으면 그 비용이 명령마다 붙고, 중간에 복제본이 생기면 같은
        // 줄이 다른 엔티티를 가리키게 되는 사고도 난다.
        const ent = this.rowEntity[ti];
        this.curEntity = ent;
        this.pen = this.pens[ent >= 0 ? ent : 0];

        for (;;) {
            if (steps >= budget) {
                this.stats.overruns += 1;
                this.stats.budgetPauses += 1;
                break;
            }
            steps += 1;
            const o = pc * INSTR_WORDS;
            const op = code[o];
            if (this.opCounts) this.opCounts[op] += 1;
            const a = code[o + 1];
            const b = code[o + 2];
            const c = code[o + 3];
            pc += 1;

            switch (op) {
                case OP_CONST: {
                    const dst = base + a;
                    this.regNum[dst] = consts[b]; this.regTag[dst] = TAG_NUM;
                    break;
                }
                case OP_CONSTSTR: {
                    const dst = base + a;
                    this.regStr[dst] = strings[b]; this.regTag[dst] = TAG_STR;
                    break;
                }
                case OP_MOV: {
                    const src = base + b, dst = base + a;
                    if (this.regTag[src] === TAG_STR) {
                        this.regStr[dst] = this.regStr[src]; this.regTag[dst] = TAG_STR;
                    } else {
                        this.regNum[dst] = this.regNum[src]; this.regTag[dst] = TAG_NUM;
                    }
                    break;
                }
      case OP_LOADLOCAL: {
                    // 엔진: `localVariable?.value || 0`. 빈 문자열·0·NaN은 **숫자 0**이
                    // 되고 `'0'`같은 참인 문자는 문자로 남는다. 선언 초기값이 전부
                    // 빈 문자열이라, 이 보정이 없으면 `지역변수 + 1`이 `'1'`이 아니라
                    // 문자 이어붙이기처럼 보이는 자리에서 틀어진다.
                    const src = base + b, dst = base + a;
                    if (this.regTag[src] === TAG_STR) {
                        const s = this.regStr[src];
                        if (s) { this.regStr[dst] = s; this.regTag[dst] = TAG_STR; }
                        else { this.regNum[dst] = 0; this.regTag[dst] = TAG_NUM; }
                    } else {
                        const n = this.regNum[src];
                        this.regNum[dst] = n || 0; this.regTag[dst] = TAG_NUM;
                    }
                    break;
                }
            case OP_LOADVAR: {
                const dst = base + a;
                const cell = this._localVarCell(b, ent);
                const tag = cell >= 0 ? this.localVarTag[cell] : this.varTag[b];
                if (tag === TAG_STR) {
                    this._setStr(dst, cell >= 0 ? this.localVarStr[cell] : this.varStr[b]);
                } else {
                    this._setNum(dst, cell >= 0 ? this.localVarNum[cell] : this.varNum[b]);
                }
                break;
            }
            case OP_STOREVAR: {
                const src = base + b;
                const cell = this._localVarCell(a, ent);
                if (this.regTag[src] === TAG_STR) {
                    if (cell >= 0) {
                        this.localVarStr[cell] = this.regStr[src]; this.localVarTag[cell] = TAG_STR;
                    } else {
                        this.varStr[a] = this.regStr[src]; this.varTag[a] = TAG_STR;
                    }
                } else {
                    if (cell >= 0) {
                        this.localVarNum[cell] = this.regNum[src]; this.localVarTag[cell] = TAG_NUM;
                    } else {
                        this.varNum[a] = this.regNum[src]; this.varTag[a] = TAG_NUM;
                    }
                }
                break;
            }
            case OP_ADDVAR: {
                const cell = this._localVarCell(a, ent);
                if (cell >= 0) {
                    const current = this.localVarTag[cell] === TAG_NUM
                        ? this.localVarNum[cell] : this.localVarStr[cell];
                    this.localVarStr[cell] = entryChangedValue(current, this._regValue(base + b));
                    this.localVarTag[cell] = TAG_STR;
                } else {
                    const current = this.varTag[a] === TAG_NUM ? this.varNum[a] : this.varStr[a];
                    this.varStr[a] = entryChangedValue(current, this._regValue(base + b));
                    this.varTag[a] = TAG_STR;
                }
                break;
            }
                case OP_LOADHOST: {
                    this.hostReadCounts[b] += 1;
                    if (HOST_IS_STRING[b]) {
                        this._setStr(base + a, this.hostStr[b]);
                        break;
                    }
                    this._setNum(base + a, this.host[b]);
                    // 델타 슬롯은 읽는 순간 비워진다(위 HOST_CONSUME_ON_READ 설명).
                    if (HOST_CONSUME_ON_READ[b]) this.host[b] = 0;
                    break;
                }
                case OP_STOREHOST: {
                    // 정체는 작품이 못 바꾼다. 시작할 때 변수를 0으로 초기화하는
                    // 흔한 코드 하나가 `is_Eniwan`을 지우면, 그 뒤의 기능 분기가
                    // 전부 "엔트리로 돌고 있다"로 넘어간다.
                    if (a === HOST_IS_ENIWAN || (a === HOST_IS_TESSVM && this.tessCompatibility)) break;
                    if (HOST_IS_STRING[a]) {
                        // 길이는 여기서 자른다. 작품이 리스트를 이어 붙여 수십 MB를
                        // 클립보드에 밀어 넣는 것은 사고지 기능이 아니다.
                        const text = this._str(base + b);
                        this.hostStr[a] = text.length > HOST_TEXT_MAX
                            ? text.slice(0, HOST_TEXT_MAX) : text;
                        this.hostWrites.add(HOST_WRITE_ACTIONS[a]);
                        break;
                    }
                    const value = this._num(base + b);
                    this.host[a] = value;
                    // 렌더 상태는 호스트(배처)에 바로 전달한다. sink가 2D
                    // 기록기면 이 두 훅이 없고, 그 경우 조용히 무시된다.
                    if (a === HOST_DEPTH) {
                        if (this.sink.depth) this.sink.depth(value);
                    } else if (a === HOST_DEPTH_TEST) {
                        if (this.sink.depthTest) this.sink.depthTest(value !== 0);
                    } else if (HOST_WRITE_ACTIONS[a]) {
                        // 포인터 락처럼 브라우저 API가 필요한 것은 호스트가 한다.
                        this.hostWrites.add(HOST_WRITE_ACTIONS[a]);
                    }
                    break;
                }

                case OP_ADD: {
                    // Entry는 태그가 아니라 값으로 숫자인지 판정한다. 따라서 text
                    // 블록에서 온 "350"과 "1"도 351이 된다. 태그만 보고 문자열을
                    // 붙이면 압축 배열의 인덱스 계산이 "35011"로 망가진다.
                    const l = base + b, r = base + c;
        // 계산 루프의 대부분은 이미 숫자 태그다. 이 빠른 경로에서는
        // 문자열 생성과 정규식 검사를 전혀 하지 않는다.
        if (this.regTag[l] === TAG_NUM && this.regTag[r] === TAG_NUM) {
          this._setNum(base + a, this.regNum[l] + this.regNum[r]);
          break;
        }
        const lv = this._regValue(l);
                    const rv = this._regValue(r);
                    if (!isEntryNumber(lv) || !isEntryNumber(rv)) {
                        this._setStr(base + a, boundedConcat(this._str(l), this._str(r)));
                    } else {
                        this._setNum(base + a, Number(lv) + Number(rv));
                    }
                    break;
                }
                case OP_SUB: this._setNum(base + a, this._num(base + b) - this._num(base + c)); break;
                case OP_MUL: this._setNum(base + a, this._num(base + b) * this._num(base + c)); break;
                case OP_SUB_LL:
                case OP_MUL_LL:
                case OP_DIV_LL:
                case OP_MOD_LL:
                case OP_QUOT_LL:
                case OP_LT_LL:
                case OP_GT_LL:
                case OP_LE_LL:
                case OP_GE_LL: {
                    const left = this._localNum(base + b);
                    const right = this._localNum(base + c);
                    let value = 0;
                    if (op === OP_SUB_LL) value = left - right;
                    else if (op === OP_MUL_LL) value = left * right;
                    else if (op === OP_DIV_LL) value = right === 0 ? 0 : left / right;
                    else if (op === OP_MOD_LL) value = right === 0 ? 0 : left - right * Math.floor(left / right);
                    else if (op === OP_QUOT_LL) value = right === 0 ? 0 : Math.floor(left / right);
                    else if (op === OP_LT_LL) value = left < right ? 1 : 0;
                    else if (op === OP_GT_LL) value = left > right ? 1 : 0;
                    else if (op === OP_LE_LL) value = left <= right ? 1 : 0;
                    else value = left >= right ? 1 : 0;
                    const dst = base + a;
                    this.regNum[dst] = value;
                    this.regTag[dst] = TAG_NUM;
                    break;
                }
                case OP_DIV: {
                    const d = this._num(base + c);
                    // 0으로 나누면 Infinity가 되고, 그게 좌표로 흘러가면 그 프레임의
                    // 드로우콜이 통째로 사라진다. 0으로 막는다.
                    this._setNum(base + a, d === 0 ? 0 : this._num(base + b) / d);
                    break;
                }
                case OP_MOD: {
                    const d = this._num(base + c);
                    const n = this._num(base + b);
                    this._setNum(base + a, d === 0 ? 0 : n - d * Math.floor(n / d));
                    break;
                }
                case OP_QUOT: {
                    const d = this._num(base + c);
                    this._setNum(base + a, d === 0 ? 0 : Math.floor(this._num(base + b) / d));
                    break;
                }
                case OP_UNARY: {
                    const v = this._num(base + b);
                    let r = 0;
                    switch (c) {
                        case UN_NEG: r = -v; break;
                        case UN_ABS: r = Math.abs(v); break;
                        case UN_FLOOR: r = Math.floor(v); break;
                        case UN_CEIL: r = Math.ceil(v); break;
                        case UN_ROUND: r = Math.round(v); break;
                        case UN_SQRT: r = v < 0 ? 0 : Math.sqrt(v); break;
                        case UN_SQUARE: r = v * v; break;
                        case UN_FACTORIAL: r = factorial(v); break;
                        // 엔트리의 삼각함수 인자는 도(degree)이고, 특수각은 테이블 값이다.
                        case UN_SIN: case UN_COS: case UN_TAN: r = preciseTrig(v, c); break;
                        case UN_ASIN: r = Math.asin(Math.max(-1, Math.min(1, v))) / DEG; break;
                        case UN_ACOS: r = Math.acos(Math.max(-1, Math.min(1, v))) / DEG; break;
                        case UN_ATAN: r = Math.atan(v) / DEG; break;
                        case UN_LN: r = v <= 0 ? 0 : Math.log(v); break;
                        case UN_LOG: r = v <= 0 ? 0 : Math.log10(v); break;
                        // 'unnatural' = 소수부. 음수면 엔진처럼 1에서 뺀다.
                        case UN_FRAC: {
                            const frac = v - Math.floor(v);
                            r = v < 0 ? 1 - frac : frac;
                            break;
                        }
                        default: r = v; break;
                    }
                    this._setNum(base + a, r);
                    break;
                }
                case OP_ATAN2:
                    this._setNum(base + a, Math.atan2(this._num(base + b), this._num(base + c)) / DEG);
                    break;
                case OP_RAND: {
                    const lo = this._num(base + b), hi = this._num(base + c);
                    // Entry convention: If both operands are integers, generate integer in [min(lo, hi), max(lo, hi)] inclusive.
                    if (Number.isInteger(lo) && Number.isInteger(hi)) {
                        const min = Math.min(lo, hi), max = Math.max(lo, hi);
                        this._setNum(base + a, Math.floor(Math.random() * (max - min + 1)) + min);
                    } else {
                        const min = Math.min(lo, hi), max = Math.max(lo, hi);
                        this._setNum(base + a, min + Math.random() * (max - min));
                    }
                    break;
                }
                case OP_CONCAT:
                    this._setStr(base + a, boundedConcat(this._str(base + b), this._str(base + c)));
                    break;
                case OP_RGBHEX: {
                    // Entry.rgb2hex와 같은 32비트 비트연산/문자 변환이다.
                    const r = this._num(base + b) << 16;
                    const g = this._num(base + b + 1) << 8;
                    const blue = this._num(base + b + 2);
                    this._setStr(base + a, `#${((1 << 24) + r + g + blue).toString(16).slice(1)}`);
                    break;
                }
                case OP_HEXRGB: {
                    let hex = this._str(base + b);
                    if (!/^#[0-9a-f]{6}$/i.test(hex)) hex = '#000000';
                    const offset = 1 + c * 2;
                    this._setNum(base + a, parseInt(hex.slice(offset, offset + 2), 16));
                    break;
                }
                case OP_SETVARVISIBLE:
                    if (b) {
                        if (a >= 0 && a < this.listVisible.length) this.listVisible[a] = c ? 1 : 0;
                    } else if (a >= 0 && a < this.varVisible.length) {
                        this.varVisible[a] = c ? 1 : 0;
                    }
                    break;

                case OP_LT: this._setNum(base + a, this._num(base + b) < this._num(base + c) ? 1 : 0); break;
                case OP_GT: this._setNum(base + a, this._num(base + b) > this._num(base + c) ? 1 : 0); break;
                case OP_LE: this._setNum(base + a, this._num(base + b) <= this._num(base + c) ? 1 : 0); break;
                case OP_GE: this._setNum(base + a, this._num(base + b) >= this._num(base + c) ? 1 : 0); break;
                case OP_EQ: {
                    const l = base + b, r = base + c;
                    const same = this._nativeEqual(this._regValue(l), this._regValue(r));
                    this._setNum(base + a, same ? 1 : 0);
                    break;
                }
                case OP_NE: {
                    const l = base + b, r = base + c;
                    this._setNum(base + a,
                        this._nativeNotEqual(this._regValue(l), this._regValue(r)) ? 1 : 0);
                    break;
                }
                case OP_AND:
                    this._setNum(base + a, (this._num(base + b) !== 0 && this._num(base + c) !== 0) ? 1 : 0);
                    break;
                case OP_OR:
                    this._setNum(base + a, (this._num(base + b) !== 0 || this._num(base + c) !== 0) ? 1 : 0);
                    break;
                case OP_NOT:
                    this._setNum(base + a, this._num(base + b) === 0 ? 1 : 0);
                    break;

                case OP_LISTGET: {
                    const list = this.lists[b];
                    const idx = Math.round(this._num(base + c)) - 1;   // 엔트리는 1부터
                    this._loadListValue(base + a, idx >= 0 && idx < list.length ? list[idx] : 0);
                    break;
                }
                case OP_LISTGET_L: {
                    const list = this.lists[b];
                    const idx = Math.round(this._localNum(base + c)) - 1;
                    this._loadListValue(base + a, idx >= 0 && idx < list.length ? list[idx] : 0);
                    break;
                }
                case OP_LISTSET: {
                    const list = this.lists[a];
                    const idx = Math.round(this._num(base + b)) - 1;
                if (idx >= 0 && idx < list.length) {
                    list[idx] = this._regValue(base + c);
                    this.listVersions[a] += 1;
                }
                    break;
                }
                case OP_LISTSET_LL: {
                    const list = this.lists[a];
                    const idx = Math.round(this._localNum(base + b)) - 1;
                    if (idx >= 0 && idx < list.length) {
                        const slot = base + c;
                        list[idx] = this.regTag[slot] === TAG_STR
                            ? (this.regStr[slot] || 0) : (this.regNum[slot] || 0);
                        this.listVersions[a] += 1;
                    }
                    break;
                }
                case OP_LISTLEN: this._setNum(base + a, this.lists[b].length); break;
            case OP_LISTPUSH:
                this.lists[a].push(this._regValue(base + b));
                this.listVersions[a] += 1;
                break;
                case OP_LISTINS: {
                    const list = this.lists[a];
                    const idx = Math.round(this._num(base + b)) - 1;
        list.splice(Math.max(0, Math.min(idx, list.length)), 0,
                        this._regValue(base + c));
                this.listVersions[a] += 1;
                    break;
                }
                case OP_LISTDEL: {
                    const list = this.lists[a];
                    const idx = Math.round(this._num(base + b)) - 1;
                if (idx >= 0 && idx < list.length) {
                    list.splice(idx, 1);
                    this.listVersions[a] += 1;
                }
                    break;
                }
            case OP_LISTCLEAR:
                if (this.lists[a].length) {
                    this.lists[a].length = 0;
                    this.listVersions[a] += 1;
                }
                break;

                case OP_TABLECOUNT: {
                    const table = this.tables[b];
                    // Entry의 ROW 개수는 머리글 행을 포함한다.
                    this._setNum(base + a, table ? (c ? table.fields.length : table.rows.length + 1) : 0);
                    break;
                }
                case OP_TABLEGET: {
                    const value = this._tableValue(this.tables[b],
                        this._regValue(base + c), this._regValue(base + c + 1));
                    this._loadListValue(base + a, value);
                    break;
                }
                case OP_TABLESET: {
                    const table = this.tables[a];
                    if (!table) break;
                    const rowNumber = Math.trunc(this._num(base + b));
                    const col = this._tableColumn(this._regValue(base + b + 1)) - 1;
                    if (rowNumber === 1 && col >= 0 && col < table.fields.length) {
                        table.fields[col] = this._regValue(base + b + 2);
                        break;
                    }
                    const row = rowNumber - 2;
                    if (row >= 0 && row < table.rows.length && col >= 0 && col < table.fields.length) {
                        table.rows[row][col] = this._regValue(base + b + 2);
                    }
                    break;
                }
                case OP_TABLEAPPEND: {
                    const table = this.tables[a];
                    if (!table) break;
                    if (b) {
                        table.fields.push('');
                        for (const row of table.rows) row.push(0);
                    } else table.rows.push(new Array(table.fields.length).fill(0));
                    break;
                }
                case OP_TABLEINSERT:
                case OP_TABLEDELETE: {
                    const table = this.tables[a];
                    if (!table) break;
                    const index = Math.max(0, Math.trunc(this._num(base + b)) - 1);
                    const remove = op === OP_TABLEDELETE;
                    if (c) {
                        if (remove) {
                            if (index < table.fields.length) {
                                table.fields.splice(index, 1);
                                for (const row of table.rows) row.splice(index, 1);
                            }
                        } else {
                            const at = Math.min(index, table.fields.length);
                            table.fields.splice(at, 0, '');
                            for (const row of table.rows) row.splice(at, 0, 0);
                        }
                    } else if (remove) {
                        if (index < table.rows.length) table.rows.splice(index, 1);
                    } else {
                        table.rows.splice(Math.min(index, table.rows.length), 0,
                            new Array(table.fields.length).fill(0));
                    }
                    break;
                }
                case OP_TABLECALC:
                    this._setNum(base + a, this._tableCalc(this.tables[b],
                        this._regValue(base + c), this._regValue(base + c + 1)));
                    break;
                case OP_TABLECELLGET: {
                    const cell = this._tableCell(this._regValue(base + c));
                    const value = cell ? this._tableValue(this.tables[b], cell.row, cell.col) : '';
                    this._loadListValue(base + a, value);
                    break;
                }
                case OP_TABLECELLSET: {
                    const table = this.tables[a];
                    const cell = this._tableCell(this._regValue(base + b));
                    if (!table || !cell) break;
                    const col = cell.col - 1;
                    const value = this._regValue(base + b + 1);
                    if (cell.row === 1 && col >= 0 && col < table.fields.length) {
                        table.fields[col] = value;
                    } else {
                        const row = cell.row - 2;
                        if (row >= 0 && row < table.rows.length && col >= 0 && col < table.fields.length) {
                            table.rows[row][col] = value;
                        }
                    }
                    break;
                }

                case OP_PENDOWN: this.pen.down = true; break;
                case OP_PENUP: this.pen.down = false; break;
                case OP_SETCOLOR: this.pen.color = strings[a]; break;
                case OP_SETCOLORREG: this.pen.color = this._str(base + a); break;
                case OP_SETFILLCOLOR: this.pen.fillColor = strings[a]; break;
                case OP_SETFILLCOLORREG: this.pen.fillColor = this._str(base + a); break;
                case OP_SETTHICK: this.pen.thickness = Math.max(0, this._num(base + a)); break;
                // 엔진은 상대 변경에서 굵기를 최소 1로 클램프한다.
                case OP_ADDTHICK:
                    this.pen.thickness = Math.max(1, this.pen.thickness + this._num(base + a));
                    break;
                case OP_SETALPHA:
                    this.pen.opacity = Math.max(0, Math.min(100, this._num(base + a)));
                    break;
                case OP_RANDOMCOLOR:
                    this.pen.color = `#${Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')}`;
                    break;
                case OP_ADDALPHA: {
                    // change_brush_transparency는 선과 채우기 둘 다 움직인다.
                    const d = this._num(base + a);
                    this.pen.opacity = Math.max(0, Math.min(100, this.pen.opacity + d));
                    this.pen.fillOpacity = Math.max(0, Math.min(100, this.pen.fillOpacity + d));
                    break;
                }
                case OP_TEXTWRITE: {
                    const entity = this._textEntity(b);
                    const value = boundedText(this._str(base + a));
                    this.entTexts[entity] = value;
                    if (entity === b) this.texts[b] = value;
                    break;
                }
                case OP_TEXTREAD: {
                    const entity = this._textEntity(b);
                    this._setStr(base + a, this.entTexts[entity] || this.texts[b] || '');
                    break;
                }
                case OP_TEXTMUTATE: {
                    const entity = this._textEntity(a);
                    const value = this._str(base + b);
                    const previous = String(this.entTexts[entity] || this.texts[a] || '');
                    const next = c === 2 ? '' : c === 1
                        ? boundedConcat(value, previous) : boundedConcat(previous, value);
                    this.entTexts[entity] = next;
                    if (entity === a) this.texts[a] = next;
                    break;
                }
                case OP_TEXTSTYLE: {
                    const entity = this._textEntity(a);
                    const style = this.entTextStyles[entity] || (this.entTextStyles[entity] = {});
                    const value = this._str(base + b);
                    const mode = this._str(base + b + 1);
                    if (c === 0) style.color = value.startsWith('#') ? value : `#${value}`;
                    else if (c === 1) style.background = value.startsWith('#') ? value : `#${value}`;
                    else if (c === 2) style.font = value;
                    else { style.effect = value; style.mode = mode; }
                    if (entity === a) this.textStyles[a] = style;
                    break;
                }
                case OP_LOADKEY: this._setNum(base + a, this.keys[b & 255] ? 1 : 0); break;
                case OP_LOCATEXY: this._moveTo(this._num(base + a), this._num(base + b)); break;
                case OP_MOVEXY:
                    this._moveTo(this.pen.x + this._num(base + a), this.pen.y + this._num(base + b));
                    break;
                case OP_FILLBEGIN:
                    this.pen.filling = true;
                    this.pen.path.length = 0;
                    this.pen.path.push(this.pen.x, this.pen.y);
                    break;
                case OP_FILLEND:
                    if (this.pen.path.length >= 6) {
          // sink는 호출 안에서 꼭짓점을 배처로 복사하므로 면마다 임시
          // 배열을 만들 필요가 없다. 대형 면 렌더의 GC 중단을 줄인다.
          this.sink.fill(this.sink.consumesFillPathSynchronously
            ? this.pen.path : this.pen.path.slice(), this.pen.fillColor,
                            1 - this.pen.fillOpacity / 100);
                        this.stats.fills += 1;
                        // Entry's fill path can be traced while the brush is
                        // down. The old VM collected only the polygon and
                        // silently discarded that outline. Fill first, then
                        // replay the stored path so the outline remains visible
                        // instead of being covered by the face triangles.
                        if (this.pen.down) {
                            const path = this.pen.path;
                            for (let k = 0; k + 3 < path.length; k += 2) {
                                this.sink.line(path[k], path[k + 1], path[k + 2], path[k + 3],
                                    this.pen.thickness, this.pen.color,
                                    1 - this.pen.opacity / 100);
                                this.stats.lines += 1;
                            }
                        }
                    }
                    this.pen.filling = false;
                    this.pen.path.length = 0;
                    break;
                case OP_STAMP:
                    this.sink.stamp(this.pen.x, this.pen.y, this.pen.thickness, this.pen.color,
                        1 - this.pen.opacity / 100, ent);
                    break;
                case OP_ERASEALL: this.sink.clear(); break;

                case OP_JMP: pc = a; break;
                case OP_JZ: if (this._num(base + a) === 0) pc = b; break;
                case OP_JNZ: if (this._num(base + a) !== 0) pc = b; break;

            case OP_CALL: {
                const fn = this.program.functions[a];
                if (this.callCounts) this.callCounts[a] += 1;
                    const native = this.nativeFunctions[a];
                    if (native) {
                        const arg = base + b;
                        const valueAt = (offset) => this._regValue(arg + offset);
                        let result;
                        switch (fn.arity) {
                            case 0: result = native.run(this, ent); break;
                            case 1: result = native.run(this, ent, valueAt(0)); break;
                            case 2: result = native.run(this, ent, valueAt(0), valueAt(1)); break;
                            case 3: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2)); break;
                            case 4: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3)); break;
                            case 5: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4)); break;
                            case 6: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4), valueAt(5)); break;
                            case 7: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4), valueAt(5), valueAt(6)); break;
                            case 8: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4), valueAt(5), valueAt(6), valueAt(7)); break;
                        case 9: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4), valueAt(5), valueAt(6), valueAt(7), valueAt(8)); break;
                        case 10: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4), valueAt(5), valueAt(6), valueAt(7), valueAt(8), valueAt(9)); break;
                        case 11: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4), valueAt(5), valueAt(6), valueAt(7), valueAt(8), valueAt(9), valueAt(10)); break;
                        case 12: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4), valueAt(5), valueAt(6), valueAt(7), valueAt(8), valueAt(9), valueAt(10), valueAt(11)); break;
                        case 13: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4), valueAt(5), valueAt(6), valueAt(7), valueAt(8), valueAt(9), valueAt(10), valueAt(11), valueAt(12)); break;
                        case 14: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4), valueAt(5), valueAt(6), valueAt(7), valueAt(8), valueAt(9), valueAt(10), valueAt(11), valueAt(12), valueAt(13)); break;
                        case 15: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4), valueAt(5), valueAt(6), valueAt(7), valueAt(8), valueAt(9), valueAt(10), valueAt(11), valueAt(12), valueAt(13), valueAt(14)); break;
                        case 16: result = native.run(this, ent, valueAt(0), valueAt(1), valueAt(2), valueAt(3), valueAt(4), valueAt(5), valueAt(6), valueAt(7), valueAt(8), valueAt(9), valueAt(10), valueAt(11), valueAt(12), valueAt(13), valueAt(14), valueAt(15)); break;
                            default: result = undefined;
                        }
                        if (c >= 0) this._nativeStoreRegister(base + c, result === undefined ? 0 : result);
                        this.stats.calls += 1;
                        this.stats.nativeCalls += 1;
                        this.stats.nativeInstructions += native.instructionCount;
                        break;
                    }
                    const d = this.depth[ti];
                    const windowEnd = (ti + 1) * this.regCapacity;
                    if (d >= this.maxCallDepth || base + b + this.frameSize > windowEnd) {
                        // 재귀가 너무 깊다. 호출을 건너뛰고 0을 돌려준다 —
                        // 스택을 터뜨려 탭을 죽이는 것보다 낫고, overruns로 드러난다.
                        this.stats.overruns += 1;
                        if (c >= 0) this._setNum(base + c, 0);
                        break;
                    }
                const memoProfile = this.functionMemoProfiles[a];
                let memoKey = null;
                if (memoProfile) {
                    memoKey = this._functionMemoKey(memoProfile, base + b);
                    const cached = this.functionMemoCaches[a].get(memoKey);
                    if (cached) {
                        this._applyFunctionMemo(cached, c < 0 ? -1 : base + c);
                        this.stats.calls += 1;
                        break;
                    }
                }
                    const sp = (ti * this.maxCallDepth + d) * 3;
                    this.callStack[sp] = pc;
                    this.callStack[sp + 1] = base;
                    this.callStack[sp + 2] = c < 0 ? -1 : base + c;
                this.callMemoFrames[ti * this.maxCallDepth + d] = memoProfile
                    ? { functionIndex: a, key: memoKey } : null;
                    this.depth[ti] = d + 1;
                    base += b;
                    pc = fn.pc;
                    this.stats.calls += 1;
                    break;
                }
                case OP_RET: {
                    const d = this.depth[ti] - 1;
                    if (d < 0) { this.alive[ti] = 0; this.pc[ti] = pc; this.base[ti] = base; return steps; }
                    const sp = (ti * this.maxCallDepth + d) * 3;
                    const retSlot = this.callStack[sp + 2];
                const memoIndex = ti * this.maxCallDepth + d;
                const memoFrame = this.callMemoFrames[memoIndex];
                if (memoFrame) {
                    const profile = this.functionMemoProfiles[memoFrame.functionIndex];
                    const entry = {
                        retTag: a >= 0 ? this.regTag[base + a] : TAG_NUM,
                        retNum: a >= 0 ? this.regNum[base + a] : 0,
                        retStr: a >= 0 ? this.regStr[base + a] : '',
                        writes: profile.writeVars.map((v) => [v, this.varTag[v], this.varNum[v], this.varStr[v]]),
                    };
                    const cache = this.functionMemoCaches[memoFrame.functionIndex];
                    if (cache.size >= 4096) cache.clear();
                    cache.set(memoFrame.key, entry);
                    this.callMemoFrames[memoIndex] = null;
                }
                    if (retSlot >= 0) {
                        if (a < 0) this._setNum(retSlot, 0);
                        else if (this.regTag[base + a] === TAG_STR) this._setStr(retSlot, this.regStr[base + a]);
                        else this._setNum(retSlot, this.regNum[base + a]);
                    }
                    pc = this.callStack[sp];
                    base = this.callStack[sp + 1];
                    this.depth[ti] = d;
                    break;
                }

                // ── 엔티티(스프라이트) ─────────────────────────────────
                // 좌표를 바꾸는 블록은 **붓도 같이 끌고 간다**. 엔진에서 붓은
                // 오브젝트에 달려 있어서, 그리기 펜을 내린 채 `x좌표를 100으로`
                // 하면 거기까지 선이 그어진다 — `_moveTo`가 그 둘을 한다.
                case OP_SETENTX: this._moveTo(this._num(base + a), this.pen.y); break;
                case OP_SETENTY: this._moveTo(this.pen.x, this._num(base + a)); break;
                case OP_MOVEDIR: {
                    const v = this._num(base + a);
                    // 회전과 이동방향을 **더한** 쪽으로 간다. y는 빼는 쪽이다
                    // (엔트리 무대는 위가 +y, 엔진이 sin을 빼서 맞춘다).
                    const rad = (this.entRot[ent] + this.entDir[ent] - 90) * DEG;
                    this._moveTo(this.pen.x + v * Math.cos(rad), this.pen.y - v * Math.sin(rad));
                    break;
                }
                case OP_MOVEANGLE: {
                    const distance = this._num(base + b);
                    const rad = (this._num(base + a) - 90) * DEG;
                    this._moveTo(
                        this.pen.x + distance * Math.cos(rad),
                        this.pen.y - distance * Math.sin(rad),
                    );
                    break;
                }
                case OP_BOUNCE:
                    this._bounceAtWall(ent);
                    break;
                case OP_SETROT: this._setRotation(ent, this._num(base + a)); break;
                case OP_ADDROT: this._setRotation(ent, this.entRot[ent] + this._num(base + a)); break;
                case OP_SETDIR: this._setDirection(ent, this._num(base + a)); break;
                case OP_ADDDIR: this._setDirection(ent, this.entDir[ent] + this._num(base + a)); break;
                case OP_SETSIZE: this._setSize(ent, this._num(base + a)); break;
                case OP_ADDSIZE: this._setSize(ent, this._getSize(ent) + this._num(base + a)); break;
                case OP_STRETCH: {
                    const factor = (100 + this._num(base + b)) / 100;
                    if (a) this.entScaleY[ent] *= factor; else this.entScaleX[ent] *= factor;
                    break;
                }
                case OP_RESETSCALE: {
                    const object = this.objects[this.entObject[ent]];
                    this.entScaleX[ent] = object ? object.scaleX : 1;
                    this.entScaleY[ent] = object ? object.scaleY : 1;
                    break;
                }
                case OP_SETVISIBLE: this.entVisible[ent] = a ? 1 : 0; break;
                case OP_SETEFFECT: this._setEffect(ent, a, this._num(base + b)); break;
                case OP_ADDEFFECT: this._setEffect(ent, a, this._effect(ent, a) + this._num(base + b)); break;
                case OP_SETSHAPE: {
                    const idx = a >= 0 ? a : this._resolveShape(ent, this._regValue(base + b));
                    if (idx >= 0) this._setShape(ent, idx);
                    break;
                }
                case OP_NEXTSHAPE: {
                    const object = this.objects[this.entObject[ent]];
                    const len = object ? object.pictures.length : 0;
                    if (len > 0) {
                        // 모양이 1개여도 나머지 연산이 0으로 떨어져야 한다.
                        const next = (this.entShape[ent] + a + len * 2) % len;
                        this._setShape(ent, next);
                    }
                    break;
                }
                case OP_FLIP:
                    // 이름과 축이 반대다 — 엔진의 `flip_x`가 scaleY를 뒤집는다.
                    if (a === 0) this.entScaleY[ent] = -this.entScaleY[ent];
                    else this.entScaleX[ent] = -this.entScaleX[ent];
                    break;
                case OP_LOADENT: this._loadEnt(base + a, b, c < 0 ? ent : c); break;

                // ── 복제본 ────────────────────────────────────────────
                case OP_CLONE:
                    this._clone(a < 0 ? ent : this._originOf(a), ti);
                    break;
                case OP_DELETECLONE:
                    // 원본에서는 아무 일도 없다(엔진도 그렇다) — 스레드도 살아남는다.
                    if (this.entIsClone[ent]) {
                        this._killEntity(ent);
                        this.pc[ti] = pc;
                        this.base[ti] = base;
                        return steps;
                    }
                    break;
                case OP_CLEARCLONES:
                    this._clearClones(a < 0 ? this.entObject[ent] : a);
                    break;

                // ── 기다리기 ──────────────────────────────────────────
                case OP_SLEEP: {
                    // 초를 **틱 수**로 바꿔서 센다. 벽시계를 쓰면 프레임이 밀릴
                    // 때 작품 속 시간이 로직 틱과 어긋난다(60틱=1초가 깨진다).
                    const sec = this._num(base + a);
                    this.rowSleep[ti] = sec > 0 ? Math.round(sec * this.logicHz) : 0;
                    this.pc[ti] = pc;
                    this.base[ti] = base;
                    return steps;
                }

                // ── 소리 ──────────────────────────────────────────────
                case OP_PLAYSOUND: {
                    const object = this.objects[this.entObject[ent]];
                    const sounds = object ? object.sounds : [];
                    const idx = a >= 0 ? a : this._resolveAsset(sounds, this._regValue(base + b));
                    const sound = idx >= 0 ? sounds[idx] : null;
                    let from = 0;
                    let dur = sound ? sound.duration : 0;
                    if (c & SND_SECOND) dur = this._num(base + b + 1);
                    else if (c & SND_FROMTO) {
                        from = this._num(base + b + 1);
                        dur = Math.max(0, this._num(base + b + 2) - from);
                    }
                    // 오디오를 들고 있는 쪽(런타임/호스트)이 실제로 재생한다.
                    // VM은 "무엇을 언제부터 얼마나"만 말한다.
                    if (sound) this.sink.sound(0, sound.src, this.volume, sound.name, from, dur,
                        this.entObject[ent], this.soundSpeed);
                    if (c & SND_WAIT) {
                        // 소리를 못 찾으면 기다리지 않는다 — 없는 소리에 영원히
                        // 걸려 있으면 "작품이 멈췄다"는 원인 모를 신고가 된다.
                        this.rowSleep[ti] = dur > 0 ? Math.round(dur * this.logicHz) : 0;
                        this.pc[ti] = pc;
                        this.base[ti] = base;
                        return steps;
                    }
                    break;
                }
                // a=1이면 이 오브젝트의 소리만 멈춘다 — 어느 오브젝트인지 같이 넘긴다.
                case OP_STOPSOUND:
                    this.sink.sound(a ? 3 : 1, null, this.volume, '', 0, 0, this.entObject[ent]);
                    break;
                case OP_VOLUME: {
                    const v = this._num(base + a);
                    // 소리 크기는 작품 전체에 하나다(엔진도 전역이다).
                    this.volume = Math.max(0, Math.min(100, b ? this.volume + v : v));
                    this.sink.sound(2, null, this.volume, '', 0, 0, -1);
                    break;
                }
                case OP_SOUNDSTATE:
                    this._setNum(base + a, b ? this.soundSpeed : this.volume);
                    break;
                case OP_SPEED: {
                    const value = this._num(base + a);
                    this.soundSpeed = Math.max(0.5, Math.min(2, b ? this.soundSpeed + value : value));
                    this.sink.sound(4, null, this.volume, '', 0, 0, -1, this.soundSpeed);
                    break;
                }
                case OP_STOP: {
                    // Entry's `thisThread` calls scope.die(). Inside a custom
                    // block that ends only the current function scope; the
                    // executor pops its call stack and resumes the caller.
                    // Treating it as death of the event row aborted common
                    // recursive-loop helpers before the following broadcast.
                    if (a === 2 && this.depth[ti] > 0) {
                        const d = this.depth[ti] - 1;
                        const sp = (ti * this.maxCallDepth + d) * 3;
                        const retSlot = this.callStack[sp + 2];
                        if (retSlot >= 0) this._setNum(retSlot, 0);
                        pc = this.callStack[sp];
                        base = this.callStack[sp + 1];
                        this.depth[ti] = d;
                        break;
                    }
                    const objectIndex = this.entObject[ent];
                    let stoppedCurrent = false;
                    for (let row = 0; row < this.rowCount; row += 1) {
                        if (!this.alive[row]) continue;
                        const sameObject = this.entObject[this.rowEntity[row]] === objectIndex;
                        const stop = a === 0
                            || (a === 1 && sameObject)
                            || (a === 2 && row === ti)
                            || (a === 3 && sameObject && row !== ti)
                            || (a === 4 && !sameObject);
                        if (stop) {
                            this.alive[row] = 0;
                            if (row === ti) stoppedCurrent = true;
                        }
                    }
                    if (stoppedCurrent) { this.pc[ti] = pc; return steps; }
                    break;
                }
                case OP_RESTART:
                    this.restartRequested = true;
                    this.alive[ti] = 0;
                    this.pc[ti] = pc;
                    return steps;

                // ── 신호 ──────────────────────────────────────────────
                case OP_BROADCAST:
                    // 신호는 **다음 틱**에 깨어난다. 여기서 바로 돌리면 보내는
                    // 쪽 스레드 안에서 받는 쪽이 돌아 순서가 뒤집힌다.
                    this.wake('when_message_cast', -1, a);
                    break;

                // ── 문자·리스트 ───────────────────────────────────────
                case OP_INLIST: {
                    const list = this.lists[b];
                    const needle = this._regValue(base + c);
                    let found = 0;
                    for (let i = 0; i < list.length; i += 1) {
                        // 엔트리는 리스트 비교를 **문자로** 한다(`10`과 `'10'`이 같다).
                        if (String(list[i]) === String(needle)) { found = 1; break; }
                    }
                    this._setNum(base + a, found);
                    break;
                }
                case OP_CHARAT: {
                    const s = this._str(base + b);
                    const i = Math.round(this._num(base + c));
                    this._setStr(base + a, i >= 1 && i <= s.length ? s.charAt(i - 1) : '');
                    break;
                }
                case OP_STRLEN: this._setNum(base + a, this._str(base + b).length); break;
                case OP_STRCOUNT: {
                    const source = this._str(base + b);
                    const target = this._str(base + c);
                    this._setNum(base + a, source.split(target).length - 1);
                    break;
                }
                case OP_ISTYPE: {
                    const value = this._str(base + b);
                    const matched = c === 1 ? /^[a-zA-Z]+$/.test(value)
                        : c === 2 ? /^[ㄱ-ㅎㅏ-ㅣ가-힣]+$/.test(value)
                            : value.trim() !== '' && Number.isFinite(Number(value));
                    this._setNum(base + a, matched ? 1 : 0);
                    break;
                }
                case OP_DISTANCE: {
                    const tx = b < 0 ? this.host[HOST_MOUSE_X] : this.entX[b];
                    const ty = b < 0 ? this.host[HOST_MOUSE_Y] : this.entY[b];
                    this._setNum(base + a, Math.hypot(this.entX[ent] - tx, this.entY[ent] - ty));
                    break;
                }
                case OP_TOUCHING:
                    this._setNum(base + a, this._touching(ent, b) ? 1 : 0);
                    break;
                case OP_STRIDX: {
                    // 엔트리는 **1부터** 세고, 없으면 0이다.
                    const hay = this._str(base + b);
                    const needle = this._str(base + c);
                    this._setNum(base + a, hay.indexOf(needle) + 1);
                    break;
                }
                case OP_SUBSTR: {
                    const s = this._str(base + b);
                    let from = Math.round(this._num(base + b + 1));
                    let to = Math.round(this._num(base + b + 2));
                    if (from > to) { const t = from; from = to; to = t; }
                    // Entry는 양 끝을 1부터 세며, 어느 한쪽이라도 문자열 범위를
                    // 벗어나면 reporter가 오류가 되어 값으로 쓰이지 않는다. VM에서
                    // JS substring처럼 0/끝으로 강제 보정하면 "구분자 없음(0)"을
                    // 문자열 앞부분으로 오인해 압축 배열 파서가 연쇄 손상된다.
                    if (from < 1 || to < 1 || from > s.length || to > s.length) {
                        this._setStr(base + a, '');
                    } else {
                        this._setStr(base + a, s.substring(from - 1, to));
                    }
                    break;
                }
                case OP_REPLACE: {
                    const s = this._str(base + b);
                    const find = this._str(base + b + 1);
                    // `split`/`join`으로 **전부** 바꾼다. `replace`는 첫 하나만 바꾼다.
                    this._setStr(base + a, boundedReplace(s, find, this._str(base + b + 2)));
                    break;
                }
                case OP_STRCASE:
                    this._setStr(base + a, c
                        ? this._str(base + b).toUpperCase()
                        : this._str(base + b).toLowerCase());
                    break;
                case OP_STRREV:
                    this._setStr(base + a, this._str(base + b).split('').reverse().join(''));
                    break;

                // ── 무대·장면·대화·질문 ───────────────────────────────
                case OP_DATE: {
                    // 엔진과 **같은 시계**(브라우저 지역 시간)를 본다.
                    const d = new Date();
                    let v = 0;
                    if (b === DATE_YEAR) v = d.getFullYear();
                    // 엔진은 월만 +1 한다. 요일은 `getDay()` 그대로(일요일=0)다
                    // — 여기서 +1 하면 작품의 `요일 = 1` 분기가 하루씩 밀린다.
                    else if (b === DATE_MONTH) v = d.getMonth() + 1;
                    else if (b === DATE_DAY) v = d.getDate();
                    else if (b === DATE_HOUR) v = d.getHours();
                    else if (b === DATE_MINUTE) v = d.getMinutes();
                    else if (b === DATE_SECOND) v = d.getSeconds();
                    else if (b === DATE_DAY_OF_WEEK) v = d.getDay();
                    this._setNum(base + a, v);
                    break;
                }
                case OP_TIMERACT:
                    if (a === TIMER_START) this.timerRunning = true;
                    else if (a === TIMER_STOP) this.timerRunning = false;
                    else if (a === TIMER_RESET) {
                        // 엔진의 `초기화`는 **멈추지 않는다** — 값만 0으로 돌린다.
                        this.timerTicks = 0;
                        this.host[HOST_TIMER] = 0;
                    }
                    break;
                case OP_SETINDEX: {
                    this._setObjectIndex(this.entObject[ent], a);
                    break;
                }
                case OP_GLIDEXY: {
                    // 엔진(`locate_xy_time`)을 그대로 따라간다: 남은 프레임 수로
                    // **매 프레임 다시 나눈다**(`(목표-현재)/남은프레임`). 한 번
                    // 계산한 속도를 쓰면, 중간에 다른 블록이 좌표를 밀었을 때
                    // 목표에 정확히 도착하지 못한다.
                    if (this.rowGlideFrames[ti] < 0) {
                        this.rowGlideX[ti] = this._num(base + a);
                        this.rowGlideY[ti] = this._num(base + a + 1);
                        const sec = this._num(base + a + 2);
                        // 0초·음수도 **한 프레임**은 움직인다(`Math.max(…, 1)`).
                        this.rowGlideFrames[ti] = Math.max(Math.floor(sec * this.logicHz), 1);
                    }
                    const left = this.rowGlideFrames[ti];
                    if (left > 0) {
                        const dx = (this.rowGlideX[ti] - this.entX[ent]) / left;
                        const dy = (this.rowGlideY[ti] - this.entY[ent]) / left;
                        // 붓이 내려와 있으면 선이 따라 그려진다(엔진도 `lineTo`를 한다).
                        this._moveTo(this.entX[ent] + dx, this.entY[ent] + dy);
                        this.rowGlideFrames[ti] = left - 1;
                    }
                    if (this.rowGlideFrames[ti] > 0) {
                        // 아직 남았다 — **같은 명령에 다시 돌아온다.**
                        this.pc[ti] = pc - 1;
                        this.base[ti] = base;
                        return steps;
                    }
                    // 마지막 프레임을 움직인 뒤 **그 틱에 바로 다음 블록으로**
                    // 넘어간다. 엔진은 한 프레임 더 들렀다 나가지만(frameCount가
                    // 0인 프레임), 그 한 틱은 보이는 움직임이 없다.
                    this.rowGlideFrames[ti] = -1;
                    break;
                }
                case OP_TURNTIME: {
                    if (this.rowGlideFrames[ti] < 0) {
                        const frames = Math.max(
                            Math.floor(this._num(base + a) * this.logicHz),
                            1,
                        );
                        this.rowGlideFrames[ti] = frames;
                        this.rowGlideX[ti] = this._num(base + a + 1) / frames;
                    }
                    const delta = this.rowGlideX[ti];
                    if (b) this._setDirection(ent, this.entDir[ent] + delta);
                    else this._setRotation(ent, this.entRot[ent] + delta);
                    this.rowGlideFrames[ti]--;
                    if (this.rowGlideFrames[ti] > 0) {
                        this.pc[ti] = pc - 1;
                        this.base[ti] = base;
                        return steps;
                    }
                    this.rowGlideFrames[ti] = -1;
                    break;
                }
                case OP_DIALOG:
                    if (b === DIALOG_REMOVE) this.dialogs[ent] = null;
                    else {
                        // 엔진은 빈 말풍선을 공백 네 칸으로 바꿔 **모양을 남긴다**.
                        const text = this._str(base + a);
                        this.dialogs[ent] = {
                            text: text === '' ? '    ' : text,
                            type: b === DIALOG_THINK ? 'think' : 'speak',
                        };
                    }
                    break;
                case OP_ASK:
                    // 물어보고 **이 줄만** 멈춘다. 대답은 `vm.answer()`로 들어온다.
                    this.hostStr[HOST_ASK] = this._str(base + a);
                    this.questions.push({ row: ti, text: this.hostStr[HOST_ASK], entity: ent });
                    if (this.questions.length === 1) this.hostWrites.add(HOST_WRITE_ACTIONS[HOST_ASK]);
                    this.rowAwaitAnswer[ti] = 1;
                    this.pc[ti] = pc;
                    this.base[ti] = base;
                    return steps;
                case OP_STARTSCENE:
                    // 장면이 바뀌면 이 줄도 멈춘다(엔진도 떠나는 장면의 코드를
                    // 전부 멈춘다) — `startScene`이 alive를 0으로 내린다.
                    this.startScene(a);
                    this.pc[ti] = pc;
                    this.base[ti] = base;
                    return steps;

                case OP_YIELD:
                    this.pc[ti] = pc;
                    this.base[ti] = base;
                    return steps;
                case OP_HALT:
                    this.alive[ti] = 0;
                    this.pc[ti] = pc;
                    this.base[ti] = base;
                    return steps;
                default:
                    // 모르는 옵코드는 조용히 넘기지 않는다 — 컴파일러와 VM이
                    // 어긋났다는 뜻이고, 그건 숨기면 안 되는 종류의 사고다.
                    throw new Error(`EniwanVM: 모르는 옵코드 ${op} (pc=${pc - 1})`);
            }
        }
        this.pc[ti] = pc;
        this.base[ti] = base;
        return steps;
    }

    /**
     * 시간 기반 전진 — **렌더 틱과 로직 틱을 떼어낸다.**
     * 240Hz 모니터에서 rAF가 초당 240번 불려도 로직은 60Hz로 유지된다.
     * 반대로 프레임이 밀렸을 때 밀린 만큼 다 따라잡으려 하면 더 밀리는
     * 죽음의 나선이 되므로, 한 번에 따라잡는 틱 수에 상한을 둔다.
     */
    advance(nowMs, maxTicksOverride, maxWorkMs = Infinity, stopAfterComplete = false) {
        if (this.lastNowMs < 0) { this.lastNowMs = nowMs; return 0; }
        let delta = nowMs - this.lastNowMs;
        this.lastNowMs = nowMs;
        if (!(delta > 0)) return 0;
        if (delta > 250) delta = 250;        // 탭이 백그라운드였던 경우

        const step = 1000 / this.logicHz;
        this.accumulatorMs += delta * this.tickMultiplier;
        const requestedMax = Number(maxTicksOverride);
        const maxTicks = Number.isFinite(requestedMax) && requestedMax > 0
            ? Math.max(1, Math.floor(requestedMax))
            : 8 * this.tickMultiplier;
        let ran = 0;
        let chunks = 0;
        const workStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
        while ((this.tickInProgress || this.accumulatorMs >= step) && chunks < maxTicks) {
            if (!this.tickInProgress) this.accumulatorMs -= step;
            const result = this.runTickChunk();
            if (result.complete) {
                ran += 1;
                // Give the renderer a presentation boundary. Starting another
                // heavy tick here leaves tickInProgress=true and can hide the
                // completed frame behind the partial-frame guard indefinitely.
                if (stopAfterComplete) break;
            }
            chunks += 1;
            const workNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (workNow - workStarted >= maxWorkMs) break;
        }
        if (this.accumulatorMs > step * maxTicks) this.accumulatorMs = 0;
        return ran;
    }

    get liveThreads() {
        let n = 0;
        for (let i = 0; i < this.rowCount; i += 1) if (this.alive[i]) n += 1;
        return n;
    }

    /** 살아 있는 엔티티 수(원본 + 복제본). 대시보드·검증에서 읽는다. */
    get liveEntities() {
        let n = 0;
        for (let i = 0; i < this.entityCapacity; i += 1) if (this.entAlive[i]) n += 1;
        return n;
    }

    /**
     * 엔티티 하나의 겉모습 — 호스트가 그릴 때 읽는다.
     *
     * 틱마다 엔티티 수만큼 객체를 만들면 할당 없는 성질이 깨지므로, 호스트는
     * 보통 `ent*` 배열을 직접 읽는다. 이건 검증·디버깅용 창구다.
     */
    entityInfo(index) {
        if (!(index >= 0) || index >= this.entityCapacity || !this.entAlive[index]) return null;
        const object = this.objects[this.entObject[index]];
        const shape = this.entShape[index];
        return {
            index,
            objectIndex: this.entObject[index],
            isClone: !!this.entIsClone[index],
            x: this.entX[index], y: this.entY[index],
            rotation: this.entRot[index], direction: this.entDir[index],
            scaleX: this.entScaleX[index], scaleY: this.entScaleY[index],
            width: this.entW[index], height: this.entH[index],
            // 회전·크기의 중심(모양 픽셀 좌표). 모양 패스가 축으로 쓰는 값이라
            // 여기로 보여 준다 — 틀어진 회전은 이 값부터 의심해야 한다.
            regX: this.entRegX[index], regY: this.entRegY[index],
            size: this._getSize(index),
            visible: !!this.entVisible[index],
            shape,
            shapeName: object && object.pictures[shape] ? object.pictures[shape].name : '',
            shapeSrc: object && object.pictures[shape] ? object.pictures[shape].src : null,
            effect: {
                color: this.entHsv[index],
                brightness: this.entBright[index],
                transparency: this.entAlpha[index],
            },
        };
    }

    /** 변수 값을 이름으로 읽는다(검증·대시보드용). */
    getVariable(name, entity = undefined) {
        const key = String(name);
        const i = this.program.vars.findIndex((v) => v.name === key || v.id === key);
        if (i < 0) return undefined;
        const hostSlot = this.program.vars[i].hostSlot;
        if (hostSlot !== undefined) {
            return HOST_IS_STRING[hostSlot] ? this.hostStr[hostSlot] : this.host[hostSlot];
        }
        const owner = this.varOwner[i];
        const target = entity === undefined && owner >= 0 ? owner : entity;
        const cell = this._localVarCell(i, target);
        if (cell >= 0) {
            return this.localVarTag[cell] === TAG_STR
                ? this.localVarStr[cell] : this.localVarNum[cell];
        }
        return this.varTag[i] === TAG_STR ? this.varStr[i] : this.varNum[i];
    }

    getList(name) {
        const i = this.program.lists.findIndex((l) => l.name === name || l.id === name);
        return i < 0 ? undefined : this.lists[i];
    }

    isMonitorVisible(name, list = false) {
        const key = String(name);
        const defs = list ? this.program.lists : this.program.vars;
        const i = defs.findIndex((v) => v.name === key || v.id === key);
        if (i < 0) return false;
        return Boolean(list ? this.listVisible[i] : this.varVisible[i]);
    }

    getTable(id) {
        const i = (this.program.tables || []).findIndex((table) =>
            table.id === id || table.name === id);
        return i < 0 ? undefined : this.tables[i];
    }

    /** 역어셈블 — 숫자만 보이는 덤프는 못 읽는다. */
    disassemble(from = 0, count = 40) {
        const code = this.program.code;
        const out = [];
        for (let pc = from; pc < from + count && pc * INSTR_WORDS < code.length; pc += 1) {
            const o = pc * INSTR_WORDS;
            out.push(`${String(pc).padStart(5)}  ${(OP_NAMES[code[o]] || `?${code[o]}`).padEnd(12)} ${code[o + 1]} ${code[o + 2]} ${code[o + 3]}`);
        }
        return out.join('\n');
    }
}

/**
 * PolygonBatcher를 VM의 sink로 꽂아 주는 어댑터.
 * `colorFromCss(css, alpha)`는 premultiplied alpha를 내므로 알파를 그대로 넘긴다.
 */
export function batcherSink(batcher, colorFromCss) {
    return {
    consumesFillPathSynchronously: true,
        line(x0, y0, x1, y1, width, color, alpha) {
            batcher.segment(x0, y0, x1, y1, Math.max(width, 0.5), colorFromCss(color, alpha));
        },
        fill(points, color, alpha) {
            batcher.convexPolygon(points, colorFromCss(color, alpha));
        },
        stamp(x, y, thickness, color, alpha) {
            batcher.circle(x, y, Math.max(thickness, 1) / 2, colorFromCss(color, alpha), 8);
        },
        clear() { /* 프레임마다 다시 그리므로 따로 지울 것이 없다 */ },
        text() { /* 글상자는 DOM/캔버스 쪽 몫이다 */ },
        sound() { /* 소리는 오디오를 들고 있는 쪽(런타임)이 받는다 */ },
        depth(z) { batcher.setDepth(z); },
        depthTest(on) { batcher.setDepthTest(on); },
    };
}

export default EniwanVM;
