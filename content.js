/**
 * 격리 월드(content script) — document_start에 돈다.
 *
 * 작품 페이지는 작품을 직접 실행하지 않는다. `/iframe/<작품id>`를 가리키는 iframe이
 * 실행한다. 그래서 **그 iframe이 주소를 따라가기 전에** `about:blank`로 비운다.
 * 비우는 순간이 늦으면 엔트리 런타임과 그에 딸린 수 MB를 이미 받아 버리고, 받은 뒤에는
 * 되돌릴 방법이 없다(로드를 취소해도 메모리에 남은 엔진이 소리를 내기 시작한다).
 *
 * 비운 iframe을 **지우지는 않는다.** 페이지가 `.wrapper iframe { height: … }`로
 * 플레이어 크기를 뷰포트에 맞춰 계산하므로, 그 박스가 우리 무대를 얹을 자리다.
 * 지우면 박스가 접히고, 페이지 자신의 뷰 코드도 사라진 노드를 찾다 터진다.
 *
 * EniwanVM은 **펜/도형 작품 전용**이다(소리·복제본은 되지만 모양 그림을 안 그린다).
 * 그래서 옮길 수 없는
 * 작품은 비운 iframe에 주소를 돌려줘 엔트리 원본으로 실행시킨다 — 이 되돌리기가
 * 이 파일의 절반이다. 빈 무대를 보여 주는 것보다 원본으로 도는 쪽이 항상 낫다.
 */

const api = globalThis.browser ?? globalThis.chrome;

const IFRAME_MARK = '/iframe/';
/** 이미 가로챈 프레임 표시 — `data-eniwanvm-held` */
const HELD = 'eniwanvmHeld';

const DEFAULTS = {
    enabled: true,
    /** 0은 작품 분석 결과에 따른 자동 추천. */
    computeLevel: 0,
    turbo: 1,
    /** 미지원 블록이 있어도 강행한다. 기본 꺼짐 — "돌긴 도는데 틀린" 쪽이 제일 나쁘다. */
    force: false,
    boostMode: false,
    deviceType: 'auto',
    touchMode: 'auto',
    renderMode: 'auto',
    tessMode: 'auto',
    diagnostics: false,
    volume: 100,
};

function sanitizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const compute = Math.max(0, Math.min(5, Math.round(Number(source.computeLevel) || 0)));
    const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
    return {
        enabled: source.enabled !== false,
        computeLevel: compute,
        turbo: Math.max(1, Math.min(16, Number(source.turbo) || 1)),
        force: source.force === true,
        boostMode: source.boostMode === true,
        deviceType: pick(source.deviceType, ['auto', 'desktop', 'tablet', 'mobile'], 'auto'),
        touchMode: pick(source.touchMode, ['auto', 'on', 'off'], 'auto'),
        renderMode: pick(source.renderMode, ['auto', '60', '120', 'max'], 'auto'),
        tessMode: pick(source.tessMode, ['auto', 'on', 'off'], 'auto'),
        diagnostics: source.diagnostics === true,
        volume: Math.max(0, Math.min(100, Math.round(Number(source.volume ?? 100)))),
    };
}

/** null = 설정이 아직 안 왔다. 그동안에도 프레임은 비워 둔다(되돌리기는 공짜니까). */
let enabled = null;
let settings = { ...DEFAULTS };
let injected = false;

/**
 * 가로챈 프레임들. `host`는 우리가 꽂은 자리인데 **항목이 살아 있는 동안 계속
 * 같은 노드를 쓴다** — 페이지가 무대를 다시 그려도 이 노드를 옮겨 꽂을 뿐이라,
 * 그 안에 올라간 실행기와 돌고 있는 작품이 그대로 유지된다.
 * @type {{frame: HTMLIFrameElement, src: string, id: string, host: HTMLElement|null,
 *         positioned: boolean, released: boolean}[]}
 */
const held = [];

function idOf(src) {
    return /\/iframe\/([^/?#]+)/.exec(src)?.[1] ?? null;
}

function post(message) {
    window.postMessage({ ...message, __eniwanvm: message.__eniwanvm }, location.origin);
}

// ── 페이지 월드 주입 ──────────────────────────────────────────────────────

/** 페이지 쪽 실행기를 한 번만 올린다. 격리 월드에서는 WebGL 무대를 페이지에 붙일 수 없다. */
function inject() {
    if (injected) return;
    injected = true;
    const parent = document.head ?? document.documentElement;

    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = api.runtime.getURL('player.css');

    const script = document.createElement('script');
    script.type = 'module';
    script.src = api.runtime.getURL('page/main.js');
    // 실행기가 끝내 안 오면 빈 박스만 남는다. 그럴 땐 원본으로 돌려주는 게 맞다 —
    // 확장이 깨진 것 때문에 작품을 못 보게 만들 이유가 없다.
    script.onerror = () => {
        for (const item of held) releaseItem(item, '실행기를 불러오지 못했습니다');
    };
    parent.append(style, script);
}

// ── 가로채기 / 되돌리기 ───────────────────────────────────────────────────

function capture(item) {
    item.frame.style.visibility = 'hidden';
    if (item.frame.getAttribute('src') !== 'about:blank') {
        item.frame.setAttribute('src', 'about:blank');
    }
}

function mount(item) {
    if (item.released || !item.frame.isConnected) return;
    capture(item);

    // 자리는 **한 번만 만든다.** 다시 그릴 때마다 새로 만들면 그 안의 실행기도 새로
    // 올라가고, 작품을 처음부터 다시 불러오게 된다.
    if (!item.host) {
        item.host = document.createElement('div');
        item.host.className = 'ev-host';
        item.host.dataset.eniwanvmProject = item.id;
        const group = new URLSearchParams(location.search).get('groupId');
        if (group) item.host.dataset.eniwanvmGroup = group;
    }
    item.host.dataset.eniwanvmSettings = JSON.stringify(settings);

    const parent = item.frame.parentElement;
    if (parent && getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
        item.positioned = true;
    }
    if (item.frame.nextElementSibling !== item.host) item.frame.after(item.host);

    inject();
    post({ __eniwanvm: 'scan' });
}

/**
 * 비웠던 프레임에 원래 주소를 돌려준다 — 엔트리 원본이 여기서부터 평소대로 실행된다.
 * `reason`이 있으면 무대 위에 작은 띠로 왜 돌아갔는지 남긴다(조용히 바뀌면
 * 사용자는 확장이 꺼진 줄 안다).
 */
function releaseItem(item, reason = '') {
    item.host?.remove();
    item.host = null;
    if (item.positioned) {
        item.frame.parentElement?.style.removeProperty('position');
        item.positioned = false;
    }
    item.frame.style.removeProperty('visibility');
    if (item.frame.getAttribute('src') !== item.src) {
        item.frame.setAttribute('src', item.src);
    }
    if (reason) showBadge(item, reason);
}

/** 원본으로 돌아간 이유를 알리는 띠. 되돌리기 버튼이 함께 붙는다. */
function showBadge(item, reason) {
    const parent = item.frame.parentElement;
    if (!parent) return;
    parent.querySelector('.ev-badge')?.remove();

    const badge = document.createElement('div');
    badge.className = 'ev-badge';

    const text = document.createElement('span');
    text.className = 'ev-badge-text';
    text.textContent = reason;
    badge.appendChild(text);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ev-badge-retry';
    retry.textContent = 'Dorongi로 강행';
    retry.title = '미지원 블록을 무시하고 실행합니다. 작품이 틀리게 돌 수 있습니다.';
    retry.onclick = () => {
        badge.remove();
        settings.force = true;
        item.released = false;
        mount(item);
    };
    badge.appendChild(retry);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ev-badge-close';
    close.setAttribute('aria-label', '닫기');
    close.textContent = '×';
    close.onclick = () => badge.remove();
    badge.appendChild(close);

    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    parent.appendChild(badge);
}

function applyAll() {
    for (let i = held.length - 1; i >= 0; i -= 1) {
        const item = held[i];
        // 프레임이 잠깐 떨어져 있어도 자리가 살아 있으면 작품은 돌고 있는 중이다.
        // 둘 다 없을 때만 잊는다.
        if (!item.frame.isConnected && !item.host?.isConnected) {
            held.splice(i, 1);
            continue;
        }
        if (enabled && !item.released) mount(item);
        else if (!enabled) releaseItem(item);
    }
}

/**
 * 프레임이 나타나는 즉시 가로챈다. 설정이 아직 안 왔어도 비우는 것은 똑같이 한다 —
 * 엔트리를 받기 시작한 프레임은 되돌릴 수 없고, 주소를 다시 넣는 비용은 0이다.
 */
function hold(frame) {
    if (frame.dataset[HELD]) return;
    const src = frame.getAttribute('src') ?? '';
    if (!src.includes(IFRAME_MARK)) return;
    const id = idOf(src);
    if (!id) return;

    frame.dataset[HELD] = '1';

    // 페이지가 무대를 다시 그리면 iframe 노드 자체가 새것으로 바뀐다. 같은 작품이면
    // **항목을 새로 만들지 않고 프레임만 갈아 끼운다** — 새로 만들면 자리도 실행기도
    // 새로 올라가서 작품을 처음부터 다시 불러온다.
    const item = held.find((h) => h.id === id) ?? null;
    if (item) {
        item.frame = frame;
        item.src = src;
    } else {
        held.push({ frame, src, id, host: null, positioned: false, released: false });
    }
    const target = item ?? held[held.length - 1];

    if (enabled === null) capture(target);
    else if (enabled && !target.released) mount(target);
    else if (!enabled) releaseItem(target);
}

function sweep(node) {
    if (node instanceof HTMLIFrameElement) {
        hold(node);
        return;
    }
    if (node instanceof HTMLElement) {
        for (const frame of node.querySelectorAll('iframe')) hold(frame);
    }
}

// 프레임은 페이지의 뷰 코드가 쓰고, 주소는 노드와 함께 또는 한 박자 뒤에 붙는다 —
// 그래서 추가와 속성 변경을 둘 다 본다.
const observer = new MutationObserver((records) => {
    for (const record of records) {
        if (record.type === 'attributes') {
            const frame = record.target;
            if (!(frame instanceof HTMLIFrameElement)) continue;
            const item = held.find((h) => h.frame === frame);
            if (!item) {
                hold(frame);
            } else if (enabled && !item.released) {
                // 페이지가 주소를 다시 넣었다. 그대로 두면 엔트리 런타임이 숨은
                // 프레임에서 같이 돌기 시작한다(소리까지 난다). 다시 비운다.
                // `capture`는 이미 about:blank면 아무것도 안 해서 되돌이표가 안 생긴다.
                capture(item);
            }
            continue;
        }
        for (const node of record.addedNodes) sweep(node);
        // 페이지가 우리 자리를 쓸어 갔다 → 같은 노드를 다시 꽂는다. 노드를 재사용하므로
        // 안에 있던 실행기와 돌고 있던 작품이 그대로 돌아온다.
        for (const node of record.removedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            for (const item of held) {
                if (!item.host || item.released || !enabled) continue;
                if (item.host === node || node.contains(item.host)) mount(item);
            }
        }
    }
});
observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
});
sweep(document.documentElement);

// ── 설정 ─────────────────────────────────────────────────────────────────

void api.storage.local.get(DEFAULTS).then((stored) => {
    settings = sanitizeSettings(stored);
    enabled = settings.enabled;
    applyAll();
});

api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if ('computeLevel' in changes) settings.computeLevel = Math.max(0,
                Math.min(5, Math.round(Number(changes.computeLevel.newValue) || 0)));
    if ('turbo' in changes) settings.turbo = Math.max(1,
        Math.min(16, Number(changes.turbo.newValue) || DEFAULTS.turbo));
    if ('force' in changes) settings.force = changes.force.newValue === true;
    if ('boostMode' in changes) settings.boostMode = changes.boostMode.newValue === true;
    if ('deviceType' in changes) settings.deviceType = sanitizeSettings({ deviceType: changes.deviceType.newValue }).deviceType;
    if ('touchMode' in changes) settings.touchMode = sanitizeSettings({ touchMode: changes.touchMode.newValue }).touchMode;
    if ('renderMode' in changes) settings.renderMode = sanitizeSettings({ renderMode: changes.renderMode.newValue }).renderMode;
    if ('tessMode' in changes) settings.tessMode = sanitizeSettings({ tessMode: changes.tessMode.newValue }).tessMode;
    if ('diagnostics' in changes) settings.diagnostics = changes.diagnostics.newValue === true;
    if ('volume' in changes) settings.volume = Math.max(0,
        Math.min(100, Math.round(Number(changes.volume.newValue ?? 100))));
    // 속도 설정은 돌고 있는 작품에 그대로 먹인다 — 다시 불러올 필요가 없다.
    post({ __eniwanvm: 'settings', settings });

    if ('enabled' in changes) {
        enabled = changes.enabled.newValue !== false;
        if (!enabled) post({ __eniwanvm: 'unmount' });
        // 껐다 켠 작품은 "원본으로 보내기"를 눌렀던 것까지 함께 잊는다.
        if (enabled) for (const item of held) item.released = false;
        applyAll();
    }
});

// ── 페이지 ↔ 확장 ────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
    // 이 창 + 같은 출처만. 작품 페이지가 띄우는 iframe(`/iframe/*`)이나 다른 창에서
    // 올라오는 메시지는 여기서 끝난다.
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.__eniwanvm !== 'string') return;

    // 페이지 쪽이 "이 작품은 못 옮긴다"고 판단했다 → 원본으로 돌려준다.
    if (data.__eniwanvm === 'fallback') {
        const item = held.find((h) => h.id === data.id);
        if (!item) return;
        item.released = true;
        // 이유는 띠에 **글자로만** 들어가지만(innerHTML이 아니다), 길이는 자른다 —
        // 수 MB짜리 문구가 화면을 덮어 되돌리기 버튼을 밀어내면 그것도 사고다.
        releaseItem(item, String(data.reason || '엔트리 원본으로 실행합니다').slice(0, 200));
    }
    if (data.__eniwanvm === 'settings-save') {
        const next = sanitizeSettings({ ...settings, ...data.settings, enabled });
        settings = next;
        void api.storage.local.set(next);
    }
});

/**
 * 페이지 월드가 답한 실측값을 팝업에 넘기기 전에 모양을 맞춘다.
 *
 * 여기가 페이지 ↔ 확장의 경계다. 팝업은 받은 값을 바로 `toFixed(1)`·
 * `toLocaleString()`에 넣으므로, 페이지가 `{frameMs:"<script>"}`나 중첩 객체를
 * 밀어 넣으면 팝업이 터져 아무것도 안 보이게 된다(글자로만 쓰니 XSS는 아니다).
 * 숫자는 유한한 숫자로, 이름은 길이를 자른 글자로 바꿔서만 통과시킨다.
 */
function sanitizeStats(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const n = (value) => {
        const v = Number(value);
        return Number.isFinite(v) ? v : 0;
    };
    return {
        fps: n(raw.fps),
        frameMs: n(raw.frameMs),
        logicMs: n(raw.logicMs),
        renderMs: n(raw.renderMs),
        triangles: n(raw.triangles),
        drawCalls: n(raw.drawCalls),
        overruns: n(raw.overruns),
        tier: n(raw.tier),
        steps: n(raw.steps),
        name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '',
        running: raw.running === true,
    };
}

/** 팝업이 "지금 뭐가 돌고 있나"를 물으면 페이지 월드에 물어다 준다. */
api.runtime.onMessage?.addListener((message, sender, sendResponse) => {
    // 우리 확장이 보낸 것만 받는다. 다른 확장이나 웹페이지가
    // `chrome.runtime.sendMessage(<우리 id>, …)`로 말을 걸 수 있다.
    if (sender?.id !== api.runtime.id) return false;
    if (message?.__eniwanvm !== 'stats') return false;

    const id = `s${Date.now()}${Math.random()}`;
    let done = false;
    const finish = (value) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onReply);
        sendResponse(value);
    };
    const onReply = (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (data?.__eniwanvm === 'stats-answer' && data.id === id) finish(sanitizeStats(data.stats));
    };
    window.addEventListener('message', onReply);
    post({ __eniwanvm: 'stats-ask', id });
    // 실행기가 아직 없거나(작품 페이지가 아님) 주입이 안 됐으면 답이 오지 않는다.
    setTimeout(() => finish(null), 400);
    return true;
});
