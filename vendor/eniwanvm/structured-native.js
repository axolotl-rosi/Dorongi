/* 이 파일은 public/eniwanvm/structured-native.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
/**
 * Structured custom-function compiler for Dorongi's native tier.
 *
 * This compiler accepts a deliberately narrow Entry AST subset. Unlike a
 * bytecode pc/switch loop, its output contains ordinary JS if statements and
 * direct recursion, which V8 can optimise as a normal program. Returning null
 * is the normal fallback for any block whose semantics are not proven here.
 */

import {
    UN_NEG, UN_ABS, UN_FLOOR, UN_CEIL, UN_ROUND, UN_SQRT,
    UN_SIN, UN_COS, UN_TAN, UN_ASIN, UN_ACOS, UN_ATAN, UN_LN, UN_LOG,
    UN_SQUARE, UN_FACTORIAL, UN_FRAC,
    ENT_X, ENT_Y, ENT_ROTATION, ENT_DIRECTION, ENT_SIZE,
    ENT_PICTURE_INDEX, ENT_PICTURE_NAME,
} from './isa.js';

const isBlock = (value) => value && typeof value === 'object' && typeof value.type === 'string';
const js = (value) => JSON.stringify(value);

const unaryOperations = new Map([
    ['negative', UN_NEG], ['abs', UN_ABS], ['floor', UN_FLOOR],
    ['ceil', UN_CEIL], ['round', UN_ROUND], ['root', UN_SQRT], ['sqrt', UN_SQRT],
    ['sin', UN_SIN], ['cos', UN_COS], ['tan', UN_TAN],
    ['asin', UN_ASIN], ['acos', UN_ACOS], ['atan', UN_ATAN],
    ['asin_radian', UN_ASIN], ['acos_radian', UN_ACOS], ['atan_radian', UN_ATAN],
    ['ln', UN_LN], ['log', UN_LOG], ['square', UN_SQUARE],
    ['factorial', UN_FACTORIAL], ['fraction', UN_FRAC], ['unnatural', UN_FRAC],
]);

const entityProperties = new Map([
    ['x', ENT_X], ['y', ENT_Y], ['rotation', ENT_ROTATION],
    ['direction', ENT_DIRECTION], ['size', ENT_SIZE],
    ['picture_index', ENT_PICTURE_INDEX], ['picture_name', ENT_PICTURE_NAME],
]);

function findHead(fn) {
    for (const thread of fn.content || []) {
        for (const block of thread || []) {
            if (isBlock(block) && block.type.startsWith('function_create')) return block;
        }
    }
    return null;
}

function literal(value) {
    if (value === null || value === undefined) return '0';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
    if (typeof value !== 'string') return null;
    // Match Entry's primitive field blocks: the field stays a string until a
    // numeric operator explicitly asks for numeric coercion.
    return js(value);
}

function isFastLoopTail(block) {
    if (!isBlock(block) || block.type !== 'wait_until_true') return false;
    const not = (block.params || []).find((item) => isBlock(item) && item.type === 'boolean_not');
    if (!not) return false;
    return (not.params || []).some((item) => isBlock(item) && item.type === 'continue_repeat');
}

export function compileStructuredFunction(fn, meta, environment) {
    // OP_CALL's allocation-free native bridge has fixed arities 0..8.
    // Higher-arity Entry functions must remain on the ISA path until an
    // equally verified bridge exists; compiling them would silently drop the
    // ninth and later arguments.
    if (!meta || meta.arity > 16) return null;
    const head = findHead(fn);
    if (!head || head.type !== 'function_create') return null;
    const localName = new Map();
    for (let i = 0; i < meta.arity; i += 1) localName.set(meta.params[i], `a${i}`);
    for (const [id, slot] of meta.localSlots) localName.set(id, `l${slot}`);
    const params = Array.from({ length: meta.arity }, (_, i) => `a${i}`);
    const locals = meta.locals.map(({ slot, value }) => `let l${slot}=${literal(value) ?? '0'};`).join('');
    const dependencies = new Set();
    let recursive = false;
    let extended = false;
    let nativeLoop = false;
    let loopSerial = 0;

    const functionCall = (node) => {
        const id = node.type.slice(5);
        if (id === fn.id) {
            recursive = true;
            const args = Array.from({ length: meta.arity }, (_, i) => expression((node.params || [])[i] ?? 0));
            return `self(v,e,d+1,${args.join(',')})`;
        }
        extended = true;
        const target = environment.function(id);
        if (!target || target.arity > 16) throw new Error('unknown native callee');
        dependencies.add(target.index);
        const args = Array.from({ length: target.arity }, (_, i) => expression((node.params || [])[i] ?? 0));
        const suffix = args.length ? `,${args.join(',')}` : '';
        return `v._nativeCall${target.arity}(${target.index},e${suffix})`;
    };

    const expression = (node) => {
        const direct = literal(node);
        if (direct !== null) return direct;
        if (!isBlock(node)) throw new Error('non-block expression');
        const p = node.params || [];
        if (/Param_/.test(node.type)) {
            const name = localName.get(node.type);
            if (!name) throw new Error('unknown parameter');
            return name;
        }
        switch (node.type) {
            case 'number': case 'text': return expression(p[0]);
            case 'positive_number': case 'wildcard_string': case 'wildcard_boolean':
            case 'get_boolean_value': return expression(p[0]);
            case 'True': case 'true': return '1';
            case 'False': case 'false': return '0';
            case 'get_func_variable': {
                const name = localName.get(String(p[0]));
                if (!name) throw new Error('unknown local');
                return `(${name}||0)`;
            }
            case 'get_variable': {
                const slot = environment.variable(p[0]);
                if (slot === null) throw new Error('host variable');
                return `v._nativeGetVar(${slot},e)`;
            }
            case 'calc_basic': {
                const left = expression(p[0]), right = expression(p[2]);
                switch (String(p[1])) {
                    case 'PLUS': return `v._nativeAdd(${left},${right})`;
                    case 'MINUS': return `(v._nativeNumValue(${left})-v._nativeNumValue(${right}))`;
                    case 'MULTI': return `(v._nativeNumValue(${left})*v._nativeNumValue(${right}))`;
                    case 'DIVIDE': return `v._nativeDiv(${left},${right})`;
                    default: throw new Error('basic operator');
                }
            }
            case 'calc_operation': {
                extended = true;
                const operation = unaryOperations.get(String(p[3] ?? '').toLowerCase());
                if (operation === undefined) throw new Error('unary operation');
                return `v._nativeUnary(${expression(p[1])},${operation})`;
            }
            case 'quotient_and_mod': {
                const left = expression(p[1]), right = expression(p[3]);
                return String(p[5]).toUpperCase() === 'MOD'
                    ? `v._nativeMod(${left},${right})` : `v._nativeQuot(${left},${right})`;
            }
            case 'boolean_basic_operator': {
                const left = expression(p[0]), right = expression(p[2]);
                switch (String(p[1])) {
                    case 'EQUAL': return `(v._nativeEqual(${left},${right})?1:0)`;
                    case 'NOT_EQUAL': return `(v._nativeNotEqual(${left},${right})?1:0)`;
                    case 'GREATER': return `(v._nativeNumValue(${left})>v._nativeNumValue(${right})?1:0)`;
                    case 'LESS': return `(v._nativeNumValue(${left})<v._nativeNumValue(${right})?1:0)`;
                    case 'GREATER_OR_EQUAL': return `(v._nativeNumValue(${left})>=v._nativeNumValue(${right})?1:0)`;
                    case 'LESS_OR_EQUAL': return `(v._nativeNumValue(${left})<=v._nativeNumValue(${right})?1:0)`;
                    default: throw new Error('comparison');
                }
            }
            case 'length_of_list': return `v.lists[${environment.list(p[1])}].length`;
            case 'value_of_index_from_list': return `v._nativeListGet(${environment.list(p[1])},${expression(p[3])})`;
            case 'length_of_string': return `String(${expression(p[1])}??'').length`;
            case 'index_of_string': return `(String(${expression(p[1])}??'').indexOf(String(${expression(p[3])}??''))+1)`;
            case 'substring': return `v._nativeSubstring(${expression(p[1])},${expression(p[3])},${expression(p[5])})`;
            case 'combine_something': return `v._nativeConcat(${expression(p[1])},${expression(p[3])})`;
            case 'char_at': extended = true; return `v._nativeCharAt(${expression(p[1])},${expression(p[3])})`;
            case 'coordinate_object': {
                extended = true;
                const property = entityProperties.get(String(p[3] ?? 'x'));
                if (property === undefined) throw new Error('entity property');
                const target = String(p[1] ?? 'self');
                const objectIndex = target === 'self' ? -1 : environment.object(target);
                if (target !== 'self' && objectIndex < 0) throw new Error('entity target');
                return `v._nativeEntityValue(${property},${objectIndex},e)`;
            }
            default:
                if (node.type.startsWith('func_')) return functionCall(node);
                throw new Error(`unsupported expression ${node.type}`);
        }
    };

    const statements = (blocks, loopDepth = 0) => (blocks || []).map((block) => {
        if (!isBlock(block)) return '';
        const p = block.params || [], body = block.statements || [];
        switch (block.type) {
            case 'set_func_variable': {
                const name = localName.get(String(p[0]));
                if (!name) throw new Error('unknown local store');
                return `${name}=${expression(p[1] ?? 0)};`;
            }
            case 'set_variable': {
                const slot = environment.variable(p[0]);
                if (slot === null) throw new Error('host variable store');
                return `v._nativeSetVar(${slot},${expression(p[1])},e);`;
            }
            case 'change_variable': {
                const slot = environment.variable(p[0]);
                if (slot === null) throw new Error('host variable add');
                return `v._nativeAddVar(${slot},${expression(p[1])},e);`;
            }
            case 'insert_value_to_list':
                return `v._nativeListInsert(${environment.list(p[1])},${expression(p[2])},${expression(p[0])});`;
            case 'change_value_list_index':
                extended = true;
                return `v._nativeListSet(${environment.list(p[0])},${expression(p[1])},${expression(p[2])});`;
            case 'add_value_to_list':
                extended = true;
                return `v._nativeListPush(${environment.list(p[1])},${expression(p[0])});`;
            case 'remove_value_from_list':
                extended = true;
                return `v._nativeListDelete(${environment.list(p[1])},${expression(p[0])});`;
            case 'locate_xy': return `v._nativeLocate(${expression(p[0])},${expression(p[1])});`;
            case 'start_drawing': extended = true; return 'v._nativePenDown();';
            case 'stop_drawing': extended = true; return 'v._nativePenUp();';
            case 'set_color': extended = true; return `v._nativeSetPenColor(${expression(p[0])});`;
            case 'set_thickness': extended = true; return `v._nativeSetPenThickness(${expression(p[0])});`;
            case '_if': return `if(v._nativeNumValue(${expression(p[0])})!==0){${statements(body[0], loopDepth)}}`;
            case 'if_else': return `if(v._nativeNumValue(${expression(p[0])})!==0){${statements(body[0], loopDepth)}}else{${statements(body[1], loopDepth)}}`;
            case 'repeat_while_true': {
                const loopBody = body[0] || [];
                if (!isFastLoopTail(loopBody.at(-1))) throw new Error('yielding while loop');
                nativeLoop = true;
                extended = true;
                const condition = expression(p[0]);
                const until = String(p[1] ?? 'until') !== 'while';
                const test = until
                    ? `v._nativeNumValue(${condition})===0`
                    : `v._nativeNumValue(${condition})!==0`;
                return `while(${test}){${statements(loopBody.slice(0, -1), loopDepth + 1)}}`;
            }
            case 'repeat_basic': {
                const loopBody = body[0] || [];
                if (!isFastLoopTail(loopBody.at(-1))) throw new Error('yielding counted loop');
                nativeLoop = true;
                extended = true;
                const counter = `q${loopSerial++}`;
                return `for(let ${counter}=v._nativeNumValue(${expression(p[0])});${counter}>0;${counter}-=1){${statements(loopBody.slice(0, -1), loopDepth + 1)}}`;
            }
            case 'wait_until_true':
                if (isFastLoopTail(block)) return '';
                throw new Error('yielding wait');
            case 'stop_repeat':
                if (loopDepth <= 0) throw new Error('break outside loop');
                return 'break;';
            default:
                if (block.type.startsWith('func_')) return `${functionCall(block)};`;
                throw new Error(`unsupported statement ${block.type}`);
        }
    }).join('');

    try {
        const body = (head.statements || []).map((list) => statements(list)).join('');
        const callArgs = params.length ? `,${params.join(',')}` : '';
        return {
            source: `function(v,e,${params.join(',')}){"use strict";function self(v,e,d,${params.join(',')}){if(d>=v.maxCallDepth)return 0;${locals}${body}return undefined;}return self(v,e,0${callArgs});}`,
            dependencies: [...dependencies],
            recursive,
            extended,
            nativeLoop,
        };
    } catch {
        return null;
    }
}

