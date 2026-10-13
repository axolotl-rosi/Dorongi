/* 이 파일은 public/eniwanvm/sprite-pass.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
/**
 * EniwanVM — 모양(스프라이트) 그림 패스.
 *
 * 여기까지 오기 전의 EniwanVM은 **펜과 채우기만** 그릴 수 있었다. 모양 블록이
 * 바꾸는 상태(모양 번호·크기·뒤집기·효과)는 VM이 정확히 들고 있었는데 그걸
 * 화면에 올리는 패스가 없어서, 모양으로 그리는 작품은 얹으면 빈 무대가 됐다.
 * (그래서 확장의 호환성 관문에 `no-draw`가 있었다.)
 *
 * 설계 결정:
 * - **GL 컨텍스트를 주입**받는다. PolygonBatcher와 같은 이유 — Node에서 가짜 GL로
 *   버퍼에 들어간 숫자를 그대로 검사할 수 있다(verify-sprite-pass.mjs).
 * - 좌표 계산(`spriteQuad`)과 색 효과 판정(`hsvRegime`)은 **순수 함수**로 빼 뒀다.
 *   화면을 눈으로 비교하는 것만으로는 "조금 틀어진 회전"을 못 잡는다.
 * - 한 텍스처당 드로우콜 하나. 효과는 유니폼이 아니라 **버텍스 속성**으로 싣는다
 *   — 복제본 360개가 각자 다른 투명도를 가져도 드로우콜은 하나다.
 * - 텍스처는 PIXI와 같이 **미리 곱한 알파**로 올린다. 배처(펜)도 미리 곱한 알파라
 *   같은 블렌드 식(ONE, ONE_MINUS_SRC_ALPHA)을 쓸 수 있다.
 *
 * ── 엔진과 맞춘 것들 (근거: entryjs src/class/entity.js, graphicEngine/GEHelper.ts) ──
 * - 그리는 순서: `Entry.stage.sortZorder`가 오브젝트 목록을 **거꾸로** 돌며 자식
 *   번호를 매긴다 → **objects[0]이 맨 앞**이다. 그래서 뒤에서 앞으로 = 목록 역순.
 * - 화면 변환: `object.x = x`, `object.y = -y`(PIXI는 y가 아래), `pivot = (regX, regY)`,
 *   회전은 `rotation`만. **`direction`(이동 방향)은 그림을 돌리지 않는다** — 엔진에서
 *   `object.direction`은 편집기의 방향 화살표만 쓰는 값이다(렌더러는 읽지 않는다).
 *   이름만 보고 더하면 모든 오브젝트가 90도 틀어진다.
 * - 효과는 `applyFilter`의 필터 배열 순서대로 **차례로** 먹는다: 밝기 → 색깔.
 *   PIXI는 필터마다 패스를 끊어 8비트 텍스처에 쓰므로 패스 사이에서 **잘린다**.
 * - 밝기: WebGL이면 `value/255`를 r,g,b에 **더한다**(GEHelper.colorFilter.brightness).
 * - 색깔(hsv): 아래 `hsvRegime` 주석 참고. 엔진의 2번 구간 행렬에는 **버그가 있고**
 *   (G' = R) 우리도 그대로 따른다.
 * - 투명도: `object.alpha`가 스프라이트 전체에 곱해진다. 엔트리 값 0(불투명)~100(투명).
 */

/** 무대 기본 크기 — 런타임과 같은 값. */
export const STAGE_WIDTH = 480;
export const STAGE_HEIGHT = 270;

const DEG = Math.PI / 180;

/**
 * 스프라이트 사각형의 네 꼭짓점을 무대 좌표(원점 중앙, y가 위)로 계산한다.
 *
 * 꼭짓점 순서는 모양 픽셀의 좌상 → 우상 → 우하 → 좌하이고, UV도 같은 순서다.
 * `out`에 8개(x,y ×4)를 채워 돌려준다 — 프레임마다 배열을 새로 만들면
 * 복제본 360개에서 GC가 프레임을 먹는다.
 *
 * @param {Float64Array|number[]} out 길이 8 이상
 */
export function spriteQuad(out, x, y, w, h, scaleX, scaleY, rotationDeg, regX, regY) {
    const rad = rotationDeg * DEG;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // 모양 픽셀 좌표(u는 오른쪽, v는 **아래**)의 네 꼭짓점.
    const us = [0, w, w, 0];
    const vs = [0, 0, h, h];
    for (let i = 0; i < 4; i += 1) {
        const lx = (us[i] - regX) * scaleX;
        const ly = (vs[i] - regY) * scaleY;
        // PIXI(y 아래)에서 회전시킨 뒤 y를 뒤집어 무대 좌표로 되돌린다.
        out[i * 2] = x + (cos * lx - sin * ly);
        out[i * 2 + 1] = y - (sin * lx + cos * ly);
    }
    return out;
}

/**
 * 색깔 효과 → 어느 행렬 구간인지와 cos/sin.
 *
 * 엔진(`entity.js applyFilter`)을 그대로 옮긴 것이다:
 *   degrees = hsv * 3.6 · r = degrees * 3 * π / 180
 *   v = |hsv / 100| · v > 1 이면 **소수부만**(v - floor(v))
 *   0 < v <= 0.33 → 1구간 · <= 0.66 → 2구간 · <= 0.99 → 3구간 · 그 밖은 효과 없음
 *
 * 그래서 `색깔 효과를 100으로`는 v=1이 되어 **아무 효과가 없다**(0.99 초과).
 * 이상해 보여도 엔트리가 그렇다 — 고치면 작품이 다르게 보인다.
 *
 * 구간별 행렬(5×5 중 RGB만, 열은 r,g,b):
 *   1구간: R'=R, G'= cos·G + sin·B, B'= -sin·G + cos·B
 *   2구간: R'= cos·R + sin·B, **G'= R**, B'= sin·R + cos·B
 *          ← G 행이 `[1,0,0]`이다. `[0,1,0]`을 의도했을 텐데 엔진이 그렇지 않다.
 *            초록이 빨강으로 덮이는 이 버그까지 맞춰야 같은 그림이 된다.
 *   3구간: R'= cos·R + sin·G, G'= -sin·R + cos·G, B'=B
 *
 * @returns {{regime:number, cos:number, sin:number}} regime 0=효과 없음
 */
export function hsvRegime(hsv) {
    const rad = hsv * 3.6 * 3 * DEG;
    let v = Math.abs(hsv / 100);
    if (v > 1) v -= Math.floor(v);
    let regime = 0;
    if (v > 0 && v <= 0.33) regime = 1;
    else if (v > 0 && v <= 0.66) regime = 2;
    else if (v > 0 && v <= 0.99) regime = 3;
    return { regime, cos: Math.cos(rad), sin: Math.sin(rad) };
}

// x, y, u, v, alpha, bright, regime, cos, sin
const FLOATS_PER_VERTEX = 9;

const VERT_SRC = `
attribute vec2 aPos;
attribute vec2 aUV;
attribute vec3 aFx;      // alpha(0~1), bright(-100~100), regime(0~3)
attribute vec2 aHue;     // cos, sin
uniform vec2 uHalfStage;
varying vec2 vUV;
varying vec3 vFx;
varying vec2 vHue;
void main() {
  vUV = aUV;
  vFx = aFx;
  vHue = aHue;
  gl_Position = vec4(aPos / uHalfStage, 0.0, 1.0);
}
`;

// 엔진은 필터를 **패스로 끊어** 먹인다. 패스 사이의 8비트 반올림까지 흉내 낼 수는
// 없지만, **자르기(clamp)는 반드시** 같아야 한다 — 밝기로 넘친 값이 색깔 행렬에
// 들어가면 엔트리와 다른 색이 나온다.
const FRAG_SRC = `
precision mediump float;
varying vec2 vUV;
varying vec3 vFx;
varying vec2 vHue;
uniform sampler2D uTex;
void main() {
  vec4 t = texture2D(uTex, vUV);
  // PIXI의 색행렬 필터는 **미리 곱한 알파를 되돌린 뒤** 행렬을 먹인다.
  vec3 c = t.a > 0.0 ? t.rgb / t.a : t.rgb;

  // 1) 밝기 — r,g,b에 같은 값을 더하고 자른다.
  c = clamp(c + vec3(vFx.y), 0.0, 1.0);

  // 2) 색깔 — 구간별 행렬.
  float regime = vFx.z;
  float cs = vHue.x;
  float sn = vHue.y;
  if (regime > 2.5) {
    c = clamp(vec3(cs * c.r + sn * c.g, -sn * c.r + cs * c.g, c.b), 0.0, 1.0);
  } else if (regime > 1.5) {
    c = clamp(vec3(cs * c.r + sn * c.b, c.r, sn * c.r + cs * c.b), 0.0, 1.0);
  } else if (regime > 0.5) {
    c = clamp(vec3(c.r, cs * c.g + sn * c.b, -sn * c.g + cs * c.b), 0.0, 1.0);
  }

  float a = t.a * vFx.x;
  gl_FragColor = vec4(c * a, a);
}
`;

/**
 * 모양 그림 텍스처 저장소.
 *
 * 엔트리 서버에 올라간 작품은 모양을 project.json에 담지 않고 **주소만** 들고 있다
 * (`project.js assetSrc`). 그래서 작품을 열 때 주소를 모아 **미리 받아 둔다** —
 * 블록이 모양을 바꾸는 순간에 받기 시작하면 첫 프레임이 빈 화면으로 지나간다.
 *
 * 받지 못한 주소(404·CORS)는 `failed`에 남긴다. 조용히 빈 자리로 두면 "왜 안
 * 보이지"를 아무 단서 없이 찾게 된다.
 */
export class TextureCache {
    /**
     * @param {WebGLRenderingContext} gl
     * @param {{origin?:string, ImageCtor?:Function, pageOrigin?:string,
     *   allowCrossOrigin?:boolean}} [options] origin은 대시보드처럼 다른 출처에서
     *   돌 때 앞에 붙일 도메인(소리와 같은 규칙).
     */
    constructor(gl, options = {}) {
        this.gl = gl;
        this.origin = options.origin || '';
        this.ImageCtor = options.ImageCtor
            || (typeof Image === 'function' ? Image : null);
        this.canvasFactory = options.canvasFactory || (() => (
            typeof document !== 'undefined' ? document.createElement('canvas') : null
        ));
        // 다른 출처의 모양도 **받으러 간다**(기본값).
        //
        // 전에는 반대였다. "playentry는 CORS 헤더를 주지 않으니 어차피 못 받는다"고
        // 적어 두고 교차 출처면 시도조차 하지 않았다. 그 전제가 틀렸다 — 실제로
        // 재어 보면 업로드 버킷은 `*`를 준다:
        //
        //   GET https://playentry.org/uploads/font/NanumSquare_acR.woff
        //   → 200, access-control-allow-origin: *
        //
        // 그래서 `crossOrigin='anonymous'`로 받으면 대시보드(localhost)에서도 받아서
        // 텍스처로 올릴 수 있다. 받아 보지도 않고 포기하면 "서버 작품은 모양이 없다"가
        // 되고, 그게 바로 사용자가 겪은 증상이다.
        //
        // 다만 걱정 하나는 남는다: 죽은 주소를 기다리는 동안 작품 열기가 멈춘다.
        // 그건 거부가 아니라 `timeoutMs`로 끊는다.
        this.pageOrigin = options.pageOrigin
            ?? (typeof location === 'object' && location ? location.origin : '');
        this.allowCrossOrigin = options.allowCrossOrigin !== false;
        /** 한 장을 기다릴 상한(ms). 0이면 끊지 않는다. */
        this.timeoutMs = options.timeoutMs === undefined ? 8000 : options.timeoutMs;
        /** @type {Map<string, {tex:WebGLTexture, w:number, h:number}>} */
        this.textures = new Map();
        /** @type {Map<string, Promise>} */
        this.pending = new Map();
        /** @type {Map<string, string>} 주소 → 실패 이유 */
        this.failed = new Map();
        // Enabled by Runtime only for programs that use reach_something.
        this.collectAlphaMasks = false;
    }

    /** 올라간 텍스처. 아직 없으면 null — 그릴 쪽은 건너뛴다. */
    get(src) {
        const entry = this.textures.get(src);
        return entry ? entry.tex : null;
    }

    /** Alpha-aware Entry touching test. Coordinates are picture pixels. */
    hitAlpha(src, x, y) {
        const entry = this.textures.get(src);
        if (!entry) return true;
        const px = Math.floor(x);
        const py = Math.floor(y);
        if (px < 0 || py < 0 || px >= entry.w || py >= entry.h) return false;
        if (!entry.alphaMask) return true;
        const index = py * entry.w + px;
        return Boolean(entry.alphaMask[index >> 3] & (1 << (index & 7)));
    }

    has(src) { return this.textures.has(src); }

    /** 주소 목록을 미리 받는다. **실패해도 거부하지 않는다** — 한 모양이 깨졌다고
     *  작품 전체를 못 열면 더 나쁘다. 실패는 `failed`에 모인다. */
    async preload(srcs) {
        const jobs = [];
        for (const src of srcs) {
            if (!src || this.textures.has(src) || this.failed.has(src)) continue;
            if (!this.pending.has(src)) this.pending.set(src, this._load(src));
            jobs.push(this.pending.get(src));
        }
        await Promise.all(jobs);
        return { loaded: this.textures.size, failed: this.failed.size };
    }

    /**
     * 받으러 갈 최종 주소. **엔트리 서버 규칙 경로(`/uploads/…`)에만** 호스트가
     * 준 도메인을 붙인다.
     *
     * 뿌리 상대 경로 전부에 붙이면 안 된다: 로컬 `.ent`를 대시보드로 열면
     * 호스트가 그림을 `/api/ent-asset/<세션>/temp/…`(자기 주소)로 내주는데,
     * 거기에 playentry를 붙이면 없는 주소가 되고 교차 출처라 받으러 가지도
     * 못해 **그림이 조용히 사라진다**.
     */
    resolve(src) {
        return this.origin && src.startsWith('/uploads/') ? this.origin + src : src;
    }

    /** 이 주소가 지금 페이지와 다른 출처인가. 판정 불가면 "같다"로 본다. */
    isCrossOrigin(url) {
        if (!this.pageOrigin) return false;
        if (url.startsWith('/')) return false;
        if (!/^(https?:)?\/\//.test(url)) return false;
        try {
            return new URL(url, this.pageOrigin).origin !== this.pageOrigin;
        } catch {
            return false;
        }
    }

    _load(src) {
        return new Promise((resolve) => {
            if (!this.ImageCtor) {
                this.failed.set(src, 'Image 생성자가 없다(브라우저 밖)');
                resolve();
                return;
            }
            const url = this.resolve(src);
            if (!this.allowCrossOrigin && this.isCrossOrigin(url)) {
                this.failed.set(src, '다른 출처의 모양이라 받지 않았다(CORS)');
                resolve();
                return;
            }
            const img = new this.ImageCtor();
            // 같은 출처면 필요 없지만, 대시보드처럼 도메인을 붙여 받을 때는
            // 이게 없으면 텍스처로 올리는 순간 CORS로 막힌다.
            img.crossOrigin = 'anonymous';
            // 한 장이 끝까지 대답하지 않아도 작품 열기는 계속돼야 한다.
            // (끊은 뒤에 늦게 온 onload/onerror는 `done`이 막는다)
            let done = false;
            let timer = null;
            const finish = (reason) => {
                if (done) return;
                done = true;
                if (timer !== null) clearTimeout(timer);
                if (reason) this.failed.set(src, reason);
                this.pending.delete(src);
                resolve();
            };
            if (this.timeoutMs > 0 && typeof setTimeout === 'function') {
                // unref하지 않는다 — Node에서 unref하면 타이머가 뜨기 전에
                // 프로세스가 끝나 버려서 기다리던 약속이 영원히 안 풀린다.
                timer = setTimeout(
                    () => finish(`시간 초과(${this.timeoutMs}ms) — ${url}`),
                    this.timeoutMs,
                );
            }
            img.onload = () => {
                if (done) return;
                let reason = '';
                try {
                    this._upload(src, img);
                } catch (e) {
                    reason = String(e && e.message ? e.message : e);
                }
                finish(reason);
            };
            img.onerror = () => finish(`받지 못했다(404/CORS) — ${url}`);
            img.src = url;
        });
    }

    _upload(src, img) {
        const gl = this.gl;
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (!(w > 0) || !(h > 0)) throw new Error(`모양 크기가 잘못됐다(${w}×${h})`);

        // Chrome은 SVG가 Image.onload까지 끝났어도 WebGL1의 HTMLImageElement 업로드를
        // INVALID_VALUE/bad image data로 거부할 수 있다(기본 엔트리봇 SVG에서 재현).
        // WebGL이 확실히 받는 RGBA 비트맵 캔버스로 한 번 래스터화한다. blob: SVG처럼
        // 주소에 확장자가 없는 경우도 있어서 파일명으로 SVG 여부를 추측하지 않는다.
        let source = img;
        let alphaMask = null;
        const canvas = this.canvasFactory?.();
        if (canvas) {
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext?.('2d');
            if (!ctx) throw new Error('모양을 비트맵으로 바꿀 2D 캔버스가 없다');
            ctx.drawImage(img, 0, 0, w, h);
            source = canvas;
            // `reach_something` ignores transparent pixels in Entry. Keep one
            // bit per source pixel (rather than retaining 4-byte RGBA data).
            // A fully transparent padding-heavy 960x540 picture then costs
            // about 63KiB and no canvas needs to stay alive.
            if (this.collectAlphaMasks) try {
                const rgba = ctx.getImageData(0, 0, w, h).data;
                alphaMask = new Uint8Array(Math.ceil((w * h) / 8));
                for (let pixel = 0, offset = 3; pixel < w * h; pixel += 1, offset += 4) {
                    if (rgba[offset] > 0) alphaMask[pixel >> 3] |= 1 << (pixel & 7);
                }
            } catch {
                // CORS-tainted or host-provided canvases still render. Their
                // touching reporter falls back to the rotated bounds.
                alphaMask = null;
            }
        }
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // PIXI와 같이 미리 곱한 알파로 올린다 — 셰이더와 블렌드 식이 그 가정이다.
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        // 모양 그림은 2의 제곱이 아닌 크기가 대부분이다. WebGL1에서 그런 텍스처는
        // REPEAT이나 밉맵을 쓰면 **조용히 검게** 나온다. CLAMP + LINEAR만 쓴다.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.textures.set(src, {
            tex,
            w,
            h,
            alphaMask,
        });
    }

    dispose() {
        for (const { tex } of this.textures.values()) this.gl.deleteTexture(tex);
        this.textures.clear();
        this.pending.clear();
    }
}

/**
 * 스프라이트 배처. 텍스처가 바뀔 때만 드로우콜이 끊긴다.
 *
 * 쌓는 순서가 곧 그리는 순서다(깊이 검사를 쓰지 않는다) — 엔트리의 z순서는
 * 목록 순서라서, 뒤에서 앞으로 넣으면 그대로 맞는다.
 */
export class SpritePass {
    constructor(gl, options = {}) {
        if (!gl) throw new Error('SpritePass: GL 컨텍스트가 필요하다');
        this.gl = gl;
        this.stageWidth = options.stageWidth || STAGE_WIDTH;
        this.stageHeight = options.stageHeight || STAGE_HEIGHT;
        this.maxQuads = options.maxQuads || 4096;

        this.vertices = new Float32Array(this.maxQuads * 4 * FLOATS_PER_VERTEX);
        this.indices = new Uint16Array(this.maxQuads * 6);
        // 인덱스는 사각형마다 똑같은 모양이라 **미리 다 채워 둔다** — 프레임마다
        // 다시 쓰면 복제본이 많은 작품에서 그만큼이 공짜로 버려진다.
        for (let q = 0; q < this.maxQuads; q += 1) {
            const v = q * 4;
            const o = q * 6;
            this.indices[o] = v; this.indices[o + 1] = v + 1; this.indices[o + 2] = v + 2;
            this.indices[o + 3] = v; this.indices[o + 4] = v + 2; this.indices[o + 5] = v + 3;
        }

        this.quadCount = 0;
        this.currentTex = null;
        this.started = false;
        this._corners = new Float64Array(8);
        this.stats = { drawCalls: 0, quads: 0, skippedNoTexture: 0 };

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
            throw new Error(`SpritePass: 셰이더 링크 실패 — ${gl.getProgramInfoLog(program)}`);
        }
        this.program = program;
        this.aPos = gl.getAttribLocation(program, 'aPos');
        this.aUV = gl.getAttribLocation(program, 'aUV');
        this.aFx = gl.getAttribLocation(program, 'aFx');
        this.aHue = gl.getAttribLocation(program, 'aHue');
        this.uHalfStage = gl.getUniformLocation(program, 'uHalfStage');
        this.uTex = gl.getUniformLocation(program, 'uTex');

        this.vbo = gl.createBuffer();
        this.ibo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
        // 인덱스는 변하지 않는다 — 한 번만 올린다.
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices, gl.STATIC_DRAW);
    }

    _compile(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (gl.getShaderParameter && !gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(`SpritePass: 셰이더 컴파일 실패 — ${gl.getShaderInfoLog(shader)}`);
        }
        return shader;
    }

    resize(stageWidth, stageHeight) {
        this.stageWidth = stageWidth || this.stageWidth;
        this.stageHeight = stageHeight || this.stageHeight;
    }

    begin() {
        const gl = this.gl;
        this.started = true;
        this.quadCount = 0;
        this.currentTex = null;
        // 네이티브 3D 렌더러에서 돌아온 직후에도 2D 합성 패스가 GL 상태를
        // 명시적으로 소유해야 한다. 특히 CULL_FACE가 남아 있으면 펜 FBO를 붙이는
        // 화면 사각형 자체가 잘려 결과가 완전히 투명하게 보인다.
        if (gl.CULL_FACE !== undefined) gl.disable(gl.CULL_FACE);
        if (gl.SCISSOR_TEST !== undefined) gl.disable(gl.SCISSOR_TEST);
        gl.useProgram(this.program);
        gl.uniform2f(this.uHalfStage, this.stageWidth / 2, this.stageHeight / 2);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        // 스프라이트는 **깊이 검사 없이** 쌓은 순서대로 그린다. 3D 작품이 켜 둔
        // 깊이 검사가 남아 있으면 반투명 스프라이트가 서로를 가린다.
        gl.disable(gl.DEPTH_TEST);
    }

    /**
     * 스프라이트 하나. 텍스처가 바뀌면 먼저 플러시한다.
     * @param {WebGLTexture} tex
     * @param {object} t 꼭짓점 계산에 필요한 값들
     */
    draw(tex, t) {
        if (!tex) { this.stats.skippedNoTexture += 1; return; }
        if (tex !== this.currentTex || this.quadCount >= this.maxQuads) {
            this.flush();
            this.currentTex = tex;
        }
        const c = spriteQuad(this._corners, t.x, t.y, t.w, t.h,
            t.scaleX, t.scaleY, t.rotation, t.regX, t.regY);
        const { regime, cos, sin } = hsvRegime(t.hsv);
        // 엔트리 투명도(0 불투명 ~ 100 투명) → 엔진 내부 alpha. 깎는 자리도 엔진과 같다.
        const alpha = Math.max(0, Math.min(1, 1 - t.alpha / 100));
        const bright = Math.max(-100, Math.min(100, t.bright)) / 255;

        // 모양 픽셀의 UV. scaleX/scaleY가 음수(뒤집기)면 꼭짓점 좌표가 이미
        // 뒤집혀 있으므로 UV는 건드리지 않는다 — 양쪽을 다 뒤집으면 제자리로 온다.
        const uv = [0, 0, 1, 0, 1, 1, 0, 1];
        const v = this.vertices;
        let o = this.quadCount * 4 * FLOATS_PER_VERTEX;
        for (let i = 0; i < 4; i += 1) {
            v[o] = c[i * 2]; v[o + 1] = c[i * 2 + 1];
            v[o + 2] = uv[i * 2]; v[o + 3] = uv[i * 2 + 1];
            v[o + 4] = alpha; v[o + 5] = bright; v[o + 6] = regime;
            v[o + 7] = cos; v[o + 8] = sin;
            o += FLOATS_PER_VERTEX;
        }
        this.quadCount += 1;
        this.stats.quads += 1;
    }

    flush() {
        if (this.quadCount === 0 || !this.currentTex) { this.quadCount = 0; return; }
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0,
            this.vertices.subarray(0, this.quadCount * 4 * FLOATS_PER_VERTEX));
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);

        const stride = FLOATS_PER_VERTEX * 4;
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(this.aUV);
        gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, stride, 8);
        gl.enableVertexAttribArray(this.aFx);
        gl.vertexAttribPointer(this.aFx, 3, gl.FLOAT, false, stride, 16);
        gl.enableVertexAttribArray(this.aHue);
        gl.vertexAttribPointer(this.aHue, 2, gl.FLOAT, false, stride, 28);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.currentTex);
        gl.uniform1i(this.uTex, 0);
        gl.drawElements(gl.TRIANGLES, this.quadCount * 6, gl.UNSIGNED_SHORT, 0);

        this.stats.drawCalls += 1;
        this.quadCount = 0;
    }

    end() {
        this.flush();
        this.started = false;
    }

    resetStats() {
        this.stats.drawCalls = 0;
        this.stats.quads = 0;
        this.stats.skippedNoTexture = 0;
    }

    dispose() {
        const gl = this.gl;
        gl.deleteBuffer(this.vbo);
        gl.deleteBuffer(this.ibo);
        gl.deleteProgram(this.program);
    }
}

/**
 * 펜 그림이 쌓이는 오프스크린 버퍼.
 *
 * 전에는 펜을 **기본 프레임버퍼에 그대로 누적**했다(`preserveDrawingBuffer`).
 * 모양이 없을 때는 그게 가장 싼 방법이었다 — 지우지 않으니 그냥 남는다.
 * 그런데 모양은 **프레임마다 다시** 그려야 하고, 그러려면 화면을 지워야 한다.
 * 한 버퍼에서 둘을 같이 할 수는 없다(지우면 펜이 날아가고, 안 지우면 모양이
 * 번진다). 그래서 펜만 여기에 쌓고, 프레임마다 화면을 지운 뒤
 * **펜 → 모양** 순으로 합성한다.
 *
 * 크기는 **무대 뷰포트와 같게** 잡는다(레터박스 띠는 뺀다). 그래야 합성할 때
 * 텍스처 전체가 무대 사각형에 1:1로 얹혀서, 어긋남을 계산할 일이 없다.
 *
 * 깊이 버퍼도 같이 붙인다 — 3D 작품은 펜 면에 깊이 검사를 쓴다. 없으면 GL이
 * 깊이 검사를 조용히 무시해서 뒷면이 앞면을 덮는다.
 */
export class PenFramebuffer {
    constructor(gl) {
        this.gl = gl;
        this.fbo = null;
        this.tex = null;
        this.completedTex = null;
        this.erasedThisTick = false;
        this.depth = null;
        this.spareFbo = null;
        this.spareTex = null;
        this.spareDepth = null;
        this.width = 0;
        this.height = 0;
    }

    /** 렌더링에 노출할 텍스처. 이번 틱에서 지운 적이 있다면 틱이 끝날 때까지 이전 완성본을, 점진적 렌더러는 실시간 버퍼를 돌려준다. */
    get presentationTex() {
        if (this.erasedThisTick && this.completedTex) {
            return this.completedTex;
        }
        return this.tex;
    }

    /** 필요한 크기로 맞춘다. 다시 만들었으면 true(= 펜 내용이 사라졌다). */
    resize(width, height) {
        const w = Math.floor(width);
        const h = Math.floor(height);
        if (this.fbo && this.width === w && this.height === h) return false;
        this.dispose();
        const gl = this.gl;
        this.width = w;
        this.height = h;
        const makeTarget = () => {
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            // 합성할 때 1:1로 얹히므로 보간이 필요 없고, 무대 크기는 2의 제곱이
            // 아니다 — WebGL1에서 그런 텍스처에 밉맵/REPEAT을 쓰면 검게 나온다.
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            const depth = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
            return { fbo, tex, depth };
        };
        const front = makeTarget();
        const spare = makeTarget();
        this.fbo = front.fbo;
        this.tex = front.tex;
        this.depth = front.depth;
        this.spareFbo = spare.fbo;
        this.spareTex = spare.tex;
        this.spareDepth = spare.depth;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        return true;
    }

    /** 이 버퍼로 그리기 시작. 뷰포트도 버퍼 전체로 맞춘다. */
    bind() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.viewport(0, 0, this.width, this.height);
    }

    /** 화면으로 돌아간다. 뷰포트는 부른 쪽이 되돌린다(레터박스를 아는 건 그쪽이다). */
    unbind() {
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }

    /** 펜 모두 지우기. **투명**으로 지운다 — 배경색으로 지우면 합성할 때 모양을 덮는다. */
    clear(preserveCompleted = true) {
        // 첫 지우기에서는 직전 완성 FBO와 빈 작업 FBO를 맞바꾼다. 이전 구현은
        // copyTexSubImage2D로 화면 전체를 복사해 ray caster에서 GPU 동기화를 일으켰다.
        // 포인터 교환이면 같은 완성 화면을 보존하면서 픽셀 복사는 0회다.
        if (preserveCompleted && !this.erasedThisTick && this.spareFbo) {
            this.completedTex = this.tex;
            [this.fbo, this.spareFbo] = [this.spareFbo, this.fbo];
            [this.tex, this.spareTex] = [this.spareTex, this.tex];
            [this.depth, this.spareDepth] = [this.spareDepth, this.depth];
        }
        this.erasedThisTick = true;
        const gl = this.gl;
        this.bind();
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this.unbind();
    }

    /** 틱이 끝났을 때 완전한 프레임을 보존해 틱 진행 중 깜빡임을 막는다. */
    commitCompleted() {
        if (!this.fbo || !this.tex) return;
        this.completedTex = this.tex;
        this.erasedThisTick = false;
    }

    dispose() {
        const gl = this.gl;
        if (this.fbo) gl.deleteFramebuffer(this.fbo);
        if (this.tex) gl.deleteTexture(this.tex);
        if (this.depth) gl.deleteRenderbuffer(this.depth);
        if (this.spareFbo) gl.deleteFramebuffer(this.spareFbo);
        if (this.spareTex) gl.deleteTexture(this.spareTex);
        if (this.spareDepth) gl.deleteRenderbuffer(this.spareDepth);
        this.fbo = null;
        this.tex = null;
        this.completedTex = null;
        this.depth = null;
        this.spareFbo = null;
        this.spareTex = null;
        this.spareDepth = null;
    }
}

/**
 * 펜 버퍼를 무대 전체에 깔아 준다(모양보다 **아래**).
 *
 * 엔진은 펜 그림을 **그린 오브젝트 바로 아래**에 끼운다(`Entry.setBasicBrush`가
 * 펜 도형을 그 스프라이트의 자식 번호 자리에 넣는다). 즉 펜 레이어가 하나가
 * 아니라 오브젝트마다 하나다. 여기서는 **펜 전체를 모양 전부보다 아래**로
 * 깐다 — 근사다. 앞 오브젝트의 모양이 뒤 오브젝트의 펜 그림에 덮이는 작품에서만
 * 차이가 보이고, 그 대신 드로우콜 하나로 끝난다.
 *
 * `scaleY: -1`인 이유: 프레임버퍼 텍스처의 첫 줄은 **아래쪽**이라 그냥 얹으면
 * 위아래가 뒤집힌다. 꼭짓점을 뒤집어 맞춘다(UV를 뒤집는 것과 같다).
 */
export function compositePen(pass, penTex, stageWidth = STAGE_WIDTH, stageHeight = STAGE_HEIGHT) {
    if (!penTex) return;
    pass.draw(penTex, {
        x: 0, y: 0, w: stageWidth, h: stageHeight,
        scaleX: 1, scaleY: -1, rotation: 0,
        regX: stageWidth / 2, regY: stageHeight / 2,
        hsv: 0, bright: 0, alpha: 0,
    });
    // 모양과 섞이지 않게 바로 끊는다 — 펜은 **모양보다 아래**라는 순서가 전부다.
    pass.flush();
}

/**
 * VM의 살아 있는 엔티티를 **뒤에서 앞으로** 훑어 스프라이트를 그린다.
 *
 * z순서는 엔트리와 같다: 오브젝트 목록의 **뒤쪽이 뒤**, `objects[0]`이 맨 앞.
 * 복제본은 엔진에서 원본과 같은 자리(원본 바로 뒤)에 끼므로, 한 오브젝트 안에서는
 * 원본 → 복제본 순으로 그린다(= 복제본이 원본보다 앞).
 *
 * @param {SpritePass} pass
 * @param {object} vm EniwanVM
 * @param {TextureCache} cache
 * @param {number[]} [order] 오브젝트 번호의 그리는 순서(뒤→앞). 없으면 목록 역순.
 */
export function drawEntities(pass, vm, cache, order, includeObject = null) {
    const objects = vm.objects || [];
    // VM이 z순서(`맨 앞으로 보내기`)와 **지금 장면**을 들고 있으면 그걸 따른다.
    // 목록 역순은 그걸 모르는 쪽(가짜 vm을 쓰는 테스트)의 기본값이다.
    const seq = order
        || (typeof vm.drawOrder === 'function' ? vm.drawOrder() : defaultOrder(objects.length));
    for (let k = 0; k < seq.length; k += 1) {
        const objectIndex = seq[k];
        const object = objects[objectIndex];
        if (!object || object.objectType === 'textBox') continue;
        if (includeObject && !includeObject(objectIndex, object, vm)) continue;
        for (let e = 0; e < vm.entityCapacity; e += 1) {
            if (!vm.entAlive[e] || vm.entObject[e] !== objectIndex) continue;
            if (!vm.entVisible[e]) continue;
            const picture = object.pictures[vm.entShape[e]];
            if (!picture || !picture.src) continue;
            const tex = cache.get(picture.src);
            if (!tex) { pass.stats.skippedNoTexture += 1; continue; }
            pass.draw(tex, {
                x: vm.entX[e], y: vm.entY[e],
                w: vm.entW[e], h: vm.entH[e],
                scaleX: vm.entScaleX[e], scaleY: vm.entScaleY[e],
                rotation: vm.entRot[e],
                regX: vm.entRegX[e], regY: vm.entRegY[e],
                hsv: vm.entHsv[e], bright: vm.entBright[e], alpha: vm.entAlpha[e],
            });
        }
    }
}

/**
 * Entry 레이어 순서대로 `오브젝트의 펜 → 오브젝트 모양`을 합성한다.
 * `penTextureFor`는 실제로 펜을 쓴 오브젝트에만 텍스처를 돌려주면 된다.
 */
export function drawLayeredScene(pass, vm, cache, penTextureFor, order = null) {
    const seq = order
        || (typeof vm.drawOrder === 'function' ? vm.drawOrder() : defaultOrder(vm.objects?.length || 0));
    const drawnPen = new Set();

    // Entry 작품은 무대 크기의 스프라이트를 배경으로 많이 쓴다. 오브젝트
    // 목록의 z순서가 잘못 저장된 작품에서도 이 그림이 펜 3D 화면을
    // 덮지 않도록 가장 먼저 한 번만 그린다.
    const backdropObjects = new Set();
    for (const objectIndex of seq) {
        const object = vm.objects?.[objectIndex];
        if (!isStageBackdropObject(objectIndex, object, vm)) continue;
        backdropObjects.add(objectIndex);
        drawEntities(pass, vm, cache, [objectIndex]);
    }

    for (const objectIndex of seq) {
        const penTexture = penTextureFor?.(objectIndex);
        if (penTexture) {
            compositePen(pass, penTexture, STAGE_WIDTH, STAGE_HEIGHT);
            drawnPen.add(objectIndex);
        }
        if (!backdropObjects.has(objectIndex)) drawEntities(pass, vm, cache, [objectIndex]);
    }
    if (penTextureFor) {
        const count = Math.max(1, vm?.objects?.length || 1);
        for (let i = 0; i < count; i += 1) {
            if (!drawnPen.has(i)) {
                const penTexture = penTextureFor(i);
                if (penTexture) compositePen(pass, penTexture, STAGE_WIDTH, STAGE_HEIGHT);
            }
        }
    }
}

/**
 * A conventional stage-sized sprite used as a backdrop. Entry projects often
 * keep this as the last object instead of a scene image. Draw it below the pen
 * framebuffer so it cannot hide an entire pen-rendered 3D world.
 */
export function isStageBackdropObject(objectIndex, object, vm) {
    if (!object || !vm) return false;
    for (let e = 0; e < vm.entityCapacity; e += 1) {
        if (!vm.entAlive[e] || vm.entObject[e] !== objectIndex || !vm.entVisible[e]) continue;
        const w = Math.abs(vm.entW[e] * vm.entScaleX[e]);
        const h = Math.abs(vm.entH[e] * vm.entScaleY[e]);
        if (w >= STAGE_WIDTH * 0.96 && h >= STAGE_HEIGHT * 0.96
            && Math.abs(vm.entX[e]) <= STAGE_WIDTH * 0.08
            && Math.abs(vm.entY[e]) <= STAGE_HEIGHT * 0.08) return true;
    }
    return false;
}

/** 목록 역순(= 뒤에서 앞으로). */
export function defaultOrder(count) {
    const out = new Array(count);
    for (let i = 0; i < count; i += 1) out[i] = count - 1 - i;
    return out;
}

/**
 * 점이 네 꼭짓점 사각형 안에 있는가. `spriteQuad`가 채운 배열을 그대로 받는다.
 *
 * 회전·뒤집기 때문에 사각형은 축에 정렬돼 있지 않고, 뒤집으면 꼭짓점 순서가
 * 시계/반시계로 바뀐다. 그래서 외적의 **부호가 네 변에서 같은가**로 본다
 * (한쪽 방향만 보면 뒤집힌 모양이 통째로 안 잡힌다).
 */
export function pointInQuad(quad, x, y) {
    let positive = 0;
    let negative = 0;
    for (let i = 0; i < 4; i += 1) {
        const ax = quad[i * 2];
        const ay = quad[i * 2 + 1];
        const bx = quad[((i + 1) % 4) * 2];
        const by = quad[((i + 1) % 4) * 2 + 1];
        const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        if (cross > 0) positive += 1;
        else if (cross < 0) negative += 1;
    }
    return positive === 0 || negative === 0;
}

/**
 * 무대 좌표 (x, y) **아래에 있는 맨 앞 오브젝트**의 번호. 없으면 -1.
 *
 * 왜 필요한가: 엔트리의 `오브젝트를 클릭했을 때`는 **클릭된 그 오브젝트만**
 * 깨운다. 이걸 모르고 `wake('when_object_click')`을 번호 없이 부르면 작품의
 * 모든 오브젝트의 클릭 블록이 **한 번에 다 터진다.** 전개도 작품에서 아무 데나
 * 한 번 눌러도 같은 면이 계속 접히는 고장이 그거였다(사용자 보고, 2026-10-08).
 *
 * 그리는 순서(`drawOrder`, 뒤→앞)를 **뒤에서부터** 훑어 맨 앞을 먼저 잡는다.
 * 안 보이는 것(`entVisible` 0)은 엔트리와 같이 클릭도 안 받는다.
 *
 * 근사: 모양의 투명 픽셀이 아니라 **회전된 사각형**으로 본다. 엔트리는 픽셀
 * 단위가 아니라 PIXI 경계 상자로 판정하므로 이쪽이 오히려 가깝지만, 여백이 큰
 * 모양에서는 빈 곳을 눌러도 잡힌다.
 *
 * @param {object} vm EniwanVM
 * @param {number} x 무대 좌표(원점 중앙, y가 위)
 * @param {number} y
 * @returns {number} 오브젝트 번호, 없으면 -1
 */
export function pickObjectAt(vm, x, y) {
    const objects = (vm && vm.objects) || [];
    if (!objects.length) return -1;
    const seq = typeof vm.drawOrder === 'function' ? vm.drawOrder() : defaultOrder(objects.length);
    const quad = new Float64Array(8);
    for (let k = seq.length - 1; k >= 0; k -= 1) {
        const objectIndex = seq[k];
        const object = objects[objectIndex];
        if (!object) continue;
        for (let e = 0; e < vm.entityCapacity; e += 1) {
            if (!vm.entAlive[e] || vm.entObject[e] !== objectIndex) continue;
            if (!vm.entVisible[e]) continue;
            let w = vm.entW[e];
            let h = vm.entH[e];
            let regX = vm.entRegX[e];
            let regY = vm.entRegY[e];
            // If it's a textBox or has zero dimension, estimate from text length / defaults
            if (!(w > 0) || !(h > 0)) {
                if (object.objectType === 'textBox' || vm.entTexts?.[e]) {
                    const text = String(vm.entTexts?.[e] || object.start?.text || '');
                    const fontSize = Number(object.start?.fontSize) || 16;
                    w = Math.max(20, (text.length || 1) * (fontSize * 0.65) + 16);
                    h = Math.max(16, fontSize * 1.5 + 8);
                    regX = w / 2;
                    regY = h / 2;
                } else {
                    continue;
                }
            }
      if (object.objectType === 'textBox' || vm.entTexts?.[e]) {
        // 글상자는 이미지의 regX/regY가 아니라 텍스트 정렬 앵커를 쓴다.
        // 실제 JSON은 크기가 있어도 regX/regY가 0인 경우가 흔해, 그대로
        // 쓰면 보이는 글보다 한 박스 아래/오른쪽만 클릭된다.
        const align = Number(object.start?.textAlign) || 0;
        regX = object.start?.lineBreak || align === 0 ? w / 2 : align === 2 ? w : 0;
        regY = h / 2;
      }
            spriteQuad(
                quad, vm.entX[e], vm.entY[e], w, h,
                vm.entScaleX[e], vm.entScaleY[e], vm.entRot[e],
                regX, regY,
            );
            if (pointInQuad(quad, x, y)) return objectIndex;
        }
    }
    return -1;
}

/** 작품 안의 모든 모양 주소 — 미리 받을 목록. */
export function pictureSources(vmOrStage) {
    const objects = (vmOrStage && (vmOrStage.objects || vmOrStage)) || [];
    const out = [];
    for (const object of objects) {
        for (const picture of (object && object.pictures) || []) {
            if (picture && picture.src) out.push(picture.src);
        }
    }
    return out;
}

export default SpritePass;
