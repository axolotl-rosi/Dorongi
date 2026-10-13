/* 이 파일은 public/eniwanvm/runtime.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
/**
 * EniwanVM 4단계 — 브라우저 런타임.
 *
 * 1~3단계(분석기 · PolygonBatcher · VM 코어)를 하나의 루프로 묶는다. 대시보드 UI와는
 * 분리해 뒀다 — UI가 없는 곳(헤드리스 검증)에서도 같은 루프를 돌려야 하기 때문이다.
 *
 * 핵심 설계: **렌더 프레임과 로직 틱은 다른 시계로 돈다.**
 *   - 로직: `vm.advance(now)`가 `logicHz`(60/120/180)에 맞춰 0~n틱을 돌린다.
 *   - 렌더: rAF가 모니터 주사율로 불리고, `renderHz` 상한으로 걸러진다.
 * 그래서 240Hz 모니터에서도 게임 로직은 60Hz로 유지되고, 반대로 로직을 120Hz로
 * 올려도 그릴 때마다 전부 다시 래스터라이즈하지 않는다.
 *
 * 그림은 **두 층**이다:
 *   - 펜(`PenFramebuffer`): "모두 지우기"가 올 때까지 **쌓인다**. 엔트리의 펜이
 *     그렇다 — 매 프레임 지우면 지우지 않는 작품의 선이 1프레임만 번쩍인다.
 *   - 모양(`SpritePass`): 프레임마다 **처음부터 다시** 그린다. 오브젝트가 움직이면
 *     지난 프레임의 그림은 지워져야 한다.
 * 한 버퍼에서 둘을 같이 할 수 없어서(지우면 펜이 날아가고, 안 지우면 모양이
 * 번진다) 펜만 오프스크린 버퍼에 쌓고, 프레임마다 화면을 지운 뒤
 * **펜 → 모양** 순으로 합성한다.
 */

import { analyzeProject, TIER_THRESHOLDS } from './analyzer.js';
import { compileProject } from './compiler.js';
import { EniwanVM, batcherSink } from './vm-core.js';
import { PolygonBatcher, colorFromCss } from './polygon-batcher.js';
import {
    SpritePass, TextureCache, PenFramebuffer, drawLayeredScene, pictureSources,
    pickObjectAt,
} from './sprite-pass.js';
import {
    HOST_CLIPBOARD, HOST_CURSOR, HOST_POINTER_LOCKED, HOST_MOUSE_DOWN, HOST_IS_TESSVM,
} from './isa.js';
import { FeedGrowGame } from './feed-grow/core.js';
import { FeedGrowRenderer } from './feed-grow/renderer.js';
import { ObjPreviewRenderer } from './obj-preview.js';

export const STAGE_WIDTH = 480;
export const STAGE_HEIGHT = 270;

/** 무대 배경색. 어두운 작품(horse-restore의 짙은 네이비)에 맞춰 둔다. */
// Entry's stage is white when a project does not draw its own backdrop.
const CLEAR_COLOR = [1, 1, 1, 1];
/** 무대 외곽 레터박스 배경색 — 어두운 플레이어 배경(#0b1220)과 일치시킨다. */
const LETTERBOX_COLOR = [0.043, 0.07, 0.125, 1.0];

/**
 * 소리 — VM이 말한 것을 실제로 들리게 하는 자리.
 *
 * VM은 오디오를 모른다(`sink.sound(동작, 주소, 크기, 이름, 시작초, 길이초)`만
 * 넘긴다). 주소는 엔트리 서버에 올라간 `/uploads/…`라 **그대로 받아** 쓰면 되고,
 * 같은 소리가 겹쳐 날 수 있으므로 끝난 요소를 **재사용**한다 — 소리마다 새
 * `Audio`를 만들면 총알 소리 한 번에 수백 개가 쌓여 탭이 버벅인다.
 */
class SoundPlayer {
    constructor(origin = '') {
        this.origin = origin;
        this.pool = [];
        this.volume = 1;
        this.masterVolume = 1;
        this.muted = false;
    }

    _url(src) {
        return src && src.startsWith('/uploads/') ? `${this.origin}${src}` : src;
    }

    /** 작품 시작 전에 소리를 내려받고 메타데이터까지 준비한다. */
    async preload(sources) {
        const unique = [...new Set((sources || []).filter(Boolean))];
        let loaded = 0, failed = 0;
        await Promise.all(unique.map((src) => new Promise((resolve) => {
            const url = this._url(src);
            let audio = this.pool.find((a) => a._eniwanSrc === url);
            if (!audio) {
                audio = new Audio();
                audio.preload = 'auto';
                audio._eniwanSrc = url;
                audio.src = url;
                this.pool.push(audio);
            }
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                audio.removeEventListener('canplaythrough', ready);
                audio.removeEventListener('loadedmetadata', ready);
                audio.removeEventListener('error', bad);
                if (ok) loaded += 1; else failed += 1;
                resolve();
            };
            const ready = () => finish(true);
            const bad = () => finish(false);
            const timer = setTimeout(() => finish(audio.readyState >= 1), 10_000);
            if (audio.readyState >= 1) finish(true);
            else {
                audio.addEventListener('canplaythrough', ready, { once: true });
                audio.addEventListener('loadedmetadata', ready, { once: true });
                audio.addEventListener('error', bad, { once: true });
                audio.load();
            }
        })));
        return { loaded, failed };
    }

    /** `sink.sound`와 같은 모양. 동작 0=재생 1=모두멈춤 2=크기 3=이 오브젝트만 */
    handle(action, src, volume, _name, from = 0, dur = 0, _owner = -1, speed = 1) {
        this.volume = Math.max(0, Math.min(100, volume)) / 100;
        if (action === 2) {
            for (const a of this.pool) a.volume = this.muted ? 0 : this.volume * this.masterVolume;
            return;
        }
        if (action === 4) {
            for (const a of this.pool) a.playbackRate = Math.max(0.5, Math.min(2, speed));
            return;
        }
        // 3(이 오브젝트의 소리만)도 지금은 전부 멈춘다. 오브젝트별로 가르려면
        // 재생마다 주인을 적어 둬야 하는데, 그건 소리가 실제로 겹치는 작품을
        // 보고 나서 넓히는 게 맞다 — 지금 반만 맞게 가르면 더 헷갈린다.
        if (action === 1 || action === 3) {
            for (const a of this.pool) { a.pause(); a.currentTime = 0; }
            return;
        }
        if (action !== 0 || !src) return;
        // 도메인은 **엔트리 서버 규칙 경로에만** 붙인다. 로컬 `.ent`의 소리는
        // 호스트가 `/api/ent-asset/…`로 내주므로, 거기에 붙이면 404가 된다.
        const url = this._url(src);
        let audio = this.pool.find((a) => a._eniwanSrc === url && (a.paused || a.ended));
        if (!audio) {
            if (this.pool.length >= 32) return;      // 소리 폭주 상한
            audio = new Audio();
            audio.preload = 'auto';
            audio._eniwanSrc = url;
            this.pool.push(audio);
        }
        if (audio._eniwanSrc !== url) {
            audio._eniwanSrc = url;
            audio.src = url;
        }
        audio.volume = this.muted ? 0 : this.volume * this.masterVolume;
        audio.playbackRate = Math.max(0.5, Math.min(2, speed));
        audio.currentTime = from > 0 ? from : 0;
        if (dur > 0) {
            // `N초 재생`·`A초부터 B초까지`는 길이가 정해져 있다. 자동 재생 정책
            // 때문에 play()는 거부될 수 있으니 실패는 삼킨다(소리는 작품을
            // 멈출 이유가 아니다).
            const stopAt = (from > 0 ? from : 0) + dur;
            const tick = () => {
                if (audio.currentTime >= stopAt) { audio.pause(); audio.removeEventListener('timeupdate', tick); }
            };
            audio.addEventListener('timeupdate', tick);
        }
        const played = audio.play();
        if (played && typeof played.catch === 'function') played.catch(() => {});
    }

    setMuted(muted) {
        this.muted = Boolean(muted);
        for (const audio of this.pool) audio.volume = this.muted ? 0 : this.volume * this.masterVolume;
    }

    setMasterVolume(percent) {
        this.masterVolume = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
        for (const audio of this.pool) audio.volume = this.muted ? 0 : this.volume * this.masterVolume;
    }

    stopAll() {
        for (const a of this.pool) { a.pause(); a.currentTime = 0; }
    }
}

function soundSources(objects) {
    const out = [];
    for (const object of objects || []) {
        for (const sound of (object && object.sounds) || []) {
            if (sound && sound.src) out.push(sound.src);
        }
    }
    return out;
}

/**
 * `ev_cursor`로 받을 수 있는 css `cursor` 키워드 전부.
 *
 * **허용 목록이어야 한다.** 작품이 쓴 글자가 들어가는 자리가 css라서, 목록 없이
 * 그대로 넘기면 `url(…)`로 바깥 주소를 받거나 값 문법을 빠져나갈 여지가 남는다.
 * 목록에 없으면 기본 커서로 되돌린다(조용히 무시하는 쪽이 안전하다).
 */
// CSS Basic User Interface defines these keyword families. Grouping them keeps
// the allow-list easy to audit against the public CSS vocabulary.
const CSS_CURSORS = new Set(`
    auto default none
    context-menu help pointer progress wait
    cell crosshair text vertical-text
    alias copy move no-drop not-allowed grab grabbing
    all-scroll col-resize row-resize
    n-resize e-resize s-resize w-resize
    ne-resize nw-resize se-resize sw-resize
    ew-resize ns-resize nesw-resize nwse-resize
    zoom-in zoom-out
`.trim().split(/\s+/));

export class EniwanRuntime {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{onFrame?:function, onError?:function}} [hooks]
     */
    constructor(canvas, hooks = {}) {
        this.canvas = canvas;
        this.hooks = hooks;
        this.nativeTier = hooks.nativeTier !== false;

        const gl = canvas.getContext('webgl', {
            alpha: false,
            antialias: true,
            // 펜 누적은 이제 오프스크린 버퍼(`PenFramebuffer`)가 맡으므로 화면
            // 버퍼를 보존할 **그림상의** 이유는 없어졌다. 그래도 켜 둔다 —
            // 끄면 브라우저가 합성 뒤 화면 버퍼를 비워서 `toDataURL`·스크린샷·
            // `readPixels`가 **빈 이미지**를 준다. 헤드리스 픽셀 검사가 그대로
            // "밝은 픽셀 0개"로 떨어졌고(실제로 겪었다), 사용자가 무대를
            // 저장하려 해도 빈 그림이 나온다.
            preserveDrawingBuffer: true,
            // 3D 깊이 검사용. 기본값도 true지만 명시해 둔다 — 여기가 false면
            // 깊이 검사를 켜도 GL이 조용히 무시하고 2D처럼 그린다.
            depth: true,
            powerPreference: 'high-performance',
        });
        if (!gl) throw new Error('WebGL 컨텍스트를 만들 수 없다 — 하드웨어 가속이 꺼져 있는지 확인');
        this.gl = gl;

        this.batcher = new PolygonBatcher(gl, {
            stageWidth: STAGE_WIDTH,
            stageHeight: STAGE_HEIGHT,
            maxVertices: 1 << 17,       // 확장이 없으면 생성자가 65,536으로 깎는다
        });
        this.spritePass = new SpritePass(gl, {
            stageWidth: STAGE_WIDTH,
            stageHeight: STAGE_HEIGHT,
        });
        // Entry의 펜은 전역 한 장이 아니라 그린 오브젝트의 표시 순서를 따른다.
        // 오브젝트마다 투명 버퍼를 두어 `맨 앞으로/뒤로 보내기`와 작품의 원래
        // 레이어가 펜에도 그대로 적용되게 한다. 실제로 그리는 오브젝트만 만든다.
        this.penLayers = new Map();
        this._activePenObject = null;

        // VM의 그림 출력을 배처로 보낸다. `clear`만 바꿔 끼운다 — 기본 어댑터는
        // "프레임마다 다시 그린다"는 가정이라 아무것도 하지 않는다.
        // 글상자(`text_write`)는 sink로 오지 않는다 — VM이 `vm.texts`에 바로 쓴다.
        // 그래서 화면 표시는 UI가 `vm.texts`를 읽어서 한다.
        const base = batcherSink(this.batcher, colorFromCss);
        // 모양·소리는 엔트리 서버에 주소만 올라가 있다. 작품 안에서 돌 때는
        // 같은 출처라 그대로 쓰고, 바깥(대시보드)에서는 앞에 도메인을 붙인다.
        this.soundOrigin = hooks.soundOrigin || '';
        this.sounds = new SoundPlayer(this.soundOrigin);
        // 모양 그림도 같은 규칙으로 받는다(`assetSrc`가 `/uploads/…`를 준다).
        this.textures = new TextureCache(gl, { origin: this.soundOrigin });
        this.assetReport = { loaded: 0, failed: 0, missing: [] };
        const penCall = (method) => (...args) => {
            this._selectPenLayer();
            return base[method](...args);
        };
        this.sink = {
            line: penCall('line'),
            fill: penCall('fill'),
            stamp: (x, y, thickness, color, alpha, entity) => {
                this._selectPenLayer();
                const vm = this.vm;
                const objectIndex = entity >= 0 ? vm?.entObject?.[entity] : -1;
                const object = objectIndex >= 0 ? vm?.objects?.[objectIndex] : null;
                const picture = object?.pictures?.[vm?.entShape?.[entity]];
                const tex = picture?.src ? this.textures.get(picture.src) : null;
                if (!tex || !vm) {
                    base.stamp(x, y, thickness, color, alpha);
                    return;
                }
                // Entry's stamp block copies the current costume into the pen
                // layer. It is not a round brush dab. Flush polygon commands,
                // draw the costume into the same FBO, then resume the batch.
                this.batcher.end();
                this.spritePass.begin();
                this.spritePass.draw(tex, {
                    x: vm.entX[entity], y: vm.entY[entity],
                    w: vm.entW[entity], h: vm.entH[entity],
                    scaleX: vm.entScaleX[entity], scaleY: vm.entScaleY[entity],
                    rotation: vm.entRot[entity],
                    regX: vm.entRegX[entity], regY: vm.entRegY[entity],
                    hsv: vm.entHsv[entity], bright: vm.entBright[entity], alpha: vm.entAlpha[entity],
                });
                this.spritePass.end();
                this.batcher.begin();
            },
            text: penCall('text'),
            depth: penCall('depth'),
            depthTest: penCall('depthTest'),
            sound: (action, src, volume, name, from, dur, owner, speed) =>
                this.sounds.handle(action, src, volume, name, from, dur, owner, speed),
            clear: () => {
                // 아직 올리지 않은 것은 버리고, 이미 올라간 픽셀은 그 자리에서 지운다.
                // 다음 프레임으로 미루면 "지우기 → 그리기" 사이의 그림이 한 번 보인다.
                // 지우는 것은 **펜 버퍼만**이다 — 모양은 펜 블록이 건드리지 않는다.
                this.batcher.discard();
                this._clearCurrentPen();
            },
        };

        // 지금 펜 버퍼로 그리는 중인가. `brush_erase_all`은 틱 중에 올 수 있는데,
        // 지우기가 프레임버퍼를 풀어 놓고 끝나면 그 뒤의 펜 그림이 화면으로
        // 새 나가 한 프레임 번쩍인다. 그래서 지운 뒤 다시 걸어 줄지를 여기로 안다.
        this._penBound = false;
        this.viewport = null;       // 무대 비율을 지키는 GL 뷰포트(백킹스토어 픽셀)
        this.viewportCss = null;    // 같은 사각형의 CSS 픽셀판 — 마우스 변환용
        this.program = null;
        this.vm = null;
        this.nativeGame = null;
        this.nativeRenderer = null;
        this.objPreview = null;
        this.nativeKeys = new Uint8Array(256);
        this.gameLastNow = 0;
        this.analysis = null;
        this.compileMs = 0;
        this.filename = '';
        this.tessCompatibilityMode = 'auto';
        this.tessScrollPending = false;

        this.running = false;
        this.renderHz = 60;             // 0 = 제한 없음(Max)
        this.logicHz = 60;
        this.turbo = 1;
        this.computeLevel = 3;
        this.catchUpTicks = 4;
        this.stepBudget = 500_000;
        this.frameWorkMs = 7;

        // mouseX/Y는 "커서가 무대 어디에 있나"(절대), deltaX/Y·wheel은
        // "지난 프레임 이후 얼마나 움직였나"(상대 누적)다. 1인칭 시점은
        // 후자만 쓴다 — 전자는 포인터 락 중에 아예 갱신되지 않는다.
        this.input = {
            mouseX: 0, mouseY: 0, mouseDown: false,
            deltaX: 0, deltaY: 0, wheel: 0, wheelX: 0, locked: false,
        };
        // 짧은 클릭은 pointerdown과 pointerup이 다음 VM 틱 전에 모두 올 수 있다.
        // 대형 작품에서는 한 틱이 100ms를 넘기도 하므로, 한 틱이 실제 눌림을
        // 관찰할 때까지 pulse를 보존한다.
        this.pendingMousePress = false;
        this.pendingMouseRelease = false;
        this.pointerEdgeQueue = [];
        this.pointerDeliveredDown = false;
        this.lastClickedObject = -1;
        this.startedAt = 0;
        this.rafId = 0;
        this.interactionTimer = 0;
        this.interactionUntil = 0;
        this.lastInteractiveAt = 0;
        this._inFrame = false;
        this.lastRenderAt = 0;
        this.lastDrawAt = 0;
        this.minDrawGapMs = 0;
        this.lastSampleAt = 0;
        this.framesDrawn = 0;
        this.rafCalls = 0;
        this.ticksRun = 0;
        this.lastError = null;
        this.frameVertices = 0;
        this.frameTriangles = 0;
        this.frameDrawCalls = 0;

        this.metrics = {
            fps: 0, rafHz: 0, tickHz: 0, frameMs: 0, logicMs: 0, renderMs: 0,
            vertices: 0, triangles: 0, drawCalls: 0, stepsPerTick: 0,
            liveThreads: 0, overruns: 0,
        };
    }

    /** project.json을 분석 → 컴파일 → VM 생성. 실행은 start()에서. */
    async load(project, filename = '') {
        this.stop();
        for (const layer of this.penLayers.values()) layer.dispose();
        this.penLayers.clear();
        this._activePenObject = null;
        this._penBound = false;
        this.filename = filename;
        this.analysis = analyzeProject(project);

        const t0 = performance.now();
        this.program = compileProject(project);
        this.textures.collectAlphaMasks = Boolean(this.program.usesTouching);
        this.compileMs = performance.now() - t0;
        if (this.objPreview) this.objPreview.dispose();
        this.objPreview = ObjPreviewRenderer.supports(this.program)
            ? new ObjPreviewRenderer(this.gl, this.program) : null;

        this.vm = new EniwanVM(this.program, {
            sink: this.sink,
            logicHz: this.logicHz,
            maxStepsPerTick: this.stepBudget,
            // Data-oriented renderers often use recursion as iteration.  The
            // old depth of 64 silently truncated Apple 3D and the fireworks
            // lists. Clone-heavy projects keep a smaller bound because every
            // clone needs its own register window.
            // 복제본을 선언했다는 이유만으로 128까지 낮추면, 실제 복제본은
            // 만들지 않으면서 정점 123개를 재귀 순회하는 68ac...가 호출 사슬
            // 여유분을 넘겨 투영 배열을 완성하지 못한다. 512는 그 작품의
            // 재귀를 수용하면서도 clone-heavy 행의 레지스터 창을 유한하게 둔다.
            maxCallDepth: this.program.usesClones ? 512 : 2048,
            nativeTier: this.nativeTier,
        });
        this.vm.tickMultiplier = this.turbo;
        if (project && project.eniwanGame && project.eniwanGame.type === 'feed-grow-fish') {
            if (this.nativeRenderer) this.nativeRenderer.dispose();
            let GameClass = FeedGrowGame;
            let RendererClass = FeedGrowRenderer;
            this.nativeBundleOrigin = 'installed-module';
            const bundle = project.eniwanGame.bundle;
            if (bundle?.format === 'eniwan-esm-v1' && bundle.moduleSource) {
                const bytes = new TextEncoder().encode(bundle.moduleSource);
                if (bundle.sha256 && globalThis.crypto?.subtle) {
                    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
                    const actual = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
                    if (actual !== bundle.sha256) throw new Error(`EniwanGame bundle checksum mismatch: ${actual}`);
                }
                const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
                try {
                    const embedded = await import(url);
                    if (typeof embedded.FeedGrowGame !== 'function' || typeof embedded.FeedGrowRenderer !== 'function') {
                        throw new Error('EniwanGame bundle does not export FeedGrowGame/FeedGrowRenderer');
                    }
                    GameClass = embedded.FeedGrowGame;
                    RendererClass = embedded.FeedGrowRenderer;
                    this.nativeBundleOrigin = 'embedded-ent';
                } finally {
                    URL.revokeObjectURL(url);
                }
            }
            this.nativeGame = new GameClass(project.eniwanGame.options || {});
            this.nativeRenderer = new RendererClass(this.gl);
            // Dashboard text/HUD stays compatible with the existing Entry text bridge.
            this.vm.texts = this.nativeRenderer.hud(this.nativeGame);
        } else {
            if (this.nativeRenderer) this.nativeRenderer.dispose();
            this.nativeGame = null;
            this.nativeRenderer = null;
            this.nativeBundleOrigin = null;
        }
        this.lastError = null;
        this._resizeBackingStore();
        this._clearFramebuffer();
        // 모양 그림은 **미리** 받는다. 블록이 모양을 바꾸는 순간에 받기 시작하면
        // 그 프레임은 빈 자리로 지나가고, 1초짜리 연출은 절반이 날아간다.
        // 실패해도 작품은 돌린다 — 못 받은 주소는 보고에 남는다(조용한 빈 화면 금지).
        const srcs = pictureSources(this.vm.objects);
        const soundSrcs = soundSources(this.vm.objects);
        const [result, soundResult] = await Promise.all([
            this.textures.preload(srcs),
            this.sounds.preload(soundSrcs),
        ]);
        this.assetReport = {
            loaded: result.loaded + soundResult.loaded,
            failed: result.failed + soundResult.failed,
            missing: Array.from(this.textures.failed.keys()),
            images: result,
            sounds: soundResult,
        };
        this.vm.spriteAlphaHitTest = (entity, stageX, stageY) => {
            const object = this.vm.objects[this.vm.entObject[entity]];
            const picture = object?.pictures?.[this.vm.entShape[entity]];
            if (!picture?.src) return true;
            const scaleX = this.vm.entScaleX[entity];
            const scaleY = this.vm.entScaleY[entity];
            if (scaleX === 0 || scaleY === 0) return false;
            const rad = this.vm.entRot[entity] * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const dx = stageX - this.vm.entX[entity];
            const dy = stageY - this.vm.entY[entity];
            // Inverse of spriteQuad's PIXI-y-down rotation.
            const localX = cos * dx - sin * dy;
            const localY = -sin * dx - cos * dy;
            const pixelX = localX / scaleX + this.vm.entRegX[entity];
            const pixelY = localY / scaleY + this.vm.entRegY[entity];
            return this.textures.hitAlpha(picture.src, pixelX, pixelY);
        };
        return {
            analysis: this.analysis,
            program: this.program,
            compileMs: this.compileMs,
            assets: this.assetReport,
        };
    }

    start() {
        if (!this.vm || this.running) return;
        this.running = true;
        this.startedAt = performance.now();
        // 멈춰 있던 동안의 시간이 한꺼번에 밀려 들어오지 않게 시계를 끊는다.
        this.vm.lastNowMs = -1;
        this.gameLastNow = performance.now();
        this.lastSampleAt = performance.now();
        this._initialSampleDone = false;
        this.framesDrawn = 0;
        this.rafCalls = 0;
        this.ticksRun = 0;
        this.rafId = requestAnimationFrame(this._loop);
    }

    pause() {
        this.running = false;
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = 0;
        if (this.interactionTimer) clearTimeout(this.interactionTimer);
        this.interactionTimer = 0;
        this.interactionUntil = 0;
    }

    stop() {
        this.pause();
        this.pendingMousePress = false;
        this.pendingMouseRelease = false;
        this.pointerEdgeQueue.length = 0;
        this.pointerDeliveredDown = false;
        this.input.mouseDown = false;
        // 멈췄는데 소리가 계속 나면 "안 멈췄다"로 보인다.
        this.sounds.stopAll();
        if (this.vm) {
            this.vm.reset();
            this._clearFramebuffer();
        }
        if (this.nativeGame) this.nativeGame.reset();
        this.lastDrawAt = 0;
        // 멈춘 작품이 커서를 가져간 채로 두면 사용자는 페이지가 멈춘 줄 안다.
        this._applyCursor('');
        if (this.isPointerLocked()) this.exitPointerLock();
    }

    /** 처음부터 다시 — 변수·리스트 초기값까지 되돌린다. */
    restart() {
        if (!this.vm) return;
        const wasRunning = this.running;
        this.pause();
        this.pendingMousePress = false;
        this.pendingMouseRelease = false;
        this.pointerEdgeQueue.length = 0;
        this.pointerDeliveredDown = false;
        this.input.mouseDown = false;
        this.lastDrawAt = 0;
        this.vm.reset();
        if (this.nativeGame) this.nativeGame.reset();
        this.batcher.resetStats();
        this._clearFramebuffer();
        if (wasRunning) this.start();
    }

    setLogicHz(hz) {
        this.logicHz = hz;
        if (this.vm) this.vm.logicHz = hz;
    }

    setTurbo(multiplier) {
        this.turbo = Math.max(1, Math.min(16, Number(multiplier) || 1));
        if (this.vm) this.vm.tickMultiplier = this.turbo;
    }

    setEnvironment({ boostMode = false, deviceType = 'desktop', touchSupported = false } = {}) {
        if (!this.vm) return;
        this.vm.host[18] = boostMode ? 1 : 0;
        this.vm.host[19] = deviceType === 'tablet' ? 1 : deviceType === 'mobile' ? 2 : 0;
        this.vm.host[20] = touchSupported ? 1 : 0;
    }

    setComputeLevel(level) {
        // A larger level gives a renderer more work per frame, but must not
        // monopolize the browser for tens of millions of dispatches.
        // Five useful bands are easier to choose than eight nearly identical
        // ones. Level 3 is the default; 4 and 5 are for unusually large
        // recursive/3D projects. Wall-clock budgets keep input and paint alive.
        const budgets = [80_000, 200_000, 500_000, 1_500_000, 4_000_000];
        const catches = [4, 8, 12, 20, 28];
        const workMs = [2.5, 4, 7, 12, 18];
        const i = Math.max(0, Math.min(budgets.length - 1, Math.round(Number(level) || 1) - 1));
        this.computeLevel = i + 1;
        this.stepBudget = budgets[i];
        this.catchUpTicks = catches[i];
        this.frameWorkMs = workMs[i];
        // 저연산 모드(1~2단계)에서는 초당 16~8회 수준(8fps~12fps)으로 렌더 주기를
        // 조율해 GPU/합성 부하를 덜고 연산에 시간을 집중하면서도 부드럽게 이어지도록 한다.
        // 3단계 이상은 제한 없이 즉각 제출(0)한다.
    // 합성은 실작품에서 0.1~0.2ms였다. 계산이 끝난 가벼운 작품까지
    // 낮은 단계에서 8~22fps로 제한하지 않고 완성 화면은 rAF마다 낸다.
        // Compute tiers control VM work, not visual smoothness. A slideshow or
        // light sprite animation at tier 1 must still paint at display cadence.
        // Explicit render-rate preferences remain available through renderHz.
        this.minDrawGapMs = 0;
        // 화면 제출은 디스플레이의 표준 rAF에 맡긴다. 연산 프리셋이 화질이나
        // 표시 주사율을 몰래 낮추지 않는다.
        this.renderHz = 0;
        if (this.vm) this.vm.maxStepsPerTick = this.stepBudget;
    }

    setRenderHz(hz) { this.renderHz = hz; }

    setMuted(muted) { this.sounds.setMuted(muted); }

    setVolume(percent) { this.sounds.setMasterVolume(percent); }

    setTessCompatibility(mode = 'auto') {
        this.tessCompatibilityMode = ['auto', 'on', 'off'].includes(mode) ? mode : 'auto';
        if (!this.vm) return;
        const enabled = this.tessCompatibilityMode === 'on'
            || (this.tessCompatibilityMode === 'auto' && this.program?.usesTessVM === true);
        this.vm.tessCompatibility = enabled;
        this.vm.host[HOST_IS_TESSVM] = enabled ? 1 : 0;
    }

    setKey(code, down) {
        if (code >= 0 && code < this.nativeKeys.length) this.nativeKeys[code] = down ? 1 : 0;
        if (this.vm) this.vm.setKey(code, down);
    }

    clearKeys() {
        this.nativeKeys.fill(0);
        if (this.vm) this.vm.keys.fill(0);
    }

    // ── 상대 마우스 입력 (1인칭 시점) ─────────────────────────────────────
    // DOM 이벤트 등록은 대시보드 쪽이 한다(런타임은 헤드리스에서도 돌아야
    // 하므로 window를 건드리지 않는다). 런타임은 **누적만** 책임진다.

    /** 포인터 락 중의 raw 이동량. `movementX/Y`를 그대로 넘기면 된다. */
    pushMouseDelta(dx, dy) {
        const x = Number(dx), y = Number(dy);
        // NaN이 한 번 들어가면 누적값이 영구히 NaN이 되고 시점이 사라진다.
        if (Number.isFinite(x)) this.input.deltaX += x;
        if (Number.isFinite(y)) this.input.deltaY += y;
    }

    /** 휠 누적량. `deltaY`/`deltaX`를 그대로 넘긴다(위로 굴리면 음수). */
    pushWheel(delta, deltaX = 0) {
        const d = Number(delta);
        const tess = this.vm?.tessCompatibility === true;
        if (Number.isFinite(d)) this.input.wheel += tess ? -d / 100 : d;
        const dx = Number(deltaX);
        if (Number.isFinite(dx)) this.input.wheelX += tess ? dx / 100 : dx;
        if (tess && ((Number.isFinite(d) && d !== 0) || (Number.isFinite(dx) && dx !== 0))) {
            this.tessScrollPending = true;
        }
    }

    // ── 브라우저 쪽 확장 (클립보드·커서·포인터 락) ────────────────────────
    //
    // 전부 **작품이 그 이름을 실제로 쓸 때만** 연다(`program.uses*`). 쓰지도 않는
    // 작품의 붙여넣기를 가로채거나 커서를 바꾸면 페이지의 다른 일이 망가진다.

    /**
     * 사용자가 붙여넣은 글을 작품에 넣는다. 호스트가 `paste` 이벤트에서 부른다.
     *
     * 작품이 쓴 것으로 세지 않는다 — 넣은 값을 작품이 다시 복사해 달라고 요청한
     * 것으로 오해하면, 붙여넣기 한 번이 클립보드 쓰기로 되돌아가는 되돌이표가 된다.
     */
    pasteText(text) {
        if (!this.vm || !this.program || !this.program.usesClipboard) return false;
        this.vm.setHostText(HOST_CLIPBOARD, text);
        return true;
    }

    /**
     * 작품이 요청한 일을 실제로 한다. 매 프레임 틱 뒤에 한 번 불린다.
     *
     * 왜 VM 안에서 바로 하지 않는가: VM은 브라우저를 모르고, 알면 헤드리스
     * 검증에서 돌지 않는다. 그리고 한 틱에 같은 요청이 백 번 나와도 여기서는
     * 한 번만 하게 된다(블록 하나가 반복 안에 있으면 흔한 일이다).
     */
    applyHostWrites() {
        if (!this.vm) return;
        const writes = this.vm.takeHostWrites();
        if (!writes) return;
        for (const action of writes) {
            if (action === 'cursor') this._applyCursor(this.vm.hostStr[HOST_CURSOR]);
            else if (action === 'clipboard') this._applyClipboard(this.vm.hostStr[HOST_CLIPBOARD]);
            else if (action === 'mouseLock') this._applyPointerLock(this.vm.host[HOST_POINTER_LOCKED] !== 0);
            else if (action === 'ask' && this.hooks.onAsk) this.hooks.onAsk(this.vm.pendingQuestion());
        }
    }

    answer(text) {
        if (!this.vm) return 0;
        const woken = this.vm.answer(text);
        const next = this.vm.pendingQuestion();
        if (next && this.hooks.onAsk) this.hooks.onAsk(next);
        return woken;
    }

    /**
     * 무대 커서 모양. **키워드 목록에 있는 것만** 쓴다.
     *
     * 작품이 쓴 글자를 `style.cursor`에 그대로 넘기면 거기부터 css다 —
     * `url(...)`로 바깥 주소를 불러오거나, 값 문법을 빠져나가 다른 속성을 건드릴
     * 여지가 생긴다. 목록에 없는 값은 "커서를 되돌려라"로 읽는다.
     */
    _applyCursor(value) {
        if (!this.canvas) return;
        const keyword = String(value ?? '').trim().toLowerCase();
        this.canvas.style.cursor = CSS_CURSORS.has(keyword) ? keyword : '';
    }

    /** 클립보드 쓰기. 브라우저가 거절하는 쪽이 보통이라(제스처 필요) 조용히 넘긴다. */
    _applyClipboard(text) {
        if (!this.program || !this.program.usesClipboard) return;
        const nav = typeof navigator === 'undefined' ? null : navigator;
        if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') return;
        try {
            const r = nav.clipboard.writeText(String(text ?? ''));
            if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch { /* 권한도 제스처도 우리가 만들 수 없다 */ }
    }

    /** 작품이 포인터 락을 요청/해제. 잠그는 쪽은 제스처 안에서만 통한다. */
    _applyPointerLock(wanted) {
        if (wanted) {
            if (!this.isPointerLocked()) this.requestPointerLock();
        } else if (this.isPointerLocked()) {
            this.exitPointerLock();
        }
    }

    /**
     * 포인터 락 상태를 알린다. 풀릴 때 **남은 델타를 버린다** — 락이 풀리는
     * 순간의 커서 점프가 델타로 들어와 시점이 확 돌아가는 것을 막는다.
     */
    setPointerLocked(locked) {
        this.input.locked = Boolean(locked);
        if (!this.input.locked) {
            this.input.deltaX = 0;
            this.input.deltaY = 0;
        }
    }

    /** 캔버스에 포인터 락 요청. 사용자 제스처(클릭) 안에서만 통한다. */
    requestPointerLock() {
        const el = this.canvas;
        if (!el || typeof el.requestPointerLock !== 'function') return false;
        // 크롬은 Promise를 돌려주고 거부 시 reject한다. 잡지 않으면
        // unhandled rejection이 콘솔을 채우고 다른 에러를 덮는다.
        try {
            const r = el.requestPointerLock();
            if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch {
            return false;
        }
        return true;
    }

    exitPointerLock() {
        const doc = this.canvas && this.canvas.ownerDocument;
        if (doc && typeof doc.exitPointerLock === 'function') doc.exitPointerLock();
        this.setPointerLocked(false);
    }

    /** 지금 이 캔버스가 포인터 락을 쥐고 있는가(DOM 기준 사실 확인). */
    isPointerLocked() {
        const doc = this.canvas && this.canvas.ownerDocument;
        return Boolean(doc && doc.pointerLockElement === this.canvas);
    }

    /** 캔버스 좌표(CSS 픽셀)를 엔트리 무대 좌표로. 원점 중앙, y가 위. */
    pointerToStage(clientX, clientY) {
        const r = this.canvas.getBoundingClientRect();
        const vp = this.viewport;
        // Entry 페이지가 플레이어를 다른 컨테이너로 옮기거나 전체화면을 전환하는
        // 찰나에는 표시 중인 캔버스도 한 layout 동안 0x0으로 보고될 수 있다.
        // 그 순간 들어온 pointerdown을 원점으로 바꾸면 작품은 실제 클릭 위치 대신
        // (0,0)에서 드래그를 시작한다. 좌표를 새로 계산할 수 없을 때는 마지막으로
        // 확인한 정상 좌표를 유지한다.
        if (!(r.width > 0) || !(r.height > 0)) {
            return {
                x: Number.isFinite(this.input?.mouseX) ? this.input.mouseX : 0,
                y: Number.isFinite(this.input?.mouseY) ? this.input.mouseY : 0,
            };
        }
        // client 좌표는 getBoundingClientRect의 실제 표시 픽셀이고 viewport는 WebGL
        // 백킹스토어 픽셀이다. 비율로 바꾸면 DPR뿐 아니라 CSS zoom/transform과
        // 전체화면 확대까지 같은 식으로 맞는다.
        // 첫 rAF 전에는 backing store와 viewport가 아직 준비되지 않는다. 그때 (0,0)을
        // 돌려주면 시작 직후의 첫 입력이 실제 위치와 무관하게 원점으로 굳는다. 표시
        // 사각형만으로 같은 16:9 viewport를 계산해 두 경로가 같은 좌표를 내게 한다.
        let cssVp;
        if (vp?.w && vp?.h && this.canvas.width && this.canvas.height) {
            cssVp = {
                x: vp.x * r.width / this.canvas.width,
                y: vp.y * r.height / this.canvas.height,
                w: vp.w * r.width / this.canvas.width,
                h: vp.h * r.height / this.canvas.height,
            };
        } else {
            const scale = Math.min(r.width / STAGE_WIDTH, r.height / STAGE_HEIGHT);
            const w = STAGE_WIDTH * scale;
            const h = STAGE_HEIGHT * scale;
            cssVp = { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
        }
        // 레터박스 띠를 빼고 무대 사각형 기준으로 환산한다.
        const point = {
            x: ((clientX - r.left - cssVp.x) / cssVp.w) * STAGE_WIDTH - STAGE_WIDTH / 2,
            y: STAGE_HEIGHT / 2 - ((clientY - r.top - cssVp.y) / cssVp.h) * STAGE_HEIGHT,
        };
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            return {
                x: Number.isFinite(this.input?.mouseX) ? this.input.mouseX : 0,
                y: Number.isFinite(this.input?.mouseY) ? this.input.mouseY : 0,
            };
        }
        return point;
    }

    /** 엔트리 무대 좌표(원점 중앙, y가 위)를 캔버스 기준 CSS 픽셀(좌상단 원점)로 변환. */
    stageToCss(stageX, stageY) {
        const r = this.canvas.getBoundingClientRect();
        const vp = this.viewport;
        let cssVp;
        if (vp?.w && vp?.h && this.canvas.width && this.canvas.height) {
            cssVp = {
                x: vp.x * r.width / this.canvas.width,
                y: vp.y * r.height / this.canvas.height,
                w: vp.w * r.width / this.canvas.width,
                h: vp.h * r.height / this.canvas.height,
            };
        } else {
            const scale = Math.min(r.width / STAGE_WIDTH, r.height / STAGE_HEIGHT);
            const w = STAGE_WIDTH * scale;
            const h = STAGE_HEIGHT * scale;
            cssVp = { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
        }
        return {
            x: cssVp.x + ((stageX + STAGE_WIDTH / 2) / STAGE_WIDTH) * cssVp.w,
            y: cssVp.y + ((STAGE_HEIGHT / 2 - stageY) / STAGE_HEIGHT) * cssVp.h,
            scale: cssVp.w / STAGE_WIDTH,
        };
    }

    /** 절대 포인터 위치를 런타임과 VM에 같은 이벤트 안에서 반영한다. */
    setPointerPosition(clientX, clientY) {
        const p = this.pointerToStage(clientX, clientY);
        this.input.mouseX = p.x;
        this.input.mouseY = p.y;
        this.objPreview?.setPointer(p.x, p.y, this.input.mouseDown);
        // rAF까지 기다리면 클릭 hat처럼 이벤트에서 바로 깨어난 스레드가 이전 좌표
        // (첫 입력이면 0,0)를 읽는다. VM이 있을 때는 host 슬롯도 즉시 맞춘다.
        this.vm?.setHost({ mouseX: p.x, mouseY: p.y });
        return p;
    }

    /** 버튼 눌림을 DOM 이벤트와 같은 순간 VM에 반영한다. */
    setPointerDown(down) {
        const value = Boolean(down);
        if (!Array.isArray(this.pointerEdgeQueue)) this.pointerEdgeQueue = [];
        if (typeof this.pointerDeliveredDown !== 'boolean') this.pointerDeliveredDown = false;
        if (this.input.mouseDown === value) return;
        this.input.mouseDown = value;
        this.objPreview?.setPointer(this.input.mouseX, this.input.mouseY, value);
        const tail = this.pointerEdgeQueue.length
            ? this.pointerEdgeQueue[this.pointerEdgeQueue.length - 1]
            : this.pointerDeliveredDown;
        if (tail !== value) this.pointerEdgeQueue.push(value);
        // A quick down/up between two rAF callbacks must still be presented as
        // two logical frames.  Keep these compatibility fields for diagnostics.
        this.pendingMousePress = this.pointerEdgeQueue.includes(true);
        this.pendingMouseRelease = this.pointerEdgeQueue.includes(false);
        this.vm?.setHost({
            mouseDown: this.pointerEdgeQueue.length
                ? this.pointerEdgeQueue[0]
                : this.input.mouseDown,
        });
    }

    /** 현재 프레임에 VM이 볼 버튼 상태. */
    _pointerDownForTick() {
        return this.pointerEdgeQueue?.length
            ? this.pointerEdgeQueue[0]
            : this.input.mouseDown;
    }

    /** VM 틱이 실제로 돌았을 때만 보존한 짧은 클릭을 소비한다. */
    _finishPointerTick(ticks, mouseDownReads = 0) {
        if (!(ticks > 0) && !(mouseDownReads > 0)) return;
        if (!Array.isArray(this.pointerEdgeQueue)) this.pointerEdgeQueue = [];
        // A budget-sliced logical tick may already have read is_clicked even
        // though it has not reached its final yield yet. Consume the presented
        // edge at that read point so release can reach the next reporter read.
        const observed = mouseDownReads > 0 ? 1 : 0;
        const consumed = Math.min(Math.max(Math.floor(ticks), observed), this.pointerEdgeQueue.length);
        for (let index = 0; index < consumed; index += 1) {
            this.pointerDeliveredDown = this.pointerEdgeQueue.shift();
        }
        this.pendingMousePress = this.pointerEdgeQueue.includes(true);
        this.pendingMouseRelease = this.pointerEdgeQueue.includes(false);
        this.vm?.setHost({
            mouseDown: this.pointerEdgeQueue.length
                ? this.pointerEdgeQueue[0]
                : this.input.mouseDown,
        });
    }

    /** 호스트 이벤트 → VM 스레드 깨우기. 어떤 이벤트가 붙었는지는 호출자가 안다. */
    wake(event, objectIndex = -1, arg = -1) {
        return this.vm ? this.vm.wake(event, objectIndex, arg) : 0;
    }

    /**
     * Input must remain responsive even when the host page throttles rAF. A
     * short, event-driven pulse keeps drag/click scripts moving without keeping
     * an inactive project alive forever in the background.
     */
    requestInputFrame(durationMs = 360) {
        if (!this.running) return;
        const now = performance.now();
        this.interactionUntil = Math.max(this.interactionUntil, now + durationMs);
        if (!this._inFrame && now - this.lastInteractiveAt >= 8) {
            this.lastInteractiveAt = now;
            this._runFrame(now, true);
        }
        if (this.interactionTimer) return;
        const pulse = () => {
            this.interactionTimer = 0;
            if (!this.running || performance.now() >= this.interactionUntil) return;
            const t = performance.now();
            if (!this._inFrame && t - this.lastInteractiveAt >= 12) {
                this.lastInteractiveAt = t;
                this._runFrame(t, true);
            }
            this.interactionTimer = setTimeout(pulse, 16);
        };
        this.interactionTimer = setTimeout(pulse, 0);
    }

    /**
     * 클릭을 **눌린 오브젝트에게만** 전달한다. 무대(배경)를 눌렀으면 아무것도
     * 깨우지 않는다 — 엔트리가 그렇다.
     *
     * 입구를 하나로 두는 이유: 대시보드와 확장이 각자 `wake('when_object_click')`을
     * 부르고 있었고, 둘 다 번호를 안 넘겨서 **모든 오브젝트의 클릭 블록이 한 번에
     * 터졌다.** 같은 고장을 두 곳에서 따로 고치면 한쪽이 다시 어긋난다.
     *
     * @returns {number} 깨운 스레드 수
     */
    clickAt(stageX, stageY) {
        if (!this.vm) return 0;
        // 클릭 hat이 깨어나는 바로 그 순간 reporter도 같은 좌표를 보게 한다.
        // 다음 rAF까지 미루면 고속 VM에서 이전 프레임 좌표로 분기할 수 있다.
        this.input.mouseX = stageX;
        this.input.mouseY = stageY;
        this.input.mouseDown = true;
        this.vm.setHost({ mouseX: stageX, mouseY: stageY, mouseDown: true });
        const objectIndex = pickObjectAt(this.vm, stageX, stageY);
        this.lastClickedObject = objectIndex;
        if (objectIndex < 0) return 0;
        return this.vm.wake('when_object_click', objectIndex);
    }

    releaseObjectClick() {
        const objectIndex = this.lastClickedObject;
        this.lastClickedObject = -1;
        return objectIndex >= 0 && this.vm
            ? this.vm.wake('when_object_click_canceled', objectIndex) : 0;
    }

    _clearCanvas() {
        const gl = this.gl;
        // 지우기는 레터박스 띠까지 포함해 **버퍼 전체**를 덮되, 레터박스는 어두운 색으로 채우고
        // 무대(16:9) 영역만 CLEAR_COLOR로 클리어한다.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(...LETTERBOX_COLOR);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const vp = this.viewport;
        if (vp) {
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(vp.x, vp.y, vp.w, vp.h);
            gl.clearColor(...CLEAR_COLOR);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.disable(gl.SCISSOR_TEST);
        }
        this._applyViewport();
    }

    _clearFramebuffer() {
        this._clearCanvas();
        // 화면만 지우고 펜 버퍼를 남기면 다음 프레임 합성에서 그대로 되돌아온다.
        // "지우기"라는 이름이 거짓이 되지 않게 둘 다 지운다.
        this._clearAllPen();
    }

    /**
     * 펜 버퍼를 무대 사각형 크기로 맞춘다(레터박스 띠 제외). 그래야 합성할 때
     * 텍스처가 무대에 1:1로 얹혀서 어긋남을 계산할 일이 없다.
     *
     * **매 프레임 부른다.** `_resizeBackingStore()`는 캔버스 크기가 그대로면
     * 아무것도 하지 않고 돌아가는데, 거기에만 기대면 캔버스가 처음부터 맞는
     * 크기인 경우 펜 버퍼가 **한 번도 만들어지지 않는다** — 그러면 `bind()`가
     * 0×0 뷰포트로 그리게 되어 화면에 아무것도 안 나온다. 실제로 그렇게 돼서
     * 대시보드 픽셀 검사가 "밝은 픽셀 0개"로 걸렸다. 같은 크기면 공짜다.
     *
     * 크기가 바뀌면 버퍼를 다시 만들므로 쌓인 펜 그림은 사라진다 — 창 크기를
     * 바꾸는 중에 선이 지워지는 셈인데, 늘린 버퍼로 옛 픽셀을 늘려 붙이면
     * 번진 그림이 영구히 남는다.
     */
    _penSize() {
        const vp = this.viewport;
        const w = vp ? vp.w : this.canvas.width;
        const h = vp ? vp.h : this.canvas.height;
        return { w, h };
    }

    /** 이미 만들어진 오브젝트별 펜 버퍼의 크기를 무대에 맞춘다. */
    _ensurePen() {
        const { w, h } = this._penSize();
        let changed = false;
        for (const layer of this.penLayers.values()) changed = layer.resize(w, h) || changed;
        return changed;
    }

    _penObject() {
        const vm = this.vm;
        const entity = vm?.curEntity ?? -1;
        if (entity >= 0 && entity < (vm?.entityCapacity ?? 0)) return vm.entObject[entity];
        return 0;
    }

    _penLayer(objectIndex, create = false) {
        let layer = this.penLayers.get(objectIndex);
        if (!layer && create) {
            layer = new PenFramebuffer(this.gl);
            const { w, h } = this._penSize();
            layer.resize(w, h);
            layer.clear();
            this.penLayers.set(objectIndex, layer);
        }
        return layer;
    }

    /** 현재 VM 명령의 소유 오브젝트 버퍼로 배처를 옮긴다. */
    _selectPenLayer() {
        const objectIndex = this._penObject();
        if (this._penBound && this._activePenObject === objectIndex) return;
        if (this._penBound) {
            this.batcher.end();
            this._penLayer(this._activePenObject)?.unbind();
        }
        const layer = this._penLayer(objectIndex, true);
        layer.bind();
        this.batcher.begin();
        this._activePenObject = objectIndex;
        this._penBound = true;
    }

    _finishPenLayer() {
        if (!this._penBound) return;
        this.batcher.end();
        this._penLayer(this._activePenObject)?.unbind();
        this._penBound = false;
        this._activePenObject = null;
    }

    /** 모든 오브젝트의 펜만 지운다. 루프 중이면 같은 소유자 버퍼에서 계속한다. */
    _clearCurrentPen() {
        const objectIndex = this._penObject();
        const wasBound = this._penBound;
        const active = this._activePenObject;
        if (wasBound) {
            this.batcher.discard();
            this._penLayer(active)?.unbind();
            this._penBound = false;
        }
        this._penLayer(objectIndex, true).clear();
        this._activePenObject = null;
        if (wasBound) {
            const layer = this._penLayer(active, true);
            layer.bind();
            this.batcher.begin();
            this._activePenObject = active;
            this._penBound = true;
        } else this._applyViewport();
    }

    _clearAllPen() {
        const resume = this._penBound ? this._activePenObject : null;
        if (this._penBound) {
            // 아직 GPU에 올라가지 않은 도형도 `모두 지우기` 대상이다.
            this.batcher.discard();
            this._penLayer(this._activePenObject)?.unbind();
            this._penBound = false;
        }
        for (const layer of this.penLayers.values()) layer.clear();
        this._activePenObject = null;
        if (resume !== null) {
            const layer = this._penLayer(resume, true);
            layer.bind();
            this.batcher.begin();
            this._activePenObject = resume;
            this._penBound = true;
        } else this._applyViewport();
    }

    /** 무대 비율(16:9)을 지키는 가운데 정렬 뷰포트. */
    _applyViewport() {
        const vp = this.viewport;
        if (vp) this.gl.viewport(vp.x, vp.y, vp.w, vp.h);
    }

    /** 표시 크기와 백킹스토어(devicePixelRatio)를 맞춘다. */
    _resizeBackingStore() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
        const changed = this.canvas.width !== w || this.canvas.height !== h;
        if (changed) {
            this.canvas.width = w;
            this.canvas.height = h;
        }

        // 배처의 좌표계는 무대 기준(480×270) 그대로다. 뷰포트를 캔버스 전체로 늘리면
        // 창 비율이 16:9가 아닐 때 그림이 눌려 보이므로, 들어가는 가장 큰 16:9
        // 사각형을 가운데에 둔다.
        const scale = Math.min(w / STAGE_WIDTH, h / STAGE_HEIGHT);
        let vw = Math.max(1, Math.round(STAGE_WIDTH * scale));
        let vh = Math.max(1, Math.round(STAGE_HEIGHT * scale));
        // 미세 오차(독 높이 차이나 소수점 1~16px 오차)로 인해 좌우에 불필요한 레터박스가 생기지 않도록 스냅
        if (Math.abs(w - vw) <= 16) vw = w;
        if (Math.abs(h - vh) <= 16) vh = h;
        const vx = Math.max(0, Math.round((w - vw) / 2));
        const vy = Math.max(0, Math.round((h - vh) / 2));
        this.viewport = { x: vx, y: vy, w: vw, h: vh };
        // 마우스 좌표 변환은 CSS 픽셀로 해야 한다 — 백킹스토어 픽셀을 그대로 쓰면
        // 고DPI 화면에서 클릭 위치가 배율만큼 어긋난다. 레터박스가 가운데 정렬이라
        // 위/아래(좌/우) 띠가 같아서 GL의 y축 반전은 이 식에 영향이 없다.
        this.viewportCss = { x: vx / dpr, y: vy / dpr, w: vw / dpr, h: vh / dpr };
        this._ensurePen();
        this._applyViewport();
        return changed;
    }

    _paintObjPreview(force = false) {
        const stats = this.objPreview?.render(this.vm, this.canvas.width, this.canvas.height, force, this.viewport);
        if (!stats) return false;
        this.frameVertices = stats.vertices;
        this.frameTriangles = stats.triangles;
        this.frameDrawCalls = stats.drawCalls;
        return true;
    }

    /**
     * 일시정지 상태이거나 대기 중인 상태에서 캔버스 크기 변경(전체화면 전환 등)이
     * 일어났을 때 현재 상태를 즉시 화면에 다시 그린다.
     */
    renderStaticFrame() {
        this._resizeBackingStore();
        this._clearCanvas();
        // A completed static frame belongs to the Entry pen composition. The
        // cached GPU mesh is only a temporary replacement while presentation
        // is unfinished or the user is actively dragging it. Drawing both
        // layers produces a face mesh with the old vertex pass overlaid.
        if (this.objPreview?.needsPreview(this.vm) || this.vm?.tickInProgress) {
            if (this._paintObjPreview(true)) return;
        }
        if (this.spritePass && this.vm) {
            this._applyViewport();
            const order = this.vm.drawOrder();
            this.spritePass.begin();
            drawLayeredScene(this.spritePass, this.vm, this.textures,
                (objectIndex) => this._penLayer(objectIndex)?.tex, order);
            this.spritePass.end();
        }
    }

    _loop = (now) => {
        if (!this.running) return;
        this.rafId = requestAnimationFrame(this._loop);
        this.rafCalls += 1;
        this._runFrame(now, false);
    };

    _runFrame = (now, interactive = false) => {
        if (!this.running || this._inFrame) return;

        // ── 렌더 상한(FPS 리미터) ──────────────────────────────────────
        // 모니터가 144Hz여도 60으로 묶을 수 있다. 상한에 걸린 프레임은 로직도
        // 돌리지 않는다 — `advance`가 시간 기반이라 다음 프레임에 밀린 만큼 따라잡는다.
        if (!interactive && this.renderHz > 0) {
            const minGap = 1000 / this.renderHz - 0.5;   // rAF 흔들림 여유 0.5ms
            if (now - this.lastRenderAt < minGap) return;
        }
        this.lastRenderAt = now;
        this._inFrame = true;

        const frameStart = performance.now();
        if (this._resizeBackingStore()) this._clearCanvas();

        try {
            if (this.nativeGame) {
                const logicStart = performance.now();
                const k = this.nativeKeys, mx = this.input.mouseX / (STAGE_WIDTH / 2), my = this.input.mouseY / (STAGE_HEIGHT / 2);
                this.nativeGame.setInput({
                    forward: (k[87] || k[38] ? 1 : 0),
                    right: (k[68] ? 1 : 0) - (k[65] ? 1 : 0),
                    up: (k[32] ? 1 : 0) - (k[67] ? 1 : 0),
                    sprint: !!k[16], bite: !!(k[69] || this.input.mouseDown),
                    yaw: mx * Math.PI * .82 + ((k[39] ? 1 : 0) - (k[37] ? 1 : 0)) * .45,
                    pitch: Math.max(-1.15, Math.min(1.15, my * .82 + ((k[38] ? 1 : 0) - (k[40] ? 1 : 0)) * .25)),
                });
                if (k[82] && this.nativeGame.player < 0) this.nativeGame.reset();
                const dt = Math.max(0, Math.min(.1, (now - this.gameLastNow) / 1000));
                this.gameLastNow = now;
                const ticks = this.nativeGame.advance(dt * this.turbo);
                const logicEnd = performance.now();
                const rs = this.nativeRenderer.render(this.nativeGame, this.canvas.width, this.canvas.height);
                this.vm.texts = this.nativeRenderer.hud(this.nativeGame);
                this.frameVertices = rs.vertices; this.frameTriangles = rs.triangles; this.frameDrawCalls = rs.drawCalls;
                this.ticksRun += ticks; this.framesDrawn += 1;
                this._sample(frameStart, logicEnd - logicStart, performance.now() - logicEnd, now);
                if (this.hooks.onPaint) this.hooks.onPaint();
                if (interactive && this.hooks.onInputFrame) this.hooks.onInputFrame();
                return;
            }

            // Large static OBJ viewers already have their mesh in a GPU VBO.
            // While dragging, spending the main thread on another full Entry
            // face sort would block requestAnimationFrame for hundreds of
            // milliseconds and hide the speed-up. Keep the VM state intact,
            // present the preview at display cadence, then let the pending
            // mouse press run once at the final coordinate after release.
            // The GPU mesh replaces only presentation. Input and scheduler
            // state below must continue to advance during a real drag.
            this.vm.setHost({
                mouseX: this.input.mouseX,
                mouseY: this.input.mouseY,
                mouseDown: this._pointerDownForTick(),
                pointerLocked: this.input.locked,
                // 초시계는 **VM이 들고 있다**. 엔트리의 초시계는 `시작하기` 블록
                // 전까지 0이고 `정지하기`에 멈추는데, 여기서 벽시계를 매 프레임
                // 덮어쓰면 그 전부가 사라져 "멈춘 초시계가 계속 흐르는" 작품이 된다.
            });
            // 델타는 **더해서** 넘기고 우리 쪽 누적만 비운다. VM 슬롯은 블록이
            // 읽을 때 비워지므로, 이 프레임에 틱이 안 돌면 다음 프레임까지
            // 그대로 쌓인다(= 입력이 사라지지 않는다).
            this.vm.pushHostDelta(
                this.input.deltaX, this.input.deltaY, this.input.wheel, this.input.wheelX,
            );
            if (this.tessScrollPending) {
                const scrollMessage = this.program?.messages?.indexOf('$SCROLL') ?? -1;
                if (scrollMessage >= 0) this.vm.wake('when_message_cast', -1, scrollMessage);
                this.tessScrollPending = false;
            }
            this.input.deltaX = 0;
            this.input.deltaY = 0;
            this.input.wheel = 0;
            this.input.wheelX = 0;

            // 펜 명령이 처음 나올 때 그 명령 소유 오브젝트의 버퍼를 연다.
            // 통계는 누적값이라 프레임 전후 차이를 봐야 "이 프레임의 버텍스 수"가 된다.
            const b0 = this.batcher.stats;
            const vert0 = b0.vertices, tri0 = b0.triangles, draw0 = b0.drawCalls;
            // 1) 펜: 오브젝트별 오프스크린 버퍼에 **쌓는다**(지우지 않는다).
        this._ensurePen();
        this._activePenObject = null;
        this._penBound = false;
        const logicStart = performance.now();
            // 티어 3은 한 틱 자체가 프레임 예산보다 길 수 있다. 밀린 틱을 한 rAF에서
            // 연달아 처리하면 합성 기회가 계속 밀려 계산 중인 빈 화면처럼 보인다.
            // A catch-up batch cannot change mouseDown halfway through. Keep
            // press/release edges on separate logical frames.
            const catchUpTicks = this.pointerEdgeQueue.length ? 1 : this.catchUpTicks;
            const mouseDownReadsBefore = this.vm.hostReadCounts[HOST_MOUSE_DOWN];
            const advance = () => this.vm.advance(now, catchUpTicks, this.frameWorkMs, true);
            const ticks = this.objPreview
                ? this.objPreview.withPresentationSuppressed(this.vm, advance)
                : advance();
            const mouseDownReads = this.vm.hostReadCounts[HOST_MOUSE_DOWN] - mouseDownReadsBefore;
            this._finishPointerTick(ticks, mouseDownReads);
            // 작품이 틱 중에 요청한 것(복사·커서·락)을 여기서 한 번에 처리한다.
        this.applyHostWrites();
        const logicEnd = performance.now();
        this._finishPenLayer();

        // A still-running logical tick leaves the pen backbuffer halfway
        // through a renderer. Keep the previous complete frame visible. Do
        // not key this off budgetPauses: advance() can pause one chunk and
        // finish the same tick in a later chunk of this very rAF. The old
        // check threw that completed frame away, so logic ran at 20Hz while
        // the display updated only 0–2 times per second.
        if (this.vm.tickInProgress) {
            this.ticksRun += ticks;
            const previewPainted = this._paintObjPreview(true);
            if (previewPainted) {
                this.lastDrawAt = now;
                this.framesDrawn += 1;
            } else if (this.spritePass && this.vm) {
                this._clearCanvas();
                const order = this.vm.drawOrder();
                this.spritePass.begin();
                drawLayeredScene(this.spritePass, this.vm, this.textures,
                    (objectIndex) => this._penLayer(objectIndex)?.tex, order);
                this.spritePass.end();
                this.lastDrawAt = now;
                this.framesDrawn += 1;
            }
            this._sample(frameStart, logicEnd - logicStart,
                previewPainted ? performance.now() - logicEnd : 0, now);
            if (this.hooks.onPaint) this.hooks.onPaint();
            return;
        }

        // 저연산 모드 렌더 조율 (예: 1단계 ~8fps, 2단계 ~13fps 페이싱):
        // 로직 틱은 정상적으로 돌리되, 사용자 입력 인터랙션 중이 아니고 minDrawGapMs가
        // 지나지 않았으면 비싼 WebGL 합성/버퍼 제출을 건너뛰고 연산에 집중한다.
        // 첫 프레임(lastDrawAt === 0)은 화면이 비어 보이지 않도록 즉시 그린다.
        // 다만 DOM 텍스트/변수 모니터 등 가벼운 오버레이는 최신 상태로 유지한다.
        if (!interactive && this.minDrawGapMs > 0 && this.lastDrawAt > 0 && (now - this.lastDrawAt < this.minDrawGapMs)) {
            this.ticksRun += ticks;
            this._sample(frameStart, logicEnd - logicStart, 0, now);
            if (this.hooks.onPaint) this.hooks.onPaint();
            return;
        }
        this.lastDrawAt = now;

            // 2) 화면: 지우고 **3D 미리보기/펜 → 모양** 순으로 합성한다. 모양은 매 프레임
            //    처음부터 다시 그리므로 이 지우기가 없으면 잔상이 남는다.
            this._clearCanvas();
            const previewPainted = Boolean(this.objPreview?.needsPreview(this.vm))
                && this._paintObjPreview(true);
            const previewVertices = previewPainted ? this.frameVertices : 0;
            const previewTriangles = previewPainted ? this.frameTriangles : 0;
            const previewDrawCalls = previewPainted ? this.frameDrawCalls : 0;
            const order = this.vm.drawOrder();
            this.spritePass.begin();
            drawLayeredScene(this.spritePass, this.vm, this.textures,
                previewPainted ? null : (objectIndex) => this._penLayer(objectIndex)?.tex,
                order);
            this.spritePass.end();

            this.frameVertices = previewVertices
                + b0.vertices - vert0 + this.spritePass.stats.quads * 4;
            this.frameTriangles = previewTriangles
                + b0.triangles - tri0 + this.spritePass.stats.quads * 2;
            this.frameDrawCalls = previewDrawCalls
                + b0.drawCalls - draw0 + this.spritePass.stats.drawCalls;
            this.spritePass.resetStats();

            this.ticksRun += ticks;
            this.framesDrawn += 1;
            this._sample(frameStart, logicEnd - logicStart, performance.now() - logicEnd, now);
            if (this.hooks.onPaint) this.hooks.onPaint();
            if (interactive && this.hooks.onInputFrame) this.hooks.onInputFrame();
        } catch (e) {
            // 한 프레임의 예외로 루프가 조용히 멈추면 원인을 영원히 못 찾는다.
            this.pause();
            this.lastError = e;
            if (this.hooks.onError) this.hooks.onError(e);
            else throw e;
        } finally {
            this._inFrame = false;
        }
    };

    _sample(frameStart, logicMs, renderMs, now) {
        const m = this.metrics;
        m.frameMs = performance.now() - frameStart;
        m.logicMs = logicMs;
        m.renderMs = renderMs;
        // OBJ preview는 한 번 만든 VBO를 재사용하므로 매우 빠른 프레임에서는
        // 일반 배처의 순간 통계가 먼저 표본화되어 실제 11,566면 모델이 수천 면으로
        // 보일 수 있다. OBJ 작품에서는 현재 선택된 GPU 모델의 안정된 규모를 표시한다.
        const objVertices = Number(this.objPreview?.vertexCount) || 0;
        m.vertices = objVertices || this.frameVertices;
        m.triangles = objVertices ? objVertices / 3 : this.frameTriangles;
        m.drawCalls = this.frameDrawCalls;
        if (this.nativeGame) {
            const s = this.nativeGame.snapshot();
            m.stepsPerTick = s.grid.candidates;
            m.liveThreads = s.fish;
            m.overruns = s.stats.nanRepairs;
        } else {
            m.stepsPerTick = this.vm.stats.lastTickSteps;
            m.liveThreads = this.vm.liveThreads;
            m.overruns = this.vm.stats.overruns;
        }

        // 초당 수치는 0.5초 창으로 평균한다 — 프레임 하나로 계산한 FPS는 숫자가
        // 튀어서 읽을 수 없고, 1초 창은 설정을 바꿨을 때 반응이 느리다.
        // 첫 실행 시 0.5초 동안 FPS/TPS가 비어 있지 않도록 첫 1프레임에서 즉시 초기 통계를 발행한다.
        const elapsed = now - this.lastSampleAt;
        if (!this._initialSampleDone || elapsed >= 500) {
            this._initialSampleDone = true;
            const sampleTime = Math.max(1, elapsed);
            m.fps = this.framesDrawn > 0 ? (this.framesDrawn * 1000) / sampleTime : 60;
            m.rafHz = this.rafCalls > 0 ? (this.rafCalls * 1000) / sampleTime : 60;
            m.tickHz = this.ticksRun > 0 ? (this.ticksRun * 1000) / sampleTime : 60;
            this.framesDrawn = 0;
            this.rafCalls = 0;
            this.ticksRun = 0;
            this.lastSampleAt = now;
            if (this.hooks.onFrame) this.hooks.onFrame(m);
        }
    }

    dispose() {
        this.pause();
        if (this.nativeRenderer) this.nativeRenderer.dispose();
        if (this.objPreview) this.objPreview.dispose();
        this.batcher.dispose();
        this.spritePass.dispose();
        for (const layer of this.penLayers.values()) layer.dispose();
        this.penLayers.clear();
        this.textures.dispose();
    }
}

export { TIER_THRESHOLDS };
export default EniwanRuntime;
