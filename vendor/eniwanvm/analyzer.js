/* 이 파일은 public/eniwanvm/analyzer.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
/**
 * EniwanVM 1단계 — `.ent`의 정적 복잡도 분석기 (순수 코어).
 *
 * 하는 일: project.json의 블록 트리를 걸어서 (1) 프레임당 실행될 블록 수를 추정하고
 * (2) 렌더 비용을 좌우하는 기능(폴리곤 채우기 / 펜 선 / 삼각함수)의 사용량을 센 다음,
 * (3) 어느 렌더 티어로 실행해야 하는지와 어떤 최적화를 켤지를 돌려준다.
 *
 * 왜 정적 분석인가: `.ent`를 받은 순간 이걸 돌려야 런타임이 "일단 Canvas2D로 띄워 보고
 * 느리면 바꾸는" 미지근한 길을 피할 수 있다. 콜드 스타트에서 티어가 이미 정해져 있어야
 * AOT로 컴파일한 구조를 그대로 넘길 수 있다.
 *
 * 여기 있는 코드는 **node 의존이 하나도 없다** — 대시보드(브라우저)와 CLI
 * (`tools/eniwanvm/analyze.mjs`)가 같은 판정을 쓰려면 티어 임계값이 한 곳에만 있어야
 * 한다. 두 벌로 갈라지면 "서버는 티어 3, 화면은 티어 2"처럼 조용히 어긋난다.
 */

import { normalizeProject, assetSrc } from './project.js';

// ── 블록 분류 ────────────────────────────────────────────────────────────
// 전부 tools/block-registry.json에 실재하는 type이다. 레지스트리에 없는 이름을
// 적으면 영원히 0으로 집계되면서 "이 작품엔 채우기가 없다"고 조용히 거짓말한다.

const FILL_BLOCKS = new Set(['start_fill', 'stop_fill', 'set_fill_color']);
const PEN_BLOCKS = new Set([
    'start_drawing', 'stop_drawing', 'brush_stamp', 'brush_erase_all',
    'set_color', 'set_thickness', 'change_thickness',
    'change_brush_transparency', 'set_brush_tranparency',
]);
const MOVE_BLOCKS = new Set([
    'locate_x', 'locate_y', 'locate_xy', 'locate_xy_time', 'locate',
    'locate_object_time', 'move_direction', 'move_x', 'move_y',
    'move_xy_time', 'move_to_angle',
]);
const CLONE_BLOCKS = new Set([
    'create_clone', 'create_clone_wait', 'delete_clone', 'remove_all_clones',
    'when_clone_start',
]);

// 프레임 루프 — 본문이 "틱마다 한 번" 도는 루프. 여기 안에 있는 블록이 곧 프레임 비용이다.
const FRAME_LOOPS = new Set(['repeat_inf', 'repeat_while_true']);
// 횟수 루프. 원본 Entry는 반복마다 프레임을 양보하지만 EniwanVM 기본 컴파일은
// 그 암묵 YIELD를 제거한다. 따라서 `repeat_basic(100)`은 실제 VM에서 한 틱에
// 100회 실행되고, 분석기도 반드시 100배로 세야 한다. 여기만 Entry 기준으로
// 남겨 두면 "블록은 적고 반복 계산만 많은 작품"을 가볍다고 오판한다.
const COUNT_LOOPS = new Set(['repeat_basic']);

/**
 * 딜레이 제거 트릭 — 반복 본문의 **마지막** 블록이
 * `wait_until_true(boolean_not(continue_repeat))`이면 프레임 양보가 사라지고
 * 전체 반복이 한 틱에 동기 실행된다. 이때만 횟수를 곱한다.
 * (편집기 드래그로는 못 만드는 조립이라 project.json 레벨에만 존재한다.)
 */
// calc_operation의 드롭다운(VALUE)에 들어가는 삼각/초월 연산자들.
const TRIG_OPS = /^(sin|cos|tan|asin|acos|atan|atan2|log|ln|sqrt|unnatural)/;

// repeat_basic의 횟수를 상수로 못 읽을 때 쓰는 값. 변수로 돌리는 루프는 실제로
// 수십~수백 회가 흔하므로 1로 깎으면 무거운 작품이 가볍게 보인다.
const UNKNOWN_REPEAT = 12;
// 함수 재귀 전개 한도. 재귀 함수는 여기서 끊고 플래그로 보고한다.
const MAX_FUNC_DEPTH = 8;

// ── 트리 걷기 ────────────────────────────────────────────────────────────

function isBlock(node) {
    return node && typeof node === 'object' && typeof node.type === 'string';
}

/** 파라미터 자리에 끼워진 블록들만 골라낸다(숫자/문자 리터럴은 객체가 아니다). */
function paramBlocks(block) {
    const out = [];
    for (const p of block.params || []) if (isBlock(p)) out.push(p);
    return out;
}

/** 블록의 첫 파라미터가 숫자 리터럴이면 그 값, 아니면 null. */
function literalNumber(block) {
    const p = (block.params || [])[0];
    if (typeof p === 'number') return p;
    if (typeof p === 'string' && p.trim() !== '' && Number.isFinite(Number(p))) return Number(p);
    if (isBlock(p) && p.type === 'number') {
        const v = (p.params || [])[0];
        if (v !== undefined && v !== null && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
}

/**
 * 함수 정의의 **본문** 뭉치들을 돌려준다.
 *
 * 함정: 본문은 정의 스레드의 형제 블록이 아니라 머리 블록
 * (`function_create` / `function_create_value`)의 `statements[0]` 안에 들어 있다.
 * `content[0].slice(1)`로 머리만 떼면 본문 전체(여기선 1,912블록)가 같이 날아가고,
 * 분석기는 무거운 작품을 "틱당 16블록"이라고 조용히 거짓 보고한다.
 * 머리의 params는 시그니처(라벨·매개변수 칸)라서 실행 비용이 아니다.
 */
function functionBodies(fn) {
    const bodies = [];
    for (const thread of fn.content || []) {
        for (const block of thread || []) {
            if (!isBlock(block)) continue;
            if (block.type.startsWith('function_create')) {
                for (const s of block.statements || []) bodies.push(s);
            }
        }
    }
    return bodies;
}

function trigOperator(block) {
    if (block.type !== 'calc_operation') return null;
    // paramsKeyMap VALUE:3 — 드롭다운이 실제 연산자를 들고 있다.
    const v = (block.params || [])[3];
    return typeof v === 'string' ? v : null;
}

// 사용자 함수 호출 그래프를 매 호출 지점마다 전개하면 큰 TessVM 작품에서 같은 본문을
// 수천 번 다시 걸어 UI 스레드를 1분 넘게 점유한다. 분석은 실행기가 아니라 티어를
// 고르는 휴리스틱이므로, 이만큼 봤으면 이미 "매우 큰 작품"이라는 결론에 충분하다.
export const MAX_ANALYSIS_NODES = 750_000;

/**
 * 한 블록 뭉치(statement 배열)의 비용과 기능 사용량을 센다.
 * `weight`는 "이 뭉치가 한 틱에 몇 번 도는가"다 — 횟수 루프가 곱해 준다.
 */
function walkStatements(blocks, ctx, weight, depth, loopDepth) {
    let cost = 0;
    for (const block of blocks || []) {
        if (!isBlock(block)) continue;
        cost += walkBlock(block, ctx, weight, depth, loopDepth);
    }
    return cost;
}

function walkBlock(block, ctx, weight, depth, loopDepth) {
    if (ctx.blocks >= MAX_ANALYSIS_NODES) {
        ctx.truncated = true;
        return 0;
    }
    const type = block.type;
    let cost = weight;

    ctx.blocks += 1;
    ctx.loopDepth = Math.max(ctx.loopDepth, loopDepth);

    if (FILL_BLOCKS.has(type)) ctx.fill += weight;
    else if (PEN_BLOCKS.has(type)) ctx.pen += weight;
    else if (MOVE_BLOCKS.has(type)) ctx.move += weight;
    else if (CLONE_BLOCKS.has(type)) ctx.clone += weight;

    const trig = trigOperator(block);
    if (trig) {
        ctx.calcOps += weight;
        if (TRIG_OPS.test(trig)) ctx.trig += weight;
    }

    // 파라미터 자리 블록은 같은 횟수만큼 평가된다.
    for (const p of paramBlocks(block)) cost += walkBlock(p, ctx, weight, depth, loopDepth);

    // 사용자 함수 호출 — 본문을 전개해서 센다.
    if (type.startsWith('func_')) {
        const fnId = type.slice('func_'.length);
        const fn = ctx.functions.get(fnId);
        if (!fn) {
            ctx.unresolvedCalls.add(type);
        } else if (depth >= MAX_FUNC_DEPTH || ctx.callStack.has(fnId)) {
            ctx.recursive = true;
        } else {
            ctx.callStack.add(fnId);
            for (const body of functionBodies(fn)) {
                cost += walkStatements(body, ctx, weight, depth + 1, loopDepth);
            }
            ctx.callStack.delete(fnId);
        }
    }

    // 본문(C 블록)
    const statements = block.statements || [];
    if (statements.length === 0) return cost;

    if (FRAME_LOOPS.has(type)) {
        // 틱마다 한 번. 중첩된 프레임 루프도 틱당 1회로 본다.
        ctx.loops += 1;
        for (const s of statements) cost += walkStatements(s, ctx, weight, depth, loopDepth + 1);
    } else if (COUNT_LOOPS.has(type)) {
        ctx.loops += 1;
        // EniwanVM은 일반 반복과 명시적 딜레이 제거 반복을 모두 동기 실행한다.
        // 표식 유무는 호환성 기록일 뿐 비용 배수에는 영향을 주지 않는다.
        const n = literalNumber(block);
        const iters = n === null ? UNKNOWN_REPEAT : Math.min(Math.max(Math.round(n), 1), 100000);
        if (n === null) ctx.unknownRepeats += 1;
        ctx.syncLoops += 1;
        for (const s of statements) cost += walkStatements(s, ctx, weight * iters, depth, loopDepth + 1);
    } else {
        // if / if_else 등. 분기는 둘 중 하나만 돌지만, 정적으로는 어느 쪽인지 모른다.
        // 최악이 아니라 "평균 한쪽"을 쓴다 — 아니면 if_else 하나가 비용을 두 배로 뻥튀긴다.
        const share = statements.length > 1 ? 1 / statements.length : 1;
        for (const s of statements) cost += walkStatements(s, ctx, weight * share, depth, loopDepth);
    }
    return cost;
}

/**
 * 저장된 블록의 **고유** 개수. ctx.blocks는 함수를 호출 지점마다 전개하므로
 * 같은 블록을 여러 번 세고(horse-restore는 42,805 → 463,873), 그 숫자를
 * "작품 크기"로 보고하면 파일이 10배 큰 것처럼 보인다. 둘은 다른 값이다.
 */
function countUniqueBlocks(project) {
    let n = 0;
    const walk = (blocks) => {
        for (const b of blocks || []) {
            if (!isBlock(b)) continue;
            n += 1;
            for (const p of paramBlocks(b)) walk([p]);
            for (const s of b.statements || []) walk(s);
        }
    };
    for (const o of project.objects || []) for (const th of o.script || []) walk(th);
    for (const fn of project.functions || []) for (const th of fn.content || []) walk(th);
    return n;
}

function newContext(project) {
    const functions = new Map();
    for (const fn of project.functions || []) if (fn && fn.id) functions.set(String(fn.id), fn);
    return blankContext(functions);
}

function blankContext(functions) {
    return {
        functions,
        callStack: new Set(),
        blocks: 0, fill: 0, pen: 0, move: 0, clone: 0, trig: 0, calcOps: 0,
        loops: 0, loopDepth: 0, unknownRepeats: 0, syncLoops: 0, frameSpreadLoops: 0,
        unresolvedCalls: new Set(), recursive: false,
        truncated: false, scanBlocks: 0,
    };
}

// ── 티어 판정 ────────────────────────────────────────────────────────────
//
// 티어를 가르는 건 블록 개수가 아니라 **무엇을 그리는가**다. 디스패치 비용은
// 생각보다 싸다 — bench 하니스 실측(EniwanBench)으로 틱당 12만 블록이 4.4ms,
// 즉 약 27,000블록/ms다. 프레임 16.6ms 중 엔진 몫을 5ms로 잡으면 디스패치만으로는
// 틱당 13만 블록까지 버틴다. 느린 기기 3배를 감안해 그 1/3을 상한으로 쓴다.
const DISPATCH_PER_MS = 27000;      // 실측
const ENGINE_BUDGET_MS = 5;         // 프레임당 엔진 몫
const SLOW_DEVICE_FACTOR = 3;
const TIER3_DISPATCH = Math.round((DISPATCH_PER_MS * ENGINE_BUDGET_MS) / SLOW_DEVICE_FACTOR); // 45,000

// 반면 렌더는 비싸다. Canvas2D 스캔라인 채우기와 펜 선은 호출 수에 비례해 CPU를 먹는다.
// 코퍼스 실측: horse-restore 틱당 펜 2,864 / 채우기 549, origami-space 2,089 / 114 —
// 이 둘이 사용자가 "티어 3이어야 한다"고 지목한 작품이다. 반대로 brick-kingdom은
// 틱당 펜 4회뿐이라 선 배칭(티어 2)으로 충분하다.
const TIER3_PEN = 300;              // 틱당 펜 호출 — 이 위는 선을 VBO로 모아야 한다
const TIER3_FILL = 50;              // 틱당 폴리곤 채우기 — 이 위는 GPU 삼각화가 필요하다
const TIER2_OBJECTS = 50;           // 스프라이트가 이보다 많으면 배칭이 필요하다

function decideTier(m) {
    const reasons = [];
    const draws = m.penPerTick + m.fillPerTick;
    const dispatchCost = Math.max(m.tickCost, m.startCost);
    let tier = 1;

    if (m.analysisTruncated) {
        tier = 3;
        reasons.push(`분석 전개 ${MAX_ANALYSIS_NODES.toLocaleString()}개에서 상한 도달 → 대형 작품 티어 3`);
    }

    if (m.recursive) {
        tier = 3;
        reasons.push('재귀 사용자 함수 — 정적 전개보다 실제 호출량이 커질 수 있어 최대 보호 적용');
    }

    if (draws > 0) {
        if (tier < 2) tier = 2;
        reasons.push(`틱당 펜 ${m.penPerTick.toFixed(0)}회 · 채우기 ${m.fillPerTick.toFixed(0)}회 → 선 배칭 필요`);
    }
    if (m.objects > TIER2_OBJECTS && tier < 2) {
        tier = 2;
        reasons.push(`오브젝트 ${m.objects}개 > ${TIER2_OBJECTS} → 스프라이트 배칭 필요`);
    }

    if (m.fillPerTick >= TIER3_FILL) {
        tier = 3;
        reasons.push(`틱당 폴리곤 채우기 ${Math.round(m.fillPerTick)}회 ≥ ${TIER3_FILL} → GPU 삼각화`);
    } else if (m.penPerTick >= TIER3_PEN) {
        tier = 3;
        reasons.push(`틱당 펜 ${Math.round(m.penPerTick)}회 ≥ ${TIER3_PEN} → GPU 삼각화`);
    }
    if (dispatchCost >= TIER3_DISPATCH) {
        const where = m.startCost > m.tickCost ? '시작 틱' : '틱당';
        if (tier < 3) reasons.push(`${where} 추정 ${Math.round(dispatchCost)}블록 ≥ ${TIER3_DISPATCH}(엔진 몫 ${ENGINE_BUDGET_MS}ms ÷ 느린기기 ${SLOW_DEVICE_FACTOR}배) → AOT 필요`);
        else reasons.push(`${where} 추정 ${Math.round(dispatchCost)}블록 — 디스패치도 AOT 대상`);
        tier = 3;
    }

    if (tier === 1) reasons.push('펜·채우기를 쓰지 않고 오브젝트도 적음 — 스프라이트 렌더로 충분');
    return { tier, reasons };
}

function optimizationFlags(m, tier) {
    return {
        // 티어 2부터는 선 세그먼트를 모아 한 번에 올린다.
        segmentBatch: tier >= 2 && (m.penPerTick > 0 || m.fillPerTick > 0),
        // 티어 3 전용 — 사각형 1개를 4버텍스로 VBO에 스트리밍.
        polygonBatch: tier >= 3 && m.fillPerTick > 0,
        // 블록 디스패치가 프레임을 먹기 시작하면 AOT로 펼쳐 둘 값어치가 있다.
        // 상한의 1/10(틱당 4,500블록)부터 켠다 — 그 아래는 컴파일 시간이 더 아깝다.
        aotCompile: Math.max(m.tickCost, m.startCost) >= TIER3_DISPATCH / 10,
        // 삼각함수가 틱당 수십 번이면 룩업/캐시가 먹힌다.
        trigCache: m.trigPerTick >= 20,
        // 로직 틱과 렌더 틱을 떼어낸다(240Hz 모니터에서 논리 60Hz 유지).
        decoupleTicks: tier >= 2,
    };
}

// ── 공개 API ─────────────────────────────────────────────────────────────

/** 파싱된 project.json을 받아 복잡도 보고서를 돌려준다. */
export function analyzeProject(project) {
    // `.ent`의 script/content는 JSON 문자열이다 — 파싱하지 않으면 "블록 없음"으로
    // 조용히 읽힌다(horse-restore가 티어 3 → 티어 1로 떨어진 실제 사고).
    normalizeProject(project);
    const ctx = newContext(project);
    let tickCost = 0, startCost = 0;

    const objects = project.objects || [];
    for (const object of objects) {
            for (const thread of object.script || []) {
                if (!Array.isArray(thread) || thread.length === 0) continue;
                // Loose blocks left on the editor canvas are not executable.
                if (!isBlock(thread[0]) || !thread[0].type.startsWith('when_')) continue;
                // 머리(hat)는 비용이 아니다. 프레임 루프 안쪽만 "틱 비용"으로 센다.
            const total = walkStatements(thread.slice(1), ctx, 1, 0, 0);
            const frame = frameOnlyCost(thread.slice(1), ctx);
            tickCost += frame;
            startCost += Math.max(total - frame, 0);
        }
    }

    // 모양으로 그리는 작품인가. 모양 패스가 생긴 뒤로는 이게 "그릴 것이 있다"의
    // 한 축이다(전에는 펜/채우기만 셌다). **주소가 있는 모양만** 센다 —
    // 로컬에서 만든 `.ent`는 `fileurl`이 꾸러미 안의 `temp/…`라 받을 수 없고,
    // 그런 작품을 "그릴 것이 있다"로 보면 다시 빈 무대가 된다.
    //
    // 받지 못하는 모양은 따로 센다(`pictureMissing`). 이게 0이 아니면 그 작품은
    // 모양 하나가 조용히 빠진 채 돈다 — 펜 그림이 있어서 "그릴 것은 있다"로
    // 보이는 작품일수록 고약하다(무대에 선 몇 개만 남고 등장인물이 없다).
    // 관문이 그걸 보고 물러날 수 있게 숫자로 남긴다.
    let pictureTotal = 0;
    let pictureMissing = 0;
    let spriteTotal = 0;
    for (const object of objects) {
        if (!object || object.objectType === 'textBox') continue;
        let n = 0;
        for (const picture of object.sprite?.pictures || []) {
            if (assetSrc(picture, 'image')) n += 1;
            else pictureMissing += 1;
        }
        if (n > 0) spriteTotal += 1;
        pictureTotal += n;
    }

    const metrics = {
        objects: objects.length,
        spriteTotal,
        pictureTotal,
        pictureMissing,
        functions: (project.functions || []).length,
        blocks: countUniqueBlocks(project),
        expandedNodes: ctx.blocks,
        loops: ctx.loops,
        maxLoopDepth: ctx.loopDepth,
        tickCost,
        startCost,
        fillPerTick: ctx.fillFrame || 0,
        penPerTick: ctx.penFrame || 0,
        trigPerTick: ctx.trigFrame || 0,
        movePerTick: ctx.moveFrame || 0,
        fillTotal: ctx.fill,
        penTotal: ctx.pen,
        trigTotal: ctx.trig,
        cloneTotal: ctx.clone,
        unknownRepeats: ctx.unknownRepeats,
        syncLoops: ctx.syncLoops,
        frameSpreadLoops: ctx.frameSpreadLoops,
        recursive: ctx.recursive,
        unresolvedCalls: [...ctx.unresolvedCalls],
        analysisTruncated: ctx.truncated,
    };

    const { tier, reasons } = decideTier(metrics);
    return { tier, reasons, flags: optimizationFlags(metrics, tier), metrics };
}

/**
 * 프레임 루프 안쪽만 다시 걸어서 "틱당" 비용과 기능 사용량을 뽑는다.
 * 한 번의 걷기로 둘을 같이 세려면 ctx를 두 겹으로 들고 다녀야 해서, 작품 크기가
 * 수만 블록이어도 몇 ms면 끝나는 쪽(두 번 걷기)을 택했다.
 */
function frameOnlyCost(blocks, outer) {
    let cost = 0;
    const sub = blankContext(outer.functions);
    const collect = (list, weight) => {
        for (const block of list || []) {
            if (!isBlock(block)) continue;
            if (sub.scanBlocks >= MAX_ANALYSIS_NODES) {
                sub.truncated = true;
                return;
            }
            sub.scanBlocks += 1;
            if (FRAME_LOOPS.has(block.type)) {
                for (const s of block.statements || []) {
                    cost += walkStatements(s, sub, weight, 0, 1);
                }
            } else {
                // 프레임 루프를 품고 있을 수 있으니 본문과 파라미터 자리를 더 파고든다.
                for (const s of block.statements || []) collect(s, weight);
                for (const p of paramBlocks(block)) collect([p], weight);
                if (block.type.startsWith('func_')) {
                    const fn = sub.functions.get(block.type.slice(5));
                    if (fn && !sub.callStack.has(block.type)) {
                        sub.callStack.add(block.type);
                        for (const body of functionBodies(fn)) collect(body, weight);
                        sub.callStack.delete(block.type);
                    }
                }
            }
        }
    };
    collect(blocks, 1);
    outer.fillFrame = (outer.fillFrame || 0) + sub.fill;
    outer.penFrame = (outer.penFrame || 0) + sub.pen;
    outer.trigFrame = (outer.trigFrame || 0) + sub.trig;
    outer.moveFrame = (outer.moveFrame || 0) + sub.move;
    if (sub.recursive) outer.recursive = true;
    if (sub.truncated) outer.truncated = true;
    return cost;
}

// 대시보드 HUD가 "지금 수치가 임계값에 얼마나 가까운가"를 띄우려면 임계값 자체가
// 필요하다. 화면에 숫자를 다시 적으면 판정과 표시가 갈라진다.
export const TIER_THRESHOLDS = {
    DISPATCH_PER_MS, ENGINE_BUDGET_MS, SLOW_DEVICE_FACTOR,
    TIER3_DISPATCH, TIER3_PEN, TIER3_FILL, TIER2_OBJECTS,
};
