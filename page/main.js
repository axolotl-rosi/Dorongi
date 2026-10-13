/**
 * 페이지 월드 진입점 — playentry.org에 모듈로 올라간다.
 *
 * 격리 월드(content.js)가 "여기에 실행기가 들어갈 자리"를 표시해 두고, 이 파일이
 * 그 자리마다 실행기를 하나 올린다. playentry는 경로가 바뀌면 그 부분을 자기 코드로
 * 갈아 치우기 때문에, 자리가 사라졌는지 매번 확인해서 올려 둔 것을 내린다 —
 * 안 내리면 안 보이는 WebGL 컨텍스트가 계속 쌓인다.
 *
 * **실행기는 자리가 아니라 작품에 묶인다.** 페이지가 무대를 다시 그리면 자리(DOM
 * 노드)는 새것이 되지만 작품은 그대로다. 자리를 기준으로 세면 다시 그릴 때마다
 * 실행기를 새로 올리게 되고 — 작품을 처음부터 다시 불러오고, 컴파일하고, 표지로
 * 되돌아간다. 그래서 작품 id로 센 뒤 같은 실행기를 새 자리로 옮겨 심는다.
 */

import { mountPlayer, COMPUTE_LEVELS } from './player.js';

const HOST_SELECTOR = '[data-eniwanvm-project]';

/** `data-eniwanvm-settings`에서 읽는 글자 수 상한 — JSON.parse에 MB를 먹이지 않는다. */
const SETTINGS_MAX_CHARS = 4096;

/** 작품 id → 올라간 실행기. 자리가 아니라 작품이 열쇠다(위 주석 참고). */
const players = new Map();

const post = (message) => window.postMessage(message, location.origin);

/**
 * 설정값을 **허용 목록으로만** 받는다.
 *
 * 이 파일은 페이지 월드에 있어서, 들어오는 값이 우리 팝업에서 온 것인지 그 페이지의
 * 다른 스크립트가 넣은 것인지 구분할 방법이 없다. `Number(x) || 기본값`만 쓰면
 * 터보에 터무니없는 값이 그대로 통과하면 한 프레임에 과도한 틱을 돌려 탭이 멈출 수
 * 있다. 그래서 연산 단계는 실제 선택지로, 배속은 1~16 범위로 제한한다.
 */
function sanitizeSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const compute = Math.round(Number(s.computeLevel));
    const speed = Number(s.turbo);
    const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
    return {
        computeLevel: compute === 0 || COMPUTE_LEVELS.includes(compute) ? compute : 0,
        turbo: Number.isFinite(speed) ? Math.max(1, Math.min(16, speed)) : 1,
        force: s.force === true,
        boostMode: s.boostMode === true,
        deviceType: pick(s.deviceType, ['auto', 'desktop', 'tablet', 'mobile'], 'auto'),
        touchMode: pick(s.touchMode, ['auto', 'on', 'off'], 'auto'),
        renderMode: pick(s.renderMode, ['auto', '60', '120', 'max'], 'auto'),
        tessMode: pick(s.tessMode, ['auto', 'on', 'off'], 'auto'),
        dutMode: s.dutMode === true,
        dororongMode: s.dororongMode === true,
        diagnostics: s.diagnostics === true,
        volume: Number.isFinite(Number(s.volume))
            ? Math.max(0, Math.min(100, Math.round(Number(s.volume)))) : 100,
    };
}

function readSettings(host) {
    const text = host.dataset.eniwanvmSettings || '{}';
    if (text.length > SETTINGS_MAX_CHARS) return sanitizeSettings(null);
    try {
        return sanitizeSettings(JSON.parse(text));
    } catch {
        return sanitizeSettings(null);
    }
}

function scan() {
    /** 지금 문서에 있는 자리들. 같은 작품의 자리가 둘이면 먼저 것만 쓴다. @type {Map<string, HTMLElement>} */
    const live = new Map();
    for (const host of document.querySelectorAll(HOST_SELECTOR)) {
        const id = host.dataset.eniwanvmProject;
        if (id && !live.has(id)) live.set(id, host);
    }

    // 작품이 통째로 사라진 것만 내린다. 자리만 바뀐 것은 내리지 않는다.
    for (const [id, player] of players) {
        if (!live.has(id)) {
            player.dispose();
            players.delete(id);
        }
    }

    for (const [id, host] of live) {
        const existing = players.get(id);
        if (existing) {
            existing.attach(host);
            continue;
        }

        players.set(id, mountPlayer(
            host,
            id,
            host.dataset.eniwanvmGroup ?? null,
            readSettings(host),
            // 관문이 막았다 → 격리 월드가 iframe에 주소를 돌려준다. 여기서 먼저
            // 내려야 무대와 WebGL 컨텍스트가 남지 않는다.
            (reason) => {
                players.get(id)?.dispose();
                players.delete(id);
                post({ __eniwanvm: 'fallback', id, reason });
            },
        ));
    }
}

function unmountAll() {
    for (const player of players.values()) player.dispose();
    players.clear();
}

window.addEventListener('message', (event) => {
    // 이 창이 보낸 것만 받는다. iframe이나 창을 띄워 보내는 쪽(`event.source`가
    // 다르다)은 여기서 끝이고, 출처까지 같아야 한다 — 샌드박스 프레임에서
    // 올라오는 메시지는 출처가 "null"이라 `location.origin`과 다르다.
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.__eniwanvm !== 'string') return;

    if (data.__eniwanvm === 'scan') {
        scan();
        return;
    }
    if (data.__eniwanvm === 'unmount') {
        unmountAll();
        return;
    }
    if (data.__eniwanvm === 'settings') {
        const settings = sanitizeSettings(data.settings);
        for (const player of players.values()) player.setSettings(settings);
        return;
    }
    if (data.__eniwanvm === 'stats-ask') {
        // 자리가 여러 개일 일은 없지만, 있으면 먼저 올라간 것을 답한다.
        const first = [...players.values()][0];
        post({
            // 물어본 쪽이 준 표를 그대로 돌려준다 — 길이는 자른다(그냥 짝 맞추는 값이다).
            __eniwanvm: 'stats-answer',
            id: String(data.id ?? '').slice(0, 64),
            stats: first ? first.stats() : null,
        });
    }
});

scan();
