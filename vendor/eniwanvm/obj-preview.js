/* 이 파일은 public/eniwanvm/obj-preview.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
/* GPU interaction preview for large Entry OBJ viewers.
 *
 * The original block program remains authoritative.  While it spends several
 * frames rebuilding and depth-sorting thousands of faces, this renderer draws
 * the same bundled OBJ directly from a static VBO so pointer drag remains
 * visually continuous.  When the pointer is released, the next completed VM
 * frame replaces the preview.
 */

const shader = (gl, type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
};

const makeProgram = (gl, vs, fs) => {
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
    return p;
};

function parseMaterials(text) {
    const out = new Map();
    let name = '';
    const tokens = String(text || '').trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i] === 'newmtl') name = tokens[++i] || '';
        else if (name && tokens[i] === 'Kd') {
            const c = [Number(tokens[++i]), Number(tokens[++i]), Number(tokens[++i])];
            out.set(name, [c[0] || 0.65, c[1] || 0.65, c[2] || 0.65]);
        }
    }
    return out;
}

export function parseObj(text, materials, normalizationSpan = 0) {
    const vertices = [];
    const triangles = [];
    let material = [0.58, 0.62, 0.66];
    // Entry list items flatten line breaks to spaces. Parse OBJ directives as
    // tokens so both ordinary files and flattened project data work.
    const tokens = String(text || '').trim().split(/\s+/);
    const directive = new Set(['v', 'vn', 'vt', 'f', 'usemtl', 'mtllib', 'g', 'o', 's', '#']);
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token === 'v') {
            vertices.push([Number(tokens[++i]) || 0, Number(tokens[++i]) || 0, Number(tokens[++i]) || 0]);
        } else if (token === 'vn') i += 3;
        else if (token === 'vt') i += 2;
        else if (token === 'usemtl') {
            material = materials.get(tokens[++i]) || material;
        } else if (token === 'mtllib' || token === 'g' || token === 'o' || token === 's') {
            // A group declaration is allowed to have no name (`g` followed by
            // the next `v`).  Entry stores imported OBJ files as one flattened
            // list item, so blindly consuming one token here dropped that
            // vertex.  The error accumulated at every anonymous group and
            // produced the characteristic twisted faces in the 360/12k models.
            if (i + 1 < tokens.length && !directive.has(tokens[i + 1])) i += 1;
        } else if (token === 'f') {
            const values = [];
            while (i + 1 < tokens.length && !directive.has(tokens[i + 1])) values.push(tokens[++i]);
            const face = values.map((value) => {
                const n = Number(value.split('/')[0]);
                return n < 0 ? vertices.length + n : n - 1;
            });
            for (let i = 1; i + 1 < face.length; i += 1) {
                triangles.push([face[0], face[i], face[i + 1], material]);
            }
        }
    }
    if (!vertices.length || !triangles.length) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of vertices) for (let i = 0; i < 3; i += 1) {
        lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]);
    }
    const center = lo.map((v, i) => (v + hi[i]) * 0.5);
    const span = Math.max(...hi.map((v, i) => v - lo[i])) || 1;
    const displaySpan = Math.max(span, Number(normalizationSpan) || 0) || 1;
    const data = new Float32Array(triangles.length * 18);
    let o = 0;
    for (const [ia, ib, ic, color] of triangles) {
        const a = vertices[ia], b = vertices[ib], c = vertices[ic];
        if (!a || !b || !c) continue;
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const shade = Math.max(0.28, Math.min(1.08,
            0.55 + 0.45 * ((nx * 0.35 + ny * 0.75 + nz * 0.55) / nl)));
        for (const p of [a, b, c]) {
            data[o++] = (p[0] - center[0]) * 2.25 / displaySpan;
            data[o++] = (p[1] - center[1]) * 2.25 / displaySpan;
            data[o++] = (p[2] - center[2]) * 2.25 / displaySpan;
            data[o++] = Math.min(1, color[0] * shade);
            data[o++] = Math.min(1, color[1] * shade);
            data[o++] = Math.min(1, color[2] * shade);
        }
    }
    return { data: o === data.length ? data : data.slice(0, o), span };
}

export class ObjPreviewRenderer {
    static supports(program) {
        const list = program?.lists?.find((x) => x.name === 'obj');
        return Boolean(list?.initial?.some((x) => /(?:^|\s)v\s/.test(String(x))
            && /(?:^|\s)f\s/.test(String(x))));
    }

    constructor(gl, program) {
        this.gl = gl;
        this.programData = program;
        this.objListIndex = program.lists.findIndex((x) => x.name === 'obj');
        this.objVarIndex = program.vars.findIndex((x) => x.name === 'obj');
        const mtl = program.lists.find((x) => x.name === 'mtl')?.initial?.[0] || '';
        this.materials = parseMaterials(mtl);
        const initialObjects = program.lists[this.objListIndex]?.initial || [];
        // Keep one camera scale across the selector.  Normalising every model
        // independently made the tiny 1-4 presets jump to full-screen size.
        this.cachedBuffers = [];
        this.normalizationSpan = initialObjects.reduce((largest, source) => {
            const parsed = parseObj(source, this.materials);
            return Math.max(largest, parsed?.span || 0);
        }, 0);
        for (let idx = 0; idx < initialObjects.length; idx += 1) {
            const parsed = parseObj(initialObjects[idx], this.materials, this.normalizationSpan);
            if (parsed) this.cachedBuffers[idx] = parsed;
        }
        this.selected = -1;
        this.vertexCount = 0;
        this.yaw = -0.45;
        this.pitch = -0.32;
        this.lastX = 0;
        this.lastY = 0;
        this.pressX = 0;
        this.pressY = 0;
        this.pressed = false;
        this.dragging = false;
        // A VM tick can span several requestAnimationFrame callbacks. Once
        // its OBJ presentation functions are replaced, keep replacing them
        // until that same logical tick ends.
        this.suppressionActiveForTick = false;
        this.awaitingCleanFrame = false;
        this.lastAdvanceSuppressed = false;
        // The preview may replace only the expensive presentation pass while a
        // real drag is in progress.  Recursive OBJ list transforms and pen
        // rasterisation are recomputed by the authoritative VM after release.
        // Keeping this set on the preview makes the optimisation unavailable
        // to ordinary projects.
        this.suppressedNativeIndexes = new Set(program.functions.flatMap((fn, index) => {
            const source = fn.nativeSource || '';
            const isObjPresentationPass = fn.nativeRecursive
                && (source.includes('_nativeList') || source.includes('_nativePen')
                    || source.includes('_nativeLocate'));
            return isObjPresentationPass ? [index] : [];
        }));
        this.buffer = gl.createBuffer();
        this.program = makeProgram(gl,
            'attribute vec3 aPos;attribute vec3 aColor;uniform vec2 uTurn;uniform float uAspect;varying vec3 vColor;void main(){float cy=cos(uTurn.x),sy=sin(uTurn.x),cx=cos(uTurn.y),sx=sin(uTurn.y);vec3 p=vec3(aPos.x*cy+aPos.z*sy,aPos.y,-aPos.x*sy+aPos.z*cy);p=vec3(p.x,p.y*cx-p.z*sx,p.y*sx+p.z*cx);float z=p.z+3.5;gl_Position=vec4(p.x*4.2/uAspect,p.y*4.2,z-0.22,z);vColor=aColor;}',
            'precision mediump float;varying vec3 vColor;void main(){gl_FragColor=vec4(vColor,1.0);}');
        this.aPos = gl.getAttribLocation(this.program, 'aPos');
        this.aColor = gl.getAttribLocation(this.program, 'aColor');
        this.uTurn = gl.getUniformLocation(this.program, 'uTurn');
        this.uAspect = gl.getUniformLocation(this.program, 'uAspect');
    }

    setPointer(x, y, down) {
        if (down && !this.pressed) {
            this.pressX = x;
            this.pressY = y;
            this.lastX = x;
            this.lastY = y;
            this.pressed = true;
            this.dragging = false;
            return;
        }
        if (down && this.pressed) {
            const dx = x - this.pressX;
            const dy = y - this.pressY;
            // A press is still a click until the pointer has moved far enough.
            // This keeps pen-drawn project buttons and object-click hats under
            // VM ownership instead of turning every click into a camera drag.
            if (!this.dragging && (dx * dx + dy * dy) >= 25) {
                this.dragging = true;
                this.lastX = this.pressX;
                this.lastY = this.pressY;
            }
            if (this.dragging) {
                this.yaw += (x - this.lastX) * 0.012;
                this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch - (y - this.lastY) * 0.012));
            }
        }
        this.lastX = x;
        this.lastY = y;
        if (!down) {
            this.pressed = false;
            this.dragging = false;
        }
    }

    /** Run a control tick while replacing only OBJ presentation functions. */
    withPresentationSuppressed(vm, callback) {
        const canSuppress = this.suppressedNativeIndexes.size > 0;
        const suppress = canSuppress && (this.dragging || this.suppressionActiveForTick);
        const ticksBefore = Number(vm?.stats?.ticks || 0);
        this.lastAdvanceSuppressed = suppress;
        if (!suppress) {
            const result = callback();
            const completedCleanTick = !vm.tickInProgress
                && Number(vm?.stats?.ticks || 0) > ticksBefore;
            if (this.awaitingCleanFrame && completedCleanTick) this.awaitingCleanFrame = false;
            return result;
        }

        this.suppressionActiveForTick = true;
        const saved = [];
        const noOp = { instructionCount: 0, run: () => 0 };
        for (const index of this.suppressedNativeIndexes) {
            const native = vm.nativeFunctions[index];
            if (!native) continue;
            saved.push([index, native]);
            vm.nativeFunctions[index] = noOp;
        }
        try {
            return callback();
        } finally {
            for (const [index, native] of saved) vm.nativeFunctions[index] = native;
            if (!vm.tickInProgress) {
                this.suppressionActiveForTick = false;
                // A suppressed tick never becomes the visible Entry frame.
                // Keep the GPU image until one complete ordinary tick has
                // rebuilt the authoritative pen layer after release.
                this.awaitingCleanFrame = true;
            }
        }
    }

    needsPreview(vm = null) {
        return Boolean(this.dragging || this.suppressionActiveForTick || this.awaitingCleanFrame);
    }

    sync(vm) {
        const raw = this.objVarIndex >= 0
            ? (vm.varTag[this.objVarIndex] ? Number(vm.varStr[this.objVarIndex]) : vm.varNum[this.objVarIndex])
            : 1;
        const list = vm.lists[this.objListIndex] || this.programData.lists[this.objListIndex].initial;
        const index = Math.max(0, Math.min(list.length - 1, Math.round(Number(raw) || 1) - 1));
        if (index === this.selected) return;
        let parsed = this.cachedBuffers?.[index];
        if (!parsed) {
            parsed = parseObj(list[index], this.materials, this.normalizationSpan);
            if (this.cachedBuffers) this.cachedBuffers[index] = parsed;
        }
        if (!parsed) return;
        const data = parsed.data;
        this.selected = index;
        this.vertexCount = data.length / 6;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    }

    render(vm, width, height, force = false, viewport = null) {
        if (!this.dragging && !force) return null;
        this.sync(vm);
        if (!this.vertexCount) return null;
        const gl = this.gl;
        const vp = viewport || { x: 0, y: 0, w: width, h: height };
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(vp.x, vp.y, vp.w, vp.h);
        gl.clearColor(1, 1, 1, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.disable(gl.BLEND);
        gl.disable(gl.CULL_FACE);
        gl.useProgram(this.program);
        gl.uniform2f(this.uTurn, this.yaw, this.pitch);
        gl.uniform1f(this.uAspect, vp.w / Math.max(1, vp.h));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(this.aColor);
        gl.vertexAttribPointer(this.aColor, 3, gl.FLOAT, false, 24, 12);
        gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
        return { vertices: this.vertexCount, triangles: this.vertexCount / 3, drawCalls: 1 };
    }

    dispose() {
        this.gl.deleteBuffer(this.buffer);
        this.gl.deleteProgram(this.program);
    }
}

