/* 이 파일은 public/eniwanvm/native-tier.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
/**
 * Dorongi native tier.
 *
 * Safe, synchronous custom functions are translated once, when a project is
 * loaded, from Dorongi bytecode to ordinary JavaScript. Chrome may then JIT
 * that generated function. Event/yield/rendering code stays in the VM.
 *
 * Source text is made only from numeric ISA operands and JSON encoded constant
 * pool entries. Project supplied identifiers are never copied into JavaScript
 * syntax. If dynamic compilation is blocked by CSP, callers simply keep using
 * the bytecode interpreter.
 */
import {
    INSTR_WORDS,
    OP_CONST, OP_CONSTSTR, OP_MOV, OP_LOADLOCAL,
    OP_LOADVAR, OP_STOREVAR, OP_ADDVAR,
    OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MOD, OP_QUOT, OP_UNARY, OP_ATAN2,
    OP_CONCAT, OP_LT, OP_GT, OP_EQ, OP_NE, OP_LE, OP_GE, OP_AND, OP_OR, OP_NOT,
    OP_LISTGET, OP_LISTGET_L, OP_LISTLEN, OP_INLIST,
    OP_CHARAT, OP_STRLEN, OP_STRIDX, OP_SUBSTR, OP_REPLACE, OP_STRCASE,
    OP_STRREV, OP_STRCOUNT, OP_ISTYPE,
    OP_SUB_LL, OP_MUL_LL, OP_DIV_LL, OP_MOD_LL, OP_QUOT_LL,
    OP_LT_LL, OP_GT_LL, OP_LE_LL, OP_GE_LL,
    OP_JMP, OP_JZ, OP_JNZ, OP_RET,
} from './isa.js';

const SUPPORTED = new Set([
    OP_CONST, OP_CONSTSTR, OP_MOV, OP_LOADLOCAL,
    OP_LOADVAR, OP_STOREVAR, OP_ADDVAR,
    OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MOD, OP_QUOT, OP_UNARY, OP_ATAN2,
    OP_CONCAT, OP_LT, OP_GT, OP_EQ, OP_NE, OP_LE, OP_GE, OP_AND, OP_OR, OP_NOT,
    OP_LISTGET, OP_LISTGET_L, OP_LISTLEN, OP_INLIST,
    OP_CHARAT, OP_STRLEN, OP_STRIDX, OP_SUBSTR, OP_REPLACE, OP_STRCASE,
    OP_STRREV, OP_STRCOUNT, OP_ISTYPE,
    OP_SUB_LL, OP_MUL_LL, OP_DIV_LL, OP_MOD_LL, OP_QUOT_LL,
    OP_LT_LL, OP_GT_LL, OP_LE_LL, OP_GE_LL,
    OP_JMP, OP_JZ, OP_JNZ, OP_RET,
]);

const q = (value) => JSON.stringify(value);
const reg = (index) => `r${index}`;

function instructionSource(op, a, b, c, consts, strings) {
    const x = reg(a), y = reg(b), z = reg(c);
    switch (op) {
        case OP_CONST: return `${x}=${Number.isFinite(consts[b]) ? String(consts[b]) : '0'};`;
        case OP_CONSTSTR: return `${x}=${q(String(strings[b] ?? ''))};`;
        case OP_MOV: return `${x}=${y};`;
        case OP_LOADLOCAL: return `${x}=${y}||0;`;
        case OP_LOADVAR: return `${x}=v._nativeGetVar(${b},e);`;
        case OP_STOREVAR: return `v._nativeSetVar(${a},${y},e);`;
        case OP_ADDVAR: return `v._nativeAddVar(${a},${y},e);`;
        case OP_ADD: return `${x}=v._nativeAdd(${y},${z});`;
        case OP_SUB: return `${x}=v._nativeNumValue(${y})-v._nativeNumValue(${z});`;
        case OP_MUL: return `${x}=v._nativeNumValue(${y})*v._nativeNumValue(${z});`;
        case OP_DIV: return `${x}=v._nativeDiv(${y},${z});`;
        case OP_MOD: return `${x}=v._nativeMod(${y},${z});`;
        case OP_QUOT: return `${x}=v._nativeQuot(${y},${z});`;
        case OP_UNARY: return `${x}=v._nativeUnary(${y},${c});`;
        case OP_ATAN2: return `${x}=Math.atan2(v._nativeNumValue(${y}),v._nativeNumValue(${z}))*180/Math.PI;`;
        case OP_CONCAT: return `${x}=v._nativeConcat(${y},${z});`;
        case OP_LT: return `${x}=v._nativeNumValue(${y})<v._nativeNumValue(${z})?1:0;`;
        case OP_GT: return `${x}=v._nativeNumValue(${y})>v._nativeNumValue(${z})?1:0;`;
        case OP_LE: return `${x}=v._nativeNumValue(${y})<=v._nativeNumValue(${z})?1:0;`;
        case OP_GE: return `${x}=v._nativeNumValue(${y})>=v._nativeNumValue(${z})?1:0;`;
        case OP_EQ: return `${x}=v._nativeEqual(${y},${z})?1:0;`;
        case OP_NE: return `${x}=v._nativeNotEqual(${y},${z})?1:0;`;
        case OP_AND: return `${x}=v._nativeNumValue(${y})!==0&&v._nativeNumValue(${z})!==0?1:0;`;
        case OP_OR: return `${x}=v._nativeNumValue(${y})!==0||v._nativeNumValue(${z})!==0?1:0;`;
        case OP_NOT: return `${x}=v._nativeNumValue(${y})===0?1:0;`;
        case OP_LISTGET: return `${x}=v._nativeListGet(${b},${z});`;
        case OP_LISTGET_L: return `${x}=v._nativeListGet(${b},${z}||0);`;
        case OP_LISTLEN: return `${x}=v.lists[${b}].length;`;
        case OP_INLIST: return `${x}=v._nativeInList(${b},${z});`;
        case OP_CHARAT: return `${x}=v._nativeCharAt(${y},${z});`;
        case OP_STRLEN: return `${x}=String(${y}??'').length;`;
        case OP_STRIDX: return `${x}=String(${y}??'').indexOf(String(${z}??''))+1;`;
        // These opcodes store the first argument register in `b`; the next
        // two arguments occupy the following consecutive registers. `c` is
        // unused. Reading r0/r1 here corrupted JSON/string parsers after the
        // first call even though simple arithmetic native tests still passed.
        case OP_SUBSTR: return `${x}=v._nativeSubstring(${reg(b)},${reg(b + 1)},${reg(b + 2)});`;
        case OP_REPLACE: return `${x}=v._nativeReplace(${reg(b)},${reg(b + 1)},${reg(b + 2)});`;
        case OP_STRCASE: return `${x}=${c}===1?String(${y}??'').toUpperCase():String(${y}??'').toLowerCase();`;
        case OP_STRREV: return `${x}=String(${y}??'').split('').reverse().join('');`;
        case OP_STRCOUNT: return `${x}=v._nativeStringCount(${y},${z});`;
        case OP_ISTYPE: return `${x}=v._nativeIsType(${y},${c});`;
        case OP_SUB_LL: return `${x}=v._nativeNumValue(${y}||0)-v._nativeNumValue(${z}||0);`;
        case OP_MUL_LL: return `${x}=v._nativeNumValue(${y}||0)*v._nativeNumValue(${z}||0);`;
        case OP_DIV_LL: return `${x}=v._nativeDiv(${y}||0,${z}||0);`;
        case OP_MOD_LL: return `${x}=v._nativeMod(${y}||0,${z}||0);`;
        case OP_QUOT_LL: return `${x}=v._nativeQuot(${y}||0,${z}||0);`;
        case OP_LT_LL: return `${x}=v._nativeNumValue(${y}||0)<v._nativeNumValue(${z}||0)?1:0;`;
        case OP_GT_LL: return `${x}=v._nativeNumValue(${y}||0)>v._nativeNumValue(${z}||0)?1:0;`;
        case OP_LE_LL: return `${x}=v._nativeNumValue(${y}||0)<=v._nativeNumValue(${z}||0)?1:0;`;
        case OP_GE_LL: return `${x}=v._nativeNumValue(${y}||0)>=v._nativeNumValue(${z}||0)?1:0;`;
        default: return null;
    }
}

function compileOne(program, fn, start, end) {
    if (!fn || fn.arity > 16 || !(start >= 0) || end <= start) return null;
    const code = program.code;
    const leaders = new Set([start]);
    let instructionCount = 0;
    let hasControlFlow = false;
    for (let pc = start; pc < end; pc += 1) {
        const at = pc * INSTR_WORDS;
        const op = code[at], a = code[at + 1], b = code[at + 2];
        if (!SUPPORTED.has(op)) return null;
        instructionCount += 1;
        if (op === OP_JMP) { leaders.add(a); hasControlFlow = true; }
        else if (op === OP_JZ || op === OP_JNZ) {
            hasControlFlow = true;
            leaders.add(b);
            if (pc + 1 < end) leaders.add(pc + 1);
        }
    }
    for (const pc of leaders) if (pc < start || pc >= end) return null;
    const vars = Array.from({ length: Math.max(fn.frameSize || 1, fn.arity || 0) }, (_, i) => reg(i));
    const params = Array.from({ length: fn.arity || 0 }, (_, i) => `a${i}`);
    const init = vars.map((name, i) => `${name}=${i < params.length ? params[i] : '0'}`).join(',');

    // Straight-line leaf functions are the first production tier: V8 sees a
    // normal arithmetic function with no bytecode dispatch loop at all. Keep
    // CFG/state-machine products on the interpreter until their equivalence
    // and speed are demonstrated by differential benchmarks.
    if (!hasControlFlow) {
        let body = '';
        for (let pc = start; pc < end; pc += 1) {
            const at = pc * INSTR_WORDS;
            const op = code[at], a = code[at + 1], b = code[at + 2], c = code[at + 3];
            if (op === OP_RET) { body += a < 0 ? 'return undefined;' : `return ${reg(a)};`; break; }
            const source = instructionSource(op, a, b, c, program.consts, program.strings);
            if (source === null) return null;
            body += source;
        }
        return {
            source: `function(v,e,${params.join(',')}){"use strict";let ${init};${body}}`,
            instructionCount,
        };
    }
    return null;

    /* Reserved for the next tier after structured-control differential tests.
    const cases = [];
    for (let bi = 0; bi < starts.length; bi += 1) {
        const blockStart = starts[bi];
        const blockEnd = bi + 1 < starts.length ? starts[bi + 1] : end;
        let body = '';
        let terminated = false;
        for (let pc = blockStart; pc < blockEnd; pc += 1) {
            const at = pc * INSTR_WORDS;
            const op = code[at], a = code[at + 1], b = code[at + 2], c = code[at + 3];
            if (op === OP_RET) {
                body += a < 0 ? 'return undefined;' : `return ${reg(a)};`;
                terminated = true;
                break;
            }
            if (op === OP_JMP) {
                body += `p=${blockOf.get(a)};continue;`;
                terminated = true;
                break;
            }
            if (op === OP_JZ || op === OP_JNZ) {
                const target = blockOf.get(b);
                const fall = blockOf.get(pc + 1);
                const test = op === OP_JZ
                    ? `v._nativeNumValue(${reg(a)})===0`
                    : `v._nativeNumValue(${reg(a)})!==0`;
                body += `p=${test}?${target}:${fall};continue;`;
                terminated = true;
                break;
            }
            const source = instructionSource(op, a, b, c, program.consts, program.strings);
            if (source === null) return null;
            body += source;
        }
        if (!terminated) {
            if (bi + 1 < starts.length) body += `p=${bi + 1};continue;`;
            else body += 'return undefined;';
        }
        cases.push(`case ${bi}:${body}`);
    }
    const source = `function(v,e,${params.join(',')}){"use strict";let ${init};let p=0;for(;;){switch(p){${cases.join('')}default:return undefined;}}}`;
    return { source, instructionCount };
    */
}

/** Build native functions. Returns an all-null table when CSP forbids Function. */
export function buildNativeFunctions(program) {
    const functions = program.functions || [];
    const requiredStructured = new Set();
    const includeDependencies = (index) => {
        for (const dependency of functions[index]?.nativeDependencies || []) {
            if (requiredStructured.has(dependency)) continue;
            requiredStructured.add(dependency);
            includeDependencies(dependency);
        }
    };
    functions.forEach((fn, index) => {
        if (fn.nativeSource && fn.nativeExtended && fn.nativeRecursive) {
            requiredStructured.add(index);
            includeDependencies(index);
        }
    });
    const firstThread = Math.min(
        ...(program.threads || []).map((thread) => thread.pc),
        program.code.length / INSTR_WORDS,
    );
    const compiled = new Array(functions.length).fill(null);
    // Check if CSP or runtime environment forbids dynamic Function evaluation.
    try {
        Function('return 0;')();
    } catch {
        return { functions: compiled, blocked: true, count: 0 };
    }

    for (let i = 0; i < functions.length; i += 1) {
        if (functions[i].nativeDisabled || functions[i].arity > 16) continue;
        const end = i + 1 < functions.length ? functions[i + 1].pc : firstThread;
        const structured = functions[i].nativeSource || null;
        const product = structured
            ? {
                source: structured,
                resumableSource: functions[i].nativeResumableSource || null,
                instructionCount: Math.max(1, end - functions[i].pc),
                dependencies: functions[i].nativeDependencies || [],
            }
            : compileOne(program, functions[i], functions[i].pc, end);
        if (!product) continue;
        try {
            const run = Function(`return (${product.source});`)();
            let resumeFactory = null;
            if (product.resumableSource) {
                try {
                    resumeFactory = Function(`return (${product.resumableSource});`)();
                } catch {
                    // Resumable compilation is an optional responsiveness layer.
                    // Keep the verified synchronous native function as a safe fallback.
                    resumeFactory = null;
                }
            }
            compiled[i] = {
                run,
                resumeFactory,
                instructionCount: product.instructionCount,
                source: product.source,
                dependencies: product.dependencies || [],
            };
        } catch (err) {
            // Isolate individual function compile error: leave compiled[i] = null.
            // Do NOT discard other independent native functions.
            compiled[i] = null;
        }
    }

    // Structured products may call other native functions. Keep the
    // interpreter authoritative whenever any dependency did not pass the
    // same safety/compilation checks, including transitive fallbacks.
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < compiled.length; i += 1) {
            if (!compiled[i]) continue;
            const dependencies = compiled[i].dependencies;
            if (dependencies.some((index) => !compiled[index])) {
                compiled[i] = null;
                changed = true;
            }
        }
    }
    return { functions: compiled, blocked: false, count: compiled.filter(Boolean).length };
}

