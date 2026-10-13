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
    if (!head || !head.type.startsWith('function_create')) return null;
    const isValueFunction = head.type === 'function_create_value';
    const localName = new Map();
    for (let i = 0; i < meta.arity; i += 1) localName.set(meta.params[i], `a${i}`);
    for (const [id, slot] of meta.localSlots) localName.set(id, `l${slot}`);
    const params = Array.from({ length: meta.arity }, (_, i) => `a${i}`);
    const numericParamNames = new Set();
    meta.params.forEach((id, index) => {
        if (/numberParam_/i.test(String(id))) numericParamNames.add(params[index]);
    });
    const numericParamInit = [...numericParamNames]
        .map((name) => `${name}=typeof ${name}==='number'?(Number.isFinite(${name})?${name}:0):(Number.parseFloat(${name})||0);`)
        .join('');
    const locals = meta.locals.map(({ slot, value }) => `let l${slot}=${literal(value) ?? '0'};`).join('');
    const dependencies = new Set();
    let recursive = false;
    let extended = false;
    let nativeLoop = false;
    let loopSerial = 0;
    let hasSelfInExpr = false;
    let hasNonTailSelf = false;
    const selfType = `func_${fn.id}`;

    const checkExprSelf = (n) => {
        if (!n) return;
        if (Array.isArray(n)) { n.forEach(checkExprSelf); return; }
        if (n.type === selfType) hasSelfInExpr = true;
        if (n.params) n.params.forEach(checkExprSelf);
        if (n.statements) n.statements.forEach((st) => checkStmtListSelf(st, false));
    };

    const checkStmtListSelf = (stmts, isTail) => {
        if (!stmts || !stmts.length) return;
        for (let i = 0; i < stmts.length; i += 1) {
            const s = stmts[i];
            const isLast = (i === stmts.length - 1) && isTail;
            checkStmtSelf(s, isLast);
        }
    };

    const checkStmtSelf = (s, isTail) => {
        if (!s || !isBlock(s)) return;
        if (s.type === selfType) {
            if (!isTail) hasNonTailSelf = true;
            if (s.params) s.params.forEach(checkExprSelf);
            return;
        }
        if (s.type === '_if') {
            if (s.params) checkExprSelf(s.params[0]);
            checkStmtListSelf(s.statements?.[0], isTail);
            return;
        }
        if (s.type === 'if_else') {
            if (s.params) checkExprSelf(s.params[0]);
            checkStmtListSelf(s.statements?.[0], isTail);
            checkStmtListSelf(s.statements?.[1], isTail);
            return;
        }
        if (s.type && s.type.startsWith('repeat')) {
            if (s.params) s.params.forEach(checkExprSelf);
            (s.statements || []).forEach((st) => checkStmtListSelf(st, false));
            return;
        }
        if (s.params) s.params.forEach(checkExprSelf);
        if (s.statements) s.statements.forEach((st) => checkStmtListSelf(st, false));
    };

    (head.statements || []).forEach((list) => checkStmtListSelf(list, true));
    const canTco = !isValueFunction && !hasSelfInExpr && !hasNonTailSelf;

    const numericLiteral = (node) => {
        let value = node;
        while (isBlock(value) && [
            'number', 'positive_number', 'wildcard_string', 'wildcard_boolean', 'get_boolean_value',
        ].includes(value.type)) value = (value.params || [])[0];
        if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
        if (typeof value !== 'string') return null;
        // Entry의 getNumberValue는 parseFloat(value) || 0이다. 네이티브 소스에
        // 고정 숫자를 그대로 넣으면 광선 교차 루프에서 같은 문자열을 수백만 번
        // parseFloat하는 비용을 없애면서 결과는 유지된다.
        const number = Number.parseFloat(value);
        return Number.isFinite(number) ? String(number) : '0';
    };
    const directLocalName = (node) => {
        if (!isBlock(node)) return null;
        if (/Param_/.test(node.type)) return localName.get(node.type) || null;
        if (node.type === 'get_func_variable') return localName.get(String((node.params || [])[0])) || null;
        return null;
    };
    const isNumericExpression = (node) => {
        if (numericLiteral(node) !== null) return true;
        if (!isBlock(node)) return false;
        switch (node.type) {
            case 'True': case 'true': case 'False': case 'false':
            case 'calc_rand': case 'calc_operation': case 'quotient_and_mod':
            case 'boolean_basic_operator': case 'boolean_and_or': case 'boolean_not':
            case 'coordinate_mouse': case 'is_clicked': case 'is_press_some_key':
            case 'get_project_timer_value': case 'get_date': case 'length_of_list':
            case 'length_of_string': case 'index_of_string': case 'count_match_string':
                return true;
            case 'calc_basic':
                return ['MINUS', 'MULTI', 'DIVIDE'].includes(String((node.params || [])[1]));
            default:
                return false;
        }
    };
    const numeric = (node) => {
        const fixed = numericLiteral(node);
        if (fixed !== null) return fixed;
        if (isBlock(node) && node.type === 'value_of_index_from_list') {
            const p = node.params || [];
            return `v._nativeListNumGet(${environment.list(p[1])},${numeric(p[3])})`;
        }
        if (isNumericExpression(node)) return expression(node);
        const name = directLocalName(node);
        // Parameters and locals are the hottest operands in generated 3D
        // kernels. Keep Entry's parseFloat-or-zero rule, but expose the
        // overwhelmingly common numeric branch directly to V8 instead of
        // crossing the VM helper boundary millions of times per second.
        if (name) return numericParamNames.has(name)
            ? name
            : `(typeof ${name}==='number'?(Number.isFinite(${name})?${name}:0):(Number.parseFloat(${name})||0))`;
        return `v._nativeNumValue(${expression(node)})`;
    };

    const functionCall = (node, isTailStmt = false) => {
        const id = node.type.slice(5);
        if (id === fn.id) {
            recursive = true;
            const args = Array.from({ length: meta.arity }, (_, i) => expression((node.params || [])[i] ?? 0));
            if (canTco && isTailStmt) {
                nativeLoop = true;
                const tempAssigns = args.map((arg, i) => `let _t${i}=${arg};`).join('');
                const paramAssigns = params.map((p, i) => `${p}=_t${i};`).join('');
                return `${tempAssigns}${paramAssigns}continue __tco;`;
            }
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
            case 'color': case 'text_color': return js(p[0] === undefined ? '#000000' : String(p[0]));
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
                    // Keep the right operand parenthesised. A negative literal
                    // used to produce `left--1`, which is invalid JavaScript
                    // (`--` is parsed as the decrement operator). One such
                    // syntax error made buildNativeFunctions discard the
                    // native tier for the entire project.
                    case 'MINUS': return `(${numeric(p[0])}-(${numeric(p[2])}))`;
                    case 'MULTI': return `((${numeric(p[0])})*(${numeric(p[2])}))`;
                    case 'DIVIDE': return `v._nativeDiv(${left},${right})`;
                    default: throw new Error('basic operator');
                }
            }
            case 'calc_rand': {
                extended = true;
                const standard = p.length >= 4;
                const lo = expression(standard ? p[1] : p[0]);
                const hi = expression(standard ? p[3] : p[1]);
                return `v._nativeRand(${lo},${hi})`;
            }
            case 'change_rgb_to_hex': {
                extended = true;
                return `v._nativeRgbToHex(${expression(p[0])},${expression(p[1])},${expression(p[2])})`;
            }
            case 'change_hex_to_rgb': {
                extended = true;
                return `v._nativeHexToRgb(${expression(p[0])},${js(String(p[1] ?? 'r').toLowerCase())})`;
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
                    case 'GREATER': return `((${numeric(p[0])})>(${numeric(p[2])})?1:0)`;
                    case 'LESS': return `((${numeric(p[0])})<(${numeric(p[2])})?1:0)`;
                    case 'GREATER_OR_EQUAL': return `((${numeric(p[0])})>=(${numeric(p[2])})?1:0)`;
                    case 'LESS_OR_EQUAL': return `((${numeric(p[0])})<=(${numeric(p[2])})?1:0)`;
                    default: throw new Error('comparison');
                }
            }
            case 'boolean_and_or': {
                const isOr = String(p[1]).toUpperCase() === 'OR';
                const leftTest = `(${numeric(p[0])}!==0)`;
                const rightTest = `(${numeric(p[2])}!==0)`;
                return isOr ? `(${leftTest}||${rightTest}?1:0)` : `(${leftTest}&&${rightTest}?1:0)`;
            }
            case 'boolean_not': {
                const operand = p[1] !== undefined && p[1] !== null ? p[1] : p[0];
                return `(${numeric(operand)}===0?1:0)`;
            }
            case 'coordinate_mouse': {
                extended = true;
                const isY = String(p[1]).toLowerCase() === 'y';
                return `v._nativeMouseCoord(${isY ? 1 : 0})`;
            }
            case 'is_clicked': {
                extended = true;
                return 'v._nativeIsMouseDown()';
            }
            case 'is_press_some_key': {
                extended = true;
                return `v._nativeIsKeyDown(${Number(p[0]) || 0})`;
            }
            case 'get_project_timer_value': {
                extended = true;
                return 'v._nativeTimer()';
            }
            case 'get_date': {
                extended = true;
                const fieldName = String(p[1] ?? 'second').toLowerCase();
                const fieldMap = {
                    year: 0, month: 1, day: 2, hour: 3, minute: 4, second: 5, day_of_week: 6,
                };
                const field = fieldMap[fieldName] ?? 5;
                return `v._nativeDate(${field})`;
            }
            case 'length_of_list': return `v.lists[${environment.list(p[1])}].length`;
            case 'value_of_index_from_list': return `v._nativeListGet(${environment.list(p[1])},${expression(p[3])})`;
            case 'length_of_string': return `String(${expression(p[1])}??'').length`;
            case 'index_of_string': return `(String(${expression(p[1])}??'').indexOf(String(${expression(p[3])}??''))+1)`;
            case 'substring': return `v._nativeSubstring(${expression(p[1])},${expression(p[3])},${expression(p[5])})`;
            case 'replace_string': return `v._nativeReplace(${expression(p[1])},${expression(p[3])},${expression(p[5])})`;
            case 'combine_something': return `v._nativeConcat(${expression(p[1])},${expression(p[3])})`;
            case 'char_at': extended = true; return `v._nativeCharAt(${expression(p[1])},${expression(p[3])})`;
            case 'count_match_string': extended = true; return `v._nativeStringCount(${expression(p[0])},${expression(p[2])})`;
            case 'change_string_case': {
                extended = true;
                const compact = p.length < 4;
                const mode = String(compact ? p[1] : p[3]).toLowerCase();
                const upper = mode.includes('upper') ? 1 : 0;
                return `v._nativeChangeCase(${expression(compact ? p[0] : p[1])},${upper})`;
            }
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
                if (node.type.startsWith('func_')) return functionCall(node, false);
                throw new Error(`unsupported expression ${node.type}`);
        }
    };

    const statements = (blocks, loopDepth = 0, isTail = true) => (blocks || []).map((block, blockIndex, list) => {
        if (!isBlock(block)) return '';
        const isLastInList = blockIndex === list.length - 1;
        const isTailStmt = isTail && isLastInList;
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
            case 'locate_x': extended = true; return `v._moveTo(${expression(p[0])},v.pen.y);`;
            case 'locate_y': extended = true; return `v._moveTo(v.pen.x,${expression(p[0])});`;
            case 'move_x': extended = true; return `v._nativeMoveToRel(${expression(p[0])},0);`;
            case 'move_y': extended = true; return `v._nativeMoveToRel(0,${expression(p[0])});`;
            case 'start_drawing': extended = true; return 'v._nativePenDown();';
            case 'stop_drawing': extended = true; return 'v._nativePenUp();';
            case 'start_fill': extended = true; return 'v._nativeFillBegin();';
            case 'stop_fill': extended = true; return 'v._nativeFillEnd();';
            case 'set_color': extended = true; return `v._nativeSetPenColor(${expression(p[0])});`;
            case 'set_fill_color': extended = true; return `v._nativeSetFillColor(${expression(p[0])});`;
            case 'set_thickness': extended = true; return `v._nativeSetPenThickness(${expression(p[0])});`;
            case 'set_brush_tranparency': extended = true; return `v._nativeSetPenOpacity(${expression(p[0])});`;
            case 'brush_erase_all': extended = true; return 'v._nativeEraseAll();';
            case 'stop_object': {
                const mode = String(p[0] ?? 'all');
                if (mode === 'thisThread') {
                    if (isValueFunction) {
                        const headParams = head.params || [];
                        const returnExpr = headParams.length ? headParams[headParams.length - 1] : null;
                        if (returnExpr !== null && returnExpr !== undefined) {
                            return `return ${expression(returnExpr)};`;
                        }
                    }
                    return 'return;';
                }
                throw new Error(`unsupported stop_object mode ${mode}`);
            }
            case '_if': return `if(${numeric(p[0])}!==0){${statements(body[0], loopDepth, isTailStmt)}}`;
            case 'if_else': return `if(${numeric(p[0])}!==0){${statements(body[0], loopDepth, isTailStmt)}}else{${statements(body[1], loopDepth, isTailStmt)}}`;
            case 'repeat_while_true': {
                const loopBody = body[0] || [];
                if (!isFastLoopTail(loopBody.at(-1))) throw new Error('yielding while loop');
                nativeLoop = true;
                extended = true;
                const until = String(p[1] ?? 'until') !== 'while';
                const test = until
                    ? `${numeric(p[0])}===0`
                    : `${numeric(p[0])}!==0`;
                return `while(${test}){${statements(loopBody.slice(0, -1), loopDepth + 1, false)}}`;
            }
            case 'repeat_basic': {
                const loopBody = body[0] || [];
                if (!isFastLoopTail(loopBody.at(-1))) throw new Error('yielding counted loop');
                nativeLoop = true;
                extended = true;
                const counter = `q${loopSerial++}`;
                return `for(let ${counter}=${numeric(p[0])};${counter}>0;${counter}-=1){${statements(loopBody.slice(0, -1), loopDepth + 1, false)}}`;
            }
            case 'wait_until_true':
                if (isFastLoopTail(block)) return '';
                throw new Error('yielding wait');
            case 'stop_repeat':
                if (loopDepth <= 0) throw new Error('break outside loop');
                return 'break;';
            default:
                if (block.type.startsWith('func_')) return `${functionCall(block, isTailStmt && loopDepth === 0)};`;
                throw new Error(`unsupported statement ${block.type}`);
        }
    }).join('');

    try {
        const body = (head.statements || []).map((list) => statements(list, 0, true)).join('');
        let returnStatement = 'return undefined;';
        if (isValueFunction) {
            const headParams = head.params || [];
            const returnExpr = headParams.length ? headParams[headParams.length - 1] : null;
            if (returnExpr !== null && returnExpr !== undefined) {
                returnStatement = `return ${expression(returnExpr)};`;
            }
        }
        const callArgs = params.length ? `,${params.join(',')}` : '';
        const wrappedBody = canTco && recursive
            ? `__tco:for(;;){${numericParamInit}${locals}${body}${returnStatement}}`
            : `function self(v,e,d,${params.join(',')}){if(d>=v.maxCallDepth){v.stats.overruns+=1;return 0;}${numericParamInit}${locals}${body}${returnStatement}}return self(v,e,0${callArgs});`;
        return {
            source: `function(v,e,${params.join(',')}){"use strict";${wrappedBody}}`,
            dependencies: [...dependencies],
            recursive,
            extended,
            nativeLoop,
        };
    } catch {
        return null;
    }
}


