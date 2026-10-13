/* 이 파일은 public/eniwanvm/polygon-batcher.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
/**
 * EniwanVM 2단계 — PolygonBatcher.
 *
 * 엔트리의 펜·채우기는 원래 Canvas2D 스캔라인으로 CPU에서 칠해진다. 면이 수백 개가
 * 되는 작품(horse-restore: 틱당 채우기 549회, 펜 2,864회)에서는 이 래스터라이즈가
 * 프레임을 다 먹는다. 여기서는 모든 면·선을 **버텍스로 바꿔 하나의 VBO에 쌓고
 * 한 번의 drawElements로** 넘긴다. 사각형 하나 = 4버텍스 + 6인덱스.
 *
 * 설계 결정:
 * - GL 컨텍스트를 **주입**받는다. 전역 canvas를 뒤지지 않으므로 Node에서 가짜 GL로
 *   버퍼 내용을 그대로 검사할 수 있다(verify-polygon-batcher.mjs).
 * - 색은 미리 곱한 알파(premultiplied)로 쌓는다. 엔트리의 "브러시 투명도"는 결국
 *   배경과의 블렌딩이므로, 셰이더에서 곱하고 blend는 (ONE, ONE_MINUS_SRC_ALPHA).
 * - 한 번에 한 종류만 그린다 — 텍스처가 없는 단색 패스라 상태 전환이 아예 없다.
 *   그래서 플러시는 버퍼가 찰 때와 end() 때만 일어난다.
 *
 * 좌표계는 엔트리 무대 그대로다: 원점 중앙, y가 위, 기본 480×270.
 *
 * ── 깊이(2026-10 추가) ──────────────────────────────────────────────────
 * 원래 이 배처는 완전 2D였다(`vec2 aPos` + `DEPTH_TEST` 끄기). 3D 작품은
 * 면을 중심 깊이로 **정렬해서** 뒤에서 앞으로 그리는 화가 알고리즘에 의지해야
 * 했는데, 면이 서로 파고들면(말 다리와 몸통처럼) 정렬로는 답이 없다.
 *
 * 그래서 버텍스에 z를 하나 더 싣고 하드웨어 깊이 버퍼를 쓸 수 있게 했다.
 * **기본값은 예전과 똑같이 깊이 검사 off**다 — 기존 2D 작품 수천 줄이
 * 그대로 돌아야 하므로, 켜는 쪽이 명시적으로 `setDepthTest(true)`를 부른다.
 *
 * z는 NDC가 아니라 **작품 좌표 그대로**(카메라까지의 거리 같은 값) 넣는다.
 * 셰이더가 `[depthNear, depthFar]`를 -1..1로 환산한다. 작을수록 앞이다.
 * 깊이 검사를 켜면 알파 블렌딩은 제출 순서에 민감해지므로(뒤 면이 나중에
 * 오면 깊이 검사에 걸려 블렌딩이 생략된다) 반투명 면은 여전히 정렬이 필요하다.
 */

const VERT_SRC = `
attribute vec3 aPos;
attribute vec4 aColor;
uniform vec2 uHalfStage;
uniform vec2 uDepthRange;
varying vec4 vColor;
void main() {
  vColor = aColor;
  float span = uDepthRange.y - uDepthRange.x;
  float nz = span == 0.0 ? 0.0 : ((aPos.z - uDepthRange.x) / span) * 2.0 - 1.0;
  gl_Position = vec4(aPos.xy / uHalfStage, clamp(nz, -1.0, 1.0), 1.0);
}
`;

const FRAG_SRC = `
precision mediump float;
varying vec4 vColor;
void main() {
  gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a);
}
`;

// x, y, z, r, g, b, a
const FLOATS_PER_VERTEX = 7;
const COLOR_BYTE_OFFSET = 12;   // 앞 세 float(x,y,z)를 지난 자리

const COLOR_CACHE = new Map();

/** '#rrggbb' / '#rgb' / 'rgb(...)' 를 0~1 네 성분으로. 못 읽으면 흰색. */
export function colorFromCss(css, alpha = 1) {
    if (typeof css !== 'string') return [1, 1, 1, alpha];
    let cached = COLOR_CACHE.get(css);
    if (!cached) {
        let r = 1, g = 1, b = 1;
        const hex = css.trim();
        if (/^#?[0-9a-f]{6}$/i.test(hex)) {
            const value = hex.startsWith('#') ? hex.slice(1) : hex;
            r = parseInt(value.slice(0, 2), 16) / 255;
            g = parseInt(value.slice(2, 4), 16) / 255;
            b = parseInt(value.slice(4, 6), 16) / 255;
        } else if (/^#?[0-9a-f]{3}$/i.test(hex)) {
            const value = hex.startsWith('#') ? hex.slice(1) : hex;
            r = parseInt(value[0] + value[0], 16) / 255;
            g = parseInt(value[1] + value[1], 16) / 255;
            b = parseInt(value[2] + value[2], 16) / 255;
        } else {
            const m = hex.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/i);
            if (m) {
                r = Number(m[1]) / 255; g = Number(m[2]) / 255; b = Number(m[3]) / 255;
                if (m[4] !== undefined) alpha = Number(m[4]);
            }
        }
        cached = [r, g, b];
        if (COLOR_CACHE.size < 512) COLOR_CACHE.set(css, cached);
    }
    return [cached[0], cached[1], cached[2], alpha];
}

export class PolygonBatcher {
    /**
     * @param {WebGLRenderingContext} gl
     * @param {{maxVertices?:number, stageWidth?:number, stageHeight?:number,
     *          depthNear?:number, depthFar?:number}} [options]
     */
    constructor(gl, options = {}) {
        if (!gl) throw new Error('PolygonBatcher: GL 컨텍스트가 필요하다');
        this.gl = gl;
        this.stageWidth = options.stageWidth || 480;
        this.stageHeight = options.stageHeight || 270;

        // 깊이 상태. 기본은 "예전 그대로" — 검사 off, 모든 도형 z=0.
        this.depthTest = false;
        this.depth = 0;
        this.depthNear = options.depthNear === undefined ? 0 : options.depthNear;
        this.depthFar = options.depthFar === undefined ? 10000 : options.depthFar;

        // Uint16 인덱스는 버텍스 65,536개가 상한이다. 확장이 있으면 32비트로 올린다.
        this.uint32Indices = Boolean(gl.getExtension && gl.getExtension('OES_element_index_uint'));
        const requested = options.maxVertices || 1 << 16;
        this.maxVertices = this.uint32Indices ? requested : Math.min(requested, 65536);
        this.maxIndices = this.maxVertices * 3;

        this.vertices = new Float32Array(this.maxVertices * FLOATS_PER_VERTEX);
        this.indices = this.uint32Indices
            ? new Uint32Array(this.maxIndices)
            : new Uint16Array(this.maxIndices);

        this.vertexCount = 0;
        this.indexCount = 0;
        this.started = false;

        this.stats = { flushes: 0, drawCalls: 0, vertices: 0, indices: 0, triangles: 0, discarded: 0 };

        this._initGl();
    }

    _initGl() {
        const gl = this.gl;
        const vs = this._compile(gl.VERTEX_SHADER, VERT_SRC);
        const fs = this._compile(gl.FRAGMENT_SHADER, FRAG_SRC);
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (gl.getProgramParameter && !gl.getProgramParameter(program, gl.LINK_STATUS)) {
            // 링크 로그는 마지막 줄에 원인이 있다. 앞을 자르지 않는다.
            throw new Error(`PolygonBatcher: 셰이더 링크 실패 — ${gl.getProgramInfoLog(program)}`);
        }
        this.program = program;
        this.aPos = gl.getAttribLocation(program, 'aPos');
        this.aColor = gl.getAttribLocation(program, 'aColor');
        this.uHalfStage = gl.getUniformLocation(program, 'uHalfStage');
        this.uDepthRange = gl.getUniformLocation(program, 'uDepthRange');

        this.vbo = gl.createBuffer();
        this.ibo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices.byteLength, gl.DYNAMIC_DRAW);
    }

    _compile(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (gl.getShaderParameter && !gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(`PolygonBatcher: 셰이더 컴파일 실패 — ${gl.getShaderInfoLog(shader)}`);
        }
        return shader;
    }

    /** 무대 크기가 바뀌면(전체화면 등) 알려 준다. */
    resize(stageWidth, stageHeight) {
        this.stageWidth = stageWidth;
        this.stageHeight = stageHeight;
    }

    /**
     * 이후 쌓이는 도형들의 깊이. 3D 작품은 면을 그리기 직전에 그 면의 깊이를
     * 넣는다(면 하나당 한 번이면 충분하다 — 꼭짓점별 z가 필요하면 아래
     * `convexPolygon(points, color, zs)`의 세 번째 인자를 쓴다).
     *
     * 유한한 수가 아니면 무시한다. NaN이 z로 들어가면 그 버텍스를 쓰는
     * 삼각형이 통째로 사라지고, 원인을 화면만 보고는 절대 못 찾는다.
     */
    setDepth(z) {
        const n = Number(z);
        if (Number.isFinite(n)) this.depth = n;
    }

    /**
     * 깊이 검사 on/off. GL 상태는 드로우 시점에 적용되므로, 프레임 중간에
     * 바뀌면 **지금까지 쌓인 것을 먼저 그려야** 한다(안 그러면 앞쪽 도형이
     * 소급해서 뒷쪽 규칙으로 그려진다).
     */
    setDepthTest(enabled) {
        const next = Boolean(enabled);
        if (next === this.depthTest) return;
        if (this.started) this.flush();
        this.depthTest = next;
        if (this.started) this._applyDepthState(false);
    }

    /** 깊이 범위(작품 좌표). near가 앞, far가 뒤. */
    setDepthRange(near, far) {
        const n = Number(near), f = Number(far);
        if (!Number.isFinite(n) || !Number.isFinite(f) || n === f) return;
        if (this.started) this.flush();
        this.depthNear = n;
        this.depthFar = f;
        if (this.started) this.gl.uniform2f(this.uDepthRange, n, f);
    }

    _applyDepthState(clearBuffer) {
        const gl = this.gl;
        if (!this.depthTest) {
            gl.disable(gl.DEPTH_TEST);
            return;
        }
        gl.enable(gl.DEPTH_TEST);
        if (gl.depthFunc) gl.depthFunc(gl.LEQUAL);
        if (gl.depthMask) gl.depthMask(true);
        // 색 버퍼는 펜 누적 때문에 지우지 않지만, 깊이는 프레임마다 지워야
        // 한다. 안 지우면 첫 프레임의 깊이가 영구히 남아 둘째 프레임부터
        // 아무것도 안 보인다.
        if (clearBuffer && gl.clear) gl.clear(gl.DEPTH_BUFFER_BIT);
    }

    /** 프레임 시작. 쌓기 전에 반드시 한 번. */
    begin() {
        const gl = this.gl;
        this.started = true;
        this.vertexCount = 0;
        this.indexCount = 0;
        // 다른 렌더러가 같은 WebGL 컨텍스트에서 남긴 상태를 물려받지 않는다.
        // FeedGrowRenderer는 3D 메시를 위해 CULL_FACE를 켠다. 그 뒤 블록 작품을
        // 불러오면 Entry 붓 삼각형의 감김 방향에 따라 면 전체가 사라질 수 있다.
        if (gl.CULL_FACE !== undefined) gl.disable(gl.CULL_FACE);
        if (gl.SCISSOR_TEST !== undefined) gl.disable(gl.SCISSOR_TEST);
        gl.useProgram(this.program);
        gl.uniform2f(this.uHalfStage, this.stageWidth / 2, this.stageHeight / 2);
        gl.uniform2f(this.uDepthRange, this.depthNear, this.depthFar);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        this._applyDepthState(true);
    }

    /** 프레임 끝. 남은 것을 올려 그린다. */
    end() {
        this.flush();
        this.started = false;
    }

    /**
     * 쌓인 것을 **그리지 않고** 버린다 — `brush_erase_all`(펜 모두 지우기)용.
     *
     * 왜 필요한가: 로직 틱과 렌더 프레임이 분리돼 있어서 한 프레임에 틱이 두 번
     * 돌 수 있다. 그때 "모두 지우기"가 `flush()`였다면 이미 지워진 1번 틱의 그림이
     * GPU로 올라가 2번 틱 그림과 겹쳐 보인다. 버려야 지운 게 지워진다.
     */
    discard() {
        this.stats.discarded += this.vertexCount;
        this.vertexCount = 0;
        this.indexCount = 0;
    }

    /** 쌓인 것을 GPU로 올려 한 번에 그린다. */
    flush() {
        if (this.indexCount === 0) return;
        const gl = this.gl;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0,
            this.vertices.subarray(0, this.vertexCount * FLOATS_PER_VERTEX));
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, this.indices.subarray(0, this.indexCount));

        const stride = FLOATS_PER_VERTEX * 4;
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(this.aColor);
        gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, COLOR_BYTE_OFFSET);

        gl.drawElements(gl.TRIANGLES, this.indexCount,
            this.uint32Indices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);

        this.stats.flushes += 1;
        this.stats.drawCalls += 1;
        this.stats.vertices += this.vertexCount;
        this.stats.indices += this.indexCount;
        this.stats.triangles += this.indexCount / 3;

        this.vertexCount = 0;
        this.indexCount = 0;
    }

    /**
     * 버텍스 `verts`개와 인덱스 `inds`개가 들어갈 자리를 확보한다.
     * 모자라면 지금까지 쌓은 걸 먼저 그려 비운다 — 그래서 한 프레임이 여러 드로우콜로
     * 쪼개질 수 있고, 그건 통계(stats.drawCalls)에 그대로 드러난다.
     */
    _reserve(verts, inds) {
        if (verts > this.maxVertices || inds > this.maxIndices) {
            throw new Error(`PolygonBatcher: 도형 하나가 버퍼보다 크다 (버텍스 ${verts}, 인덱스 ${inds})`);
        }
        if (this.vertexCount + verts > this.maxVertices || this.indexCount + inds > this.maxIndices) {
            this.flush();
        }
    }

    _pushVertex(x, y, color, z) {
        const o = this.vertexCount * FLOATS_PER_VERTEX;
        const v = this.vertices;
        v[o] = x; v[o + 1] = y; v[o + 2] = z === undefined ? this.depth : z;
        v[o + 3] = color[0]; v[o + 4] = color[1]; v[o + 5] = color[2];
        v[o + 6] = color[3] === undefined ? 1 : color[3];
        this.vertexCount += 1;
    }

    /**
     * 사각형 하나 — 4버텍스 + 6인덱스. 꼭짓점은 순서대로 돌아가야 한다
     * (시계/반시계 무관, 다만 지그재그면 모래시계 모양이 된다).
     */
    quad(x1, y1, x2, y2, x3, y3, x4, y4, color) {
        this._reserve(4, 6);
        const base = this.vertexCount;
        this._pushVertex(x1, y1, color);
        this._pushVertex(x2, y2, color);
        this._pushVertex(x3, y3, color);
        this._pushVertex(x4, y4, color);
        const i = this.indices;
        let o = this.indexCount;
        i[o] = base; i[o + 1] = base + 1; i[o + 2] = base + 2;
        i[o + 3] = base; i[o + 4] = base + 2; i[o + 5] = base + 3;
        this.indexCount = o + 6;
    }

    /** 삼각형 하나 — 3버텍스 + 3인덱스. */
    triangle(x1, y1, x2, y2, x3, y3, color) {
        this._reserve(3, 3);
        const base = this.vertexCount;
        this._pushVertex(x1, y1, color);
        this._pushVertex(x2, y2, color);
        this._pushVertex(x3, y3, color);
        const i = this.indices;
        let o = this.indexCount;
        i[o] = base; i[o + 1] = base + 1; i[o + 2] = base + 2;
        this.indexCount = o + 3;
    }

    /**
     * 볼록 다각형 — 부채꼴 삼각화(n버텍스 + 3(n-2)인덱스).
     * **오목 다각형은 안 된다**(부채꼴이 바깥으로 삐져나간다). 전개도 면은 사각형이므로
     * 현재 쓰임에는 충분하고, 오목이 필요해지면 귀 자르기(earcut)를 따로 붙인다.
     * @param {number[]} points [x0,y0, x1,y1, …]
     * @param {number[]} [zs] 꼭짓점별 깊이. 없으면 현재 `setDepth` 값을 공유한다
     *   (면 하나가 평평한 깊이를 갖는다 — 면끼리 파고드는 경우에만 꼭짓점별이 필요하다).
     */
    convexPolygon(points, color, zs) {
        const n = points.length >> 1;
        if (n < 3) return;
        this._reserve(n, (n - 2) * 3);
        const base = this.vertexCount;
        for (let k = 0; k < n; k += 1) {
            this._pushVertex(points[k * 2], points[k * 2 + 1], color, zs ? zs[k] : undefined);
        }
        const i = this.indices;
        let o = this.indexCount;
        for (let k = 1; k < n - 1; k += 1) {
            i[o] = base; i[o + 1] = base + k; i[o + 2] = base + k + 1;
            o += 3;
        }
        this.indexCount = o;
    }

    /**
     * 선 한 토막을 두께만큼 부풀려 사각형으로. 엔트리 펜 선이 여기로 온다.
     * 길이 0인 선은 법선을 못 구하니 조용히 버린다(NaN이 버퍼에 들어가면
     * 그 프레임의 드로우콜 전체가 사라진다).
     */
    segment(x0, y0, x1, y1, width, color) {
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (!(len > 0) || !(width > 0)) return;
        const h = width / 2;
        const nx = (-dy / len) * h, ny = (dx / len) * h;
        this.quad(
            x0 + nx, y0 + ny,
            x1 + nx, y1 + ny,
            x1 - nx, y1 - ny,
            x0 - nx, y0 - ny,
            color,
        );
    }

    /**
     * 이어진 선(폴리라인). 토막마다 사각형을 하나씩 — 꺾이는 곳의 이음새는
     * 처리하지 않는다. 두께가 얇을 때(엔트리 기본 1~3px)는 눈에 안 띄고,
     * 두꺼운 선이 필요하면 각 꼭짓점에 원을 찍는 쪽이 싸다.
     */
    polyline(points, width, color) {
        const n = points.length >> 1;
        for (let k = 0; k < n - 1; k += 1) {
            this.segment(points[k * 2], points[k * 2 + 1], points[k * 2 + 2], points[k * 2 + 3], width, color);
        }
    }

    /** 원 — 부채꼴. 펜 끝 둥글리기와 점 찍기(brush_stamp)에 쓴다. */
    circle(cx, cy, radius, color, segments = 12) {
        const n = Math.max(3, segments | 0);
        const points = new Array(n * 2);
        for (let k = 0; k < n; k += 1) {
            const a = (k / n) * Math.PI * 2;
            points[k * 2] = cx + Math.cos(a) * radius;
            points[k * 2 + 1] = cy + Math.sin(a) * radius;
        }
        this.convexPolygon(points, color);
    }

    /** 통계 초기화 — 대시보드가 프레임마다 부른다. */
    resetStats() {
        this.stats = { flushes: 0, drawCalls: 0, vertices: 0, indices: 0, triangles: 0, discarded: 0 };
    }

    dispose() {
        const gl = this.gl;
        if (this.vbo) gl.deleteBuffer(this.vbo);
        if (this.ibo) gl.deleteBuffer(this.ibo);
        if (this.program) gl.deleteProgram(this.program);
        this.vbo = this.ibo = this.program = null;
    }
}

export default PolygonBatcher;
