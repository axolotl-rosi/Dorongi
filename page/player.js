/**
 * 엔트리 실행 화면 자리에 들어가는 EniwanVM 실행기.
 *
 * 엔트리의 조작 바를 흉내내지 않는다. EniwanVM은 "같은 작품을 더 빠르게"가 전부이므로
 * 화면도 그쪽을 보여 준다 — 무대 위에 티어/FPS, 아래에 렌더·로직 Hz와 터보를 바로
 * 돌릴 수 있는 콘솔. 정지/일시정지는 있지만 중앙에 두지 않았다.
 *
 * 이 파일이 하는 일의 순서:
 *   1. graphql로 작품을 읽는다            (entry-project.js)
 *   2. 분석 + 컴파일                       (vendor/eniwanvm/runtime.js의 load)
 *   3. **관문**에서 "이 작품을 얹어도 되나"를 묻는다 (gate.js)
 *      → 안 되면 엔트리 원본으로 돌려보낸다. 빈 무대를 띄우지 않는다.
 *   4. 되면 무대를 붙이고 입력을 연결한다
 */

import { EniwanRuntime } from '../vendor/eniwanvm/runtime.js';
import { normalizeProject } from '../vendor/eniwanvm/project.js';
import { fetchWork, thumbUrl } from './entry-project.js';
import { readCurrentEntryProject } from './current-project.js';
import { fetchNickname } from './entry-user.js';
import { decideGate } from './gate.js';

/** `HOST_NICKNAME` — vendor/eniwanvm/isa.js와 같은 번호여야 한다. */
const HOST_NICKNAME = 17;
const DORONGI_VERSION = '4.0.0';

const ICON = {
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.8 3.2 12.6 8l-7.8 4.8Z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3.2" width="2.8" height="9.6" rx=".9"/>'
        + '<rect x="9.2" y="3.2" width="2.8" height="9.6" rx=".9"/></svg>',
    stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.6"/></svg>',
    undo: '<svg viewBox="0 0 16 16" aria-hidden="true" class="ev-stroke">'
        + '<path d="M5.2 4.2 2.8 6.6 5.2 9"/><path d="M3.2 6.6h5.1a4 4 0 0 1 4 4"/></svg>',
    full: '<svg viewBox="0 0 16 16" aria-hidden="true" class="ev-stroke">'
        + '<path d="M2.8 6V2.8H6M13.2 6V2.8H10M2.8 10v3.2H6M13.2 10v3.2H10"/></svg>',
    exitFull: '<svg viewBox="0 0 16 16" aria-hidden="true" class="ev-stroke">'
        + '<path d="M6 2.8V6H2.8M10 2.8V6h3.2M6 13.2V10H2.8M10 13.2V10h3.2"/></svg>',
    settings: '<svg viewBox="0 0 16 16" aria-hidden="true" class="ev-stroke">'
        + '<path d="M2.5 4h4M9.5 4h4M2.5 8h7M12.5 8h1M2.5 12h2M7.5 12h6"/>'
        + '<circle cx="8" cy="4" r="1.4"/><circle cx="11" cy="8" r="1.4"/><circle cx="6" cy="12" r="1.4"/></svg>',
    sound: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.4l3-2.5v9l-3-2.5H2.5Z"/>'
        + '<path d="M10 5.2c1.5 1.5 1.5 4.1 0 5.6M11.8 3.5c2.4 2.4 2.4 6.6 0 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    muted: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.4l3-2.5v9l-3-2.5H2.5Z"/>'
        + '<path d="m10.2 6 3.2 4M13.4 6l-3.2 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" aria-hidden="true" class="ev-stroke"><path d="m3.5 3.5 9 9M12.5 3.5l-9 9"/></svg>',
};

export const TURBO = Array.from({ length: 16 }, (_, i) => i + 1);
export const COMPUTE_LEVELS = [1, 2, 3, 4, 5];

const fmtInt = (n) => Math.round(n).toLocaleString('ko-KR');

function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    parent?.appendChild(node);
    return node;
}

function iconButton(parent, className, label, icon) {
    const button = el('button', `ev-btn ${className}`, parent);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    return button;
}

function dropdown(parent, label, values, format, initial, onPick) {
    const wrap = el('label', 'ev-select-field', parent);
    el('span', 'ev-select-label', wrap).textContent = label;
    const select = el('select', 'ev-select', wrap);
    for (const value of values) {
        const option = el('option', '', select);
        option.value = String(value);
        option.textContent = format(value);
    }
    select.value = String(initial);
    select.onchange = () => onPick(Number(select.value));
    return { select: (value) => { select.value = String(value); }, node: select };
}

function numberField(parent, label, initial, onPick) {
    const wrap = el('label', 'ev-select-field ev-number-field', parent);
    el('span', 'ev-select-label', wrap).textContent = label;
    const input = el('input', 'ev-number-input', wrap);
    input.type = 'number';
    input.min = '1';
    input.max = '16';
    input.step = '1';
    input.value = String(initial);
    const commit = () => {
        const value = Math.max(1, Math.min(16, Math.round(Number(input.value) || 1)));
        input.value = String(value);
        onPick(value);
    };
    input.onchange = commit;
    input.onblur = commit;
    return { select: (value) => { input.value = String(value); }, node: input };
}

function settingRange(parent, label, description, initial, onPick) {
    const field = el('label', 'ev-setting-row ev-setting-range-row', parent);
    const copy = el('span', 'ev-setting-copy', field);
    el('strong', '', copy).textContent = label;
    if (description) el('small', '', copy).textContent = description;
    const value = el('output', 'ev-setting-range-value', field);
    const input = el('input', 'ev-setting-range', field);
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = String(initial);
    const apply = () => {
        value.textContent = `${input.value}%`;
        onPick(Number(input.value));
    };
    value.textContent = `${input.value}%`;
    input.oninput = apply;
    input.onchange = apply;
    return input;
}

function settingSelect(parent, label, description, options, initial, onPick) {
    const field = el('div', 'ev-setting-row', parent);
    const copy = el('span', 'ev-setting-copy', field);
    el('strong', '', copy).textContent = label;
    if (description) el('small', '', copy).textContent = description;
    const picker = el('div', 'ev-setting-picker', field);
    const button = el('button', 'ev-setting-select', picker);
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const menu = el('div', 'ev-setting-menu', picker);
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    let value = String(initial);
    const labels = new Map(options.map(([key, text]) => [String(key), text]));
    const paint = () => {
        button.textContent = labels.get(value) ?? value;
        for (const option of menu.children) {
            option.classList.toggle('is-selected', option.dataset.value === value);
            option.setAttribute('aria-selected', option.dataset.value === value ? 'true' : 'false');
        }
    };
    let closeTimer = 0;
    const close = () => {
        clearTimeout(closeTimer);
        menu.classList.remove('is-open');
        button.setAttribute('aria-expanded', 'false');
        closeTimer = setTimeout(() => { menu.hidden = true; }, 190);
    };
    const open = () => {
        clearTimeout(closeTimer);
        menu.hidden = false;
        requestAnimationFrame(() => menu.classList.add('is-open'));
        button.setAttribute('aria-expanded', 'true');
    };
    for (const [key, text] of options) {
        const option = el('button', 'ev-setting-option', menu);
        option.type = 'button';
        option.setAttribute('role', 'option');
        option.dataset.value = String(key);
        option.textContent = text;
        option.onclick = () => {
            value = String(key);
            paint();
            close();
            onPick(value);
            button.focus({ preventScroll: true });
        };
    }
    Object.defineProperty(button, 'value', {
        get: () => value,
        set: (next) => { value = String(next); paint(); },
    });
    button.onclick = () => (menu.hidden ? open() : close());
    picker.addEventListener('focusout', () => setTimeout(() => {
        if (!picker.contains(document.activeElement)) close();
    }, 0));
    picker.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { close(); button.focus(); }
    });
    paint();
    return button;
}

function settingToggle(parent, label, description, checked, onPick) {
    const field = el('label', 'ev-setting-row', parent);
    const copy = el('span', 'ev-setting-copy', field);
    el('strong', '', copy).textContent = label;
    if (description) el('small', '', copy).textContent = description;
    const input = el('input', 'ev-setting-check', field);
    input.type = 'checkbox';
    input.checked = checked;
    const visual = el('span', 'ev-switch', field);
    input.onchange = () => onPick(input.checked);
    visual.setAttribute('aria-hidden', 'true');
    return input;
}

export function recommendedComputeLevel(analysis) {
    const m = analysis?.metrics || {};
    const peak = Math.max(Number(m.tickCost) || 0, Number(m.startCost) || 0);
    const pen = Number(m.penPerTick) || 0;
    const fill = Number(m.fillPerTick) || 0;
    const objects = Number(m.objects) || 0;
    if (isExtremeComputeWork(analysis)) return 5;
    // A 12k-face OBJ viewer belongs in the heavy band, not the emergency
    // ceiling.  Pen/fill volume catches data-driven renderers whose compact
    // block source understates the work performed after list expansion.
    if (pen >= 2_000 || fill >= 1_000 || peak >= 1_000_000) return 4;
    // Large generated sprite/physics programs can look huge to the static
    // expander while their hot functions are handled by the native tier. Do
    // not turn a few-sprite, non-pen work into a level-4 recommendation solely
    // because analysis reached its expansion ceiling.
    if (pen === 0 && fill === 0 && objects <= 12 && !m.recursive) return peak < 8_000 ? 1 : 2;
    if (peak < 12_000 && pen < 40 && fill < 20 && objects <= 30) return 1;
    if (peak < 150_000 && pen < 500 && fill < 250) return 2;
    return 3;
}

export function isExtremeComputeWork(analysis) {
    const m = analysis?.metrics || {};
    const peak = Math.max(Number(m.tickCost) || 0, Number(m.startCost) || 0);
    // Level 5 is an explicit last-resort band for workloads well beyond large
    // 3D viewers: multi-million-dispatch recursive/truncated programs. Runtime
    // jitter alone must never promote an ordinary project into this band.
    return peak >= 2_000_000 && (Boolean(m.recursive) || Boolean(m.analysisTruncated));
}

/**
 * @param {HTMLElement} host 가로챈 iframe 바로 뒤에 꽂힌 자리
 * @param {string} projectId
 * @param {string|null} groupId
 * @param {{computeLevel:number, turbo:number, force:boolean}} settings
 * @param {(reason:string)=>void} onFallback 관문이 막았을 때 — 호출자가 원본으로 돌린다
 */
export function mountPlayer(host, projectId, groupId, settings, onFallback) {
    const root = el('div', 'ev-player is-idle', host);

    // 페이지의 뷰 코드는 자기 컨테이너에서 이벤트를 받아 화면을 다시 그린다. 우리
    // 콘솔의 클릭이 거기까지 올라가면 무대가 통째로 갈아 끼워지고 실행기가 처음부터
    // 다시 올라간다 — 눌러도 표지가 안 사라지고 누를 때마다 작품을 다시 불러오던
    // 원인이 이것이다. 우리 핸들러는 전부 더 안쪽에 있어 먼저 실행되고, 여기서 멈춘다.
    //
    // `pointerup`은 일부러 뺐다. 무대 밖에서 손을 떼는 경우를 window에서 받아야 해서
    // (아래 onPointerUp) 여기서 막으면 버튼이 눌린 채로 남는다.
    for (const type of [
        'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown',
        'keydown', 'keyup', 'wheel', 'contextmenu',
    ]) {
        root.addEventListener(type, (e) => e.stopPropagation());
    }

    const stageWrap = el('div', 'ev-stage-wrap', root);
    // 키는 무대가 포커스를 가진 동안만 작품 것이다. 페이지에는 자기 입력칸이 있다.
    stageWrap.tabIndex = 0;

    const canvas = el('canvas', 'ev-stage', stageWrap);
    const textLayer = el('div', 'ev-texts', stageWrap);
    const bubbleLayer = el('div', 'ev-bubbles', stageWrap);
    const variableLayer = el('div', 'ev-variables', stageWrap);

    const askLayer = el('div', 'ev-ask', stageWrap);
    askLayer.hidden = true;
    const askCard = el('form', 'ev-ask-card', askLayer);
    const askQuestion = el('div', 'ev-ask-question', askCard);
    const askRow = el('div', 'ev-ask-row', askCard);
    const askInput = el('input', 'ev-ask-input', askRow);
    askInput.type = 'text'; askInput.autocomplete = 'off';
    const askSubmit = el('button', 'ev-ask-submit', askRow);
    askSubmit.type = 'submit'; askSubmit.textContent = '확인';

    const hud = el('div', 'ev-hud', stageWrap);
    const tierChip = el('span', 'ev-chip', hud);
    tierChip.textContent = `Dorongi v${DORONGI_VERSION}`;
    root.dataset.eniwanvmBuild = DORONGI_VERSION;
    const fpsPill = el('span', 'ev-fps', hud);
    fpsPill.textContent = '—';

    const cover = el('div', 'ev-cover', stageWrap);
    const coverArt = el('div', 'ev-cover-art', cover);
    const coverCard = el('section', 'ev-cover-card', cover);
    const coverLogo = el('img', 'ev-cover-logo', coverCard);
    coverLogo.src = new URL('../Dorongi.png', import.meta.url).href;
    coverLogo.alt = 'Dorongi';
    const coverTitle = el('h2', 'ev-cover-title', coverCard);
    coverTitle.textContent = 'Dorongi로 실행';
    const coverDescription = el('p', 'ev-cover-description', coverCard);
    coverDescription.textContent = '엔트리 작품을 더 빠르고 안정적으로 실행합니다.';
    const coverLine = el('p', 'ev-cover-line', coverCard);
    coverLine.textContent = '작품을 불러오는 중…';
    const coverStats = el('div', 'ev-cover-stats', coverCard);
    const coverNotice = el('div', 'ev-cover-notices', stageWrap);
    coverNotice.hidden = true;
    const coverOptions = el('div', 'ev-cover-options', coverCard);
    const goButton = el('button', 'ev-go', coverCard);
    goButton.type = 'button';
    goButton.hidden = true;
    goButton.innerHTML = `${ICON.play}<span>Dorongi로 실행</span>`;
    const coverQuick = el('div', 'ev-cover-quick', coverCard);
    coverQuick.hidden = true;
    const coverBoost = el('button', 'ev-cover-quick-button', coverQuick);
    coverBoost.type = 'button';
    coverBoost.setAttribute('role', 'switch');
    const coverOrigin = el('button', 'ev-cover-quick-button', coverQuick);
    coverOrigin.type = 'button';
    coverOrigin.textContent = '원본으로 실행';
    const coverSettings = el('button', 'ev-cover-settings', coverCard);
    coverSettings.type = 'button';
    coverSettings.disabled = true;
    coverSettings.innerHTML = `${ICON.settings}<span>설정</span>`;

    const pauseOverlay = el('div', 'ev-pause-overlay', stageWrap);
    pauseOverlay.hidden = true;
    const pauseCard = el('div', 'ev-pause-card', pauseOverlay);
    const pauseLogo = el('img', 'ev-pause-logo', pauseCard);
    pauseLogo.src = new URL('../Dorongi.png', import.meta.url).href;
    pauseLogo.alt = 'Dorongi';
    const pauseTitle = el('div', 'ev-pause-title', pauseCard);
    pauseTitle.textContent = '일시정지됨';
    const pauseDesc = el('div', 'ev-pause-desc', pauseCard);
    pauseDesc.textContent = '화면을 클릭하거나 실행 버튼을 눌러 계속';
    const resumeFromPause = (event) => {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        if (!runtime || !booted) return;
        if (stopped) return;
        startWork();
    };
    pauseOverlay.addEventListener('pointerdown', resumeFromPause);
    pauseOverlay.addEventListener('click', resumeFromPause);

    const dock = el('div', 'ev-dock', root);
    const dockLeft = el('div', 'ev-dock-side', dock);
    const playButton = iconButton(dockLeft, 'ev-play', '실행', ICON.play);
    const stopButton = iconButton(dockLeft, 'ev-stop', '정지하기', ICON.stop);
    playButton.classList.add('ev-control-btn');
    stopButton.classList.add('ev-control-btn');
    stopButton.innerHTML = `${ICON.stop}<span>정지하기</span>`;
    playButton.disabled = true;
    stopButton.disabled = true;

    const dockMid = el('div', 'ev-dock-mid', dock);
    const dockRight = el('div', 'ev-dock-side ev-dock-right', dock);
    const volumeControl = el('div', 'ev-volume', dockRight);
    const volumeIcon = iconButton(volumeControl, 'ev-volume-icon', '음량 조절', ICON.sound);
    const volumePopover = el('div', 'ev-volume-popover', volumeControl);
    volumePopover.hidden = true;
    const volumeInput = el('input', 'ev-volume-input', volumePopover);
    volumeInput.type = 'range';
    volumeInput.min = '0';
    volumeInput.max = '100';
    volumeInput.step = '1';
    volumeInput.setAttribute('aria-label', '음량');
    const fullButton = iconButton(dockRight, 'ev-full', '전체화면', ICON.full);
    const settingsButton = iconButton(dockRight, 'ev-settings', '설정', ICON.settings);

    const errorBox = el('div', 'ev-error', root);
    errorBox.hidden = true;

    let runtime = null;
    let disposed = false;
    let booted = false;
    let stopped = false;
    let lastStats = null;
    let computeSelect = null;
    let speedSelect = null;
    let coverCompute = null;
    let coverTurbo = null;
    let variableMonitors = [];
    let tableMonitors = [];
    let autoOverloadSamples = 0;
    let autoSevereSamples = 0;
    const bubbleNodes = new Map();
    const textNodes = new Map();

    const savedCompute = Math.max(0, Math.min(5, Math.round(Number(settings.computeLevel) || 0)));
    const detectedTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    const detectedDevice = /Mobi|Android|iPhone/i.test(navigator.userAgent)
        ? 'mobile' : (detectedTouch && Math.min(screen.width, screen.height) < 900 ? 'tablet' : 'desktop');
    const current = {
        ...settings,
        computeSetting: savedCompute, // 0은 작품 분석에 따른 자동 추천
        computeLevel: savedCompute || 3,
        turbo: Math.max(1, Math.min(16, Number(settings.turbo) || 1)),
        // Eniwan's fast execution is independent from Entry's project-visible
        // "boost mode" flag. A normal Entry player reports this as off; only
        // report on when the user explicitly selected it.
        boostMode: settings.boostMode === true,
        deviceMode: ['auto', 'desktop', 'tablet', 'mobile'].includes(settings.deviceType)
            ? settings.deviceType : 'auto',
        touchMode: ['auto', 'on', 'off'].includes(settings.touchMode) ? settings.touchMode : 'auto',
        renderMode: ['auto', '60', '120', 'max'].includes(settings.renderMode)
            ? settings.renderMode : 'auto',
        tessMode: ['auto', 'on', 'off'].includes(settings.tessMode) ? settings.tessMode : 'auto',
        diagnostics: settings.diagnostics === true,
        volume: Math.max(0, Math.min(100, Math.round(Number(settings.volume ?? 100)))),
    };

    const resolvedEnvironment = () => ({
        boostMode: current.boostMode,
        deviceType: current.deviceMode === 'auto' ? detectedDevice : current.deviceMode,
        touchSupported: current.touchMode === 'auto' ? detectedTouch : current.touchMode === 'on',
    });
    const applyEnvironment = () => runtime?.setEnvironment(resolvedEnvironment());
    const applyRenderMode = () => {
        const hz = current.renderMode === '60' ? 60 : current.renderMode === '120' ? 120 : 0;
        runtime?.setRenderHz(hz);
    };
    const persistSettings = () => window.postMessage({
        __eniwanvm: 'settings-save',
        settings: {
            computeLevel: current.computeSetting,
            turbo: current.turbo,
            force: current.force === true,
            boostMode: current.boostMode,
            deviceType: current.deviceMode,
            touchMode: current.touchMode,
            renderMode: current.renderMode,
            tessMode: current.tessMode,
            diagnostics: current.diagnostics,
            volume: current.volume,
        },
    }, location.origin);

    const settingsShade = el('div', 'ev-settings-shade', stageWrap);
    settingsShade.hidden = true;
    const settingsPanel = el('aside', 'ev-settings-panel', settingsShade);
    settingsPanel.setAttribute('aria-label', 'Dorongi 설정');
    const settingsHead = el('header', 'ev-settings-head', settingsPanel);
    const settingsHeading = el('div', '', settingsHead);
    el('h3', '', settingsHeading).textContent = '설정';
    el('p', '', settingsHeading).textContent = '작품의 실행 환경과 화면 출력을 조절합니다.';
    const settingsClose = iconButton(settingsHead, 'ev-settings-close', '설정 닫기', ICON.close);
    const settingsBody = el('div', 'ev-settings-body', settingsPanel);

    const settingsSections = [];
    function settingsSection(title, description, open = false) {
        const details = el('details', 'ev-settings-section', settingsBody);
        details.open = open;
        settingsSections.push(details);
        const summary = el('summary', '', details);
        el('strong', '', summary).textContent = title;
        if (description) el('small', '', summary).textContent = description;
        const group = el('div', 'ev-settings-group', details);
        summary.addEventListener('click', (event) => {
            event.preventDefault();
            if (details.dataset.animating === '1') return;
            const opening = !details.open;
            if (opening) details.open = true;
            details.dataset.animating = '1';
            const height = group.scrollHeight;
            const animation = group.animate(
                opening
                    ? [{ height: '0px', opacity: 0 }, { height: `${height}px`, opacity: 1 }]
                    : [{ height: `${height}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
                { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' },
            );
            animation.onfinish = () => {
                if (!opening) details.open = false;
                delete details.dataset.animating;
            };
        });
        return group;
    }

    const executionSettings = settingsSection('실행', '연산 예산과 화면 갱신', true);
    const settingsCompute = settingSelect(executionSettings, '연산 규모',
        '3단계는 일반 작품, 4단계는 대형 3D, 5단계는 극한 계산용입니다.',
        [['0', '자동 추천'], ...COMPUTE_LEVELS.map((v) => [String(v), `${v}단계`])],
        String(current.computeSetting), (value) => {
            current.computeSetting = Number(value);
            current.computeLevel = current.computeSetting || recommendedComputeLevel(runtime?.analysis);
            runtime?.setComputeLevel(current.computeLevel);
            computeSelect?.select(current.computeLevel);
            coverCompute?.select(current.computeLevel);
            applyRenderMode();
            persistSettings();
        });
    const settingsTurbo = settingSelect(executionSettings, '실행 배속',
        '작품 시간과 로직이 진행되는 배율입니다.', TURBO.map((v) => [String(v), `${v}×`]),
        String(current.turbo), (value) => {
            current.turbo = Math.max(1, Math.min(16, Number(value) || 1));
            runtime?.setTurbo(current.turbo);
            speedSelect?.select(current.turbo);
            coverTurbo?.select(current.turbo);
            persistSettings();
        });
    const renderModeSelect = settingSelect(executionSettings, '화면 갱신',
        '연산 속도와 별개이며, 자동은 모니터 주사율에 맞춥니다.',
        [['auto', '자동'], ['60', '60 fps'], ['120', '120 fps'], ['max', '제한 없음']],
        current.renderMode, (value) => {
            current.renderMode = value;
            applyRenderMode();
            persistSettings();
        });

    const volumeSetting = settingRange(executionSettings, '음량',
        '작품의 원래 음량에 적용되는 전체 출력 음량입니다.', current.volume, (value) => {
            current.volume = value;
            volumeInput.value = String(value);
            volumeIcon.innerHTML = value === 0 ? ICON.muted : ICON.sound;
            runtime?.setVolume?.(value);
            persistSettings();
        });

    const displaySettings = settingsSection('화면', '표시와 진단 정보');
    const diagnosticsToggle = settingToggle(displaySettings, '성능 정보 표시',
        'FPS와 TPS를 무대 위에 표시합니다. 티어와 면 수는 아래 진단에서 확인합니다.', current.diagnostics, (value) => {
            current.diagnostics = value;
            root.classList.toggle('show-diagnostics', value);
            persistSettings();
        });
    const fullSettingsButton = el('button', 'ev-setting-action', displaySettings);
    fullSettingsButton.type = 'button';
    fullSettingsButton.textContent = '전체화면 전환';

    const environmentSettings = settingsSection('환경 설정', 'Entry·기기·터치·TessVM 실행 환경');
    const boostToggle = settingToggle(environmentSettings, 'Entry 부스터 모드로 보고',
        '작품에 환경값만 전달하며 Dorongi 자체 속도에는 영향을 주지 않습니다.',
        current.boostMode, (value) => {
            current.boostMode = value;
            paintCoverBoost();
            applyEnvironment();
            persistSettings();
            if (runtime?.program) configureEnvironmentNotices(runtime.program);
        });
    const deviceModeSelect = settingSelect(environmentSettings, '기기 인식', `자동 감지 결과: ${detectedDevice === 'desktop' ? 'PC' : detectedDevice === 'tablet' ? '태블릿' : '스마트폰'}`,
        [['auto', '자동 감지'], ['desktop', 'PC'], ['tablet', '태블릿'], ['mobile', '스마트폰']],
        current.deviceMode, (value) => {
            current.deviceMode = value;
            applyEnvironment();
            persistSettings();
        });
    const touchModeSelect = settingSelect(environmentSettings, '화면 터치 가능 여부', `자동 감지 결과: ${detectedTouch ? '사용 가능' : '사용 불가'}`,
        [['auto', '자동 감지'], ['on', '사용 가능으로 보고'], ['off', '사용 불가로 보고']],
        current.touchMode, (value) => {
            current.touchMode = value;
            applyEnvironment();
            persistSettings();
        });

    const tessModeSelect = settingSelect(environmentSettings, 'TessVM 호환성 설정',
        '예약 변수, 포인터 델타, 스크롤 값과 $SCROLL 신호를 TessVM 방식으로 연결합니다.',
        [['auto', '자동 감지'], ['on', '항상 사용'], ['off', '사용 안 함']],
        current.tessMode, (value) => {
            current.tessMode = value;
            runtime?.setTessCompatibility(value);
            persistSettings();
            if (runtime?.program) configureEnvironmentNotices(runtime.program);
        });
    const forceToggle = settingToggle(environmentSettings, '미지원 블록 무시하고 강행',
        '옮기지 못한 블록을 제외하므로 작품 결과가 달라질 수 있습니다.',
        current.force === true, (value) => {
            current.force = value;
            persistSettings();
        });
    const originButton = el('button', 'ev-setting-action', environmentSettings);
    originButton.type = 'button';
    originButton.textContent = '이 작품을 엔트리 원본으로 열기';

    const diagnosticsSettings = settingsSection('진단', '실행 상태와 호환성');
    const diagnosticReadout = el('dl', 'ev-diagnostic-readout', diagnosticsSettings);
    diagnosticReadout.innerHTML = '<div><dt>화면</dt><dd data-ev-diag="fps">—</dd></div>'
        + '<div><dt>로직</dt><dd data-ev-diag="tick">—</dd></div>'
        + '<div><dt>프레임</dt><dd data-ev-diag="frame">—</dd></div>'
        + '<div><dt>분석 티어</dt><dd data-ev-diag="tier">—</dd></div>'
        + '<div><dt>표시 면</dt><dd data-ev-diag="faces">—</dd></div>';

    const settingsFoot = el('footer', 'ev-settings-foot', settingsPanel);
    const resetSettings = el('button', 'ev-setting-reset', settingsFoot);
    resetSettings.type = 'button';
    resetSettings.textContent = '자동 설정으로 초기화';
    el('span', '', settingsFoot).textContent = '변경 사항은 다음 작품에도 적용됩니다.';

    let settingsTransitionTimer = 0;
    const openSettings = (section = null, target = null) => {
        clearTimeout(settingsTransitionTimer);
        settingsShade.classList.remove('is-closing');
        settingsShade.hidden = false;
        if (section) section.open = true;
        else settingsPanel.scrollTop = 0;
        requestAnimationFrame(() => {
            settingsShade.classList.add('is-open');
            if (target) {
                target.classList.add('is-revealed');
                target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                setTimeout(() => target.classList.remove('is-revealed'), 1600);
            }
        });
        settingsClose.focus({ preventScroll: true });
    };
    const closeSettings = () => {
        if (settingsShade.hidden || settingsShade.classList.contains('is-closing')) return;
        settingsShade.classList.remove('is-open');
        settingsShade.classList.add('is-closing');
        clearTimeout(settingsTransitionTimer);
        settingsTransitionTimer = setTimeout(() => {
            settingsShade.hidden = true;
            settingsShade.classList.remove('is-closing');
        }, 300);
        stageWrap.focus({ preventScroll: true });
    };
    const revealEnvironment = (target) => openSettings(
        environmentSettings.closest('.ev-settings-section'), target,
    );

    const paintCoverBoost = () => {
        coverBoost.setAttribute('aria-checked', current.boostMode ? 'true' : 'false');
        coverBoost.textContent = `부스트 모드 ${current.boostMode ? '켜짐' : '꺼짐'}`;
    };
    paintCoverBoost();
    coverBoost.onclick = () => {
        current.boostMode = !current.boostMode;
        boostToggle.checked = current.boostMode;
        paintCoverBoost();
        applyEnvironment();
        persistSettings();
        revealEnvironment(boostToggle.closest('.ev-setting-row'));
        if (runtime?.program) configureEnvironmentNotices(runtime.program);
    };
    coverOrigin.onclick = () => onFallback('이 작품은 엔트리 원본으로 실행합니다');

    function configureEnvironmentNotices(program) {
        coverNotice.textContent = '';
        const notices = [];
        if (program?.usedHostSlots?.includes(18)) {
            notices.push({
                kind: 'boost',
                text: current.boostMode
                    ? '부스터 모드 여부 블록 감지 · 현재 켜짐'
                    : '이 작품은 부스터 모드 여부를 확인합니다 · 현재 꺼짐',
                target: boostToggle.closest('.ev-setting-row'),
            });
        }
        if (program?.usedHostSlots?.includes(20)) {
            notices.push({
                kind: 'touch',
                text: `이 작품은 화면 터치 가능 여부를 확인합니다 · 현재 ${resolvedEnvironment().touchSupported ? '가능' : '불가'}`,
                target: touchModeSelect.closest('.ev-setting-row'),
            });
        }
        if (program?.usesTessVM) {
            notices.push({
                kind: 'tess',
                text: current.tessMode === 'off'
                    ? 'TessVM 전용 환경 감지 · 호환성은 현재 꺼짐'
                    : 'TessVM 전용 환경을 감지해 호환성을 자동 적용했습니다',
                target: tessModeSelect.closest('.ev-setting-row'),
            });
        }
        for (const notice of notices) {
            const row = el('div', `ev-cover-notice is-${notice.kind}`, coverNotice);
            el('span', '', row).textContent = notice.text;
            const button = el('button', '', row);
            button.type = 'button';
            button.textContent = '설정하기';
            button.onclick = () => revealEnvironment(notice.target);
        }
        coverNotice.hidden = notices.length === 0;
    }
    settingsButton.onclick = () => {
        if (!settingsShade.hidden && !settingsShade.classList.contains('is-closing')) closeSettings();
        else openSettings();
    };
    coverSettings.onclick = () => { if (booted) openSettings(); };
    settingsClose.onclick = closeSettings;
    settingsShade.addEventListener('pointerdown', (event) => {
        if (event.target === settingsShade) closeSettings();
    });
    settingsPanel.addEventListener('pointerdown', (event) => event.stopPropagation());
    root.addEventListener('pointerdown', (event) => {
        for (const button of root.querySelectorAll('.ev-setting-select[aria-expanded="true"]')) {
            if (!button.closest('.ev-setting-picker')?.contains(event.target)) button.click();
        }
    }, true);
    fullSettingsButton.onclick = () => fullButton.click();
    resetSettings.onclick = () => {
        current.computeSetting = 0;
        current.computeLevel = recommendedComputeLevel(runtime?.analysis);
        current.turbo = 1;
        current.renderMode = 'auto';
        current.deviceMode = 'auto';
        current.touchMode = 'auto';
        current.boostMode = false;
        current.tessMode = 'auto';
        current.diagnostics = false;
        current.volume = 100;
        settingsCompute.value = '0';
        settingsTurbo.value = '1';
        renderModeSelect.value = 'auto';
        deviceModeSelect.value = 'auto';
        touchModeSelect.value = 'auto';
        diagnosticsToggle.checked = false;
        volumeSetting.value = '100';
        volumeSetting.previousElementSibling.textContent = '100%';
        volumeInput.value = '100';
        volumeIcon.innerHTML = ICON.sound;
        boostToggle.checked = false;
        paintCoverBoost();
        forceToggle.checked = false;
        tessModeSelect.value = 'auto';
        root.classList.remove('show-diagnostics');
        runtime?.setComputeLevel(current.computeLevel);
        runtime?.setTurbo(1);
        runtime?.setVolume?.(100);
        applyEnvironment();
        runtime?.setTessCompatibility('auto');
        applyRenderMode();
        computeSelect?.select(current.computeLevel);
        speedSelect?.select(1);
        coverCompute?.select(current.computeLevel);
        coverTurbo?.select(1);
        if (runtime?.program) configureEnvironmentNotices(runtime.program);
        persistSettings();
        closeSettings();
    };
    root.classList.toggle('show-diagnostics', current.diagnostics);

    const showError = (text) => {
        errorBox.textContent = text;
        errorBox.hidden = false;
    };

    // ── HUD ──────────────────────────────────────────────────────────────

    function paintTexts() {
        const vm = runtime?.vm;
        if (!vm) return;
        const order = [...vm.drawOrder()];
        const z = new Map(order.map((objectIndex, index) => [objectIndex, index + 1]));
        const rows = [];
        const displayScale = Math.max(0.25, stageWrap.clientWidth / 480);
        for (let entity = 0; entity < vm.entityCapacity; entity += 1) {
            const objectIndex = vm.entObject[entity];
            const object = vm.objects[objectIndex];
            if (!vm.entAlive[entity] || !vm.entVisible[entity]) continue;
            const text = String(vm.entTexts?.[entity] || vm.texts[objectIndex]
                || object.start?.text || '').slice(0, 1_048_576);
            // Entry's text_write block belongs to textBox objects. Speech from
            // ordinary sprites is painted by the separate bubble layer.
            if (object?.objectType !== 'textBox') continue;
            // Entry uses a zero-width character as an empty text-box placeholder.
            // Painting dozens of those clones creates large invisible DOM boxes.
            if (!text || !text.replace(/[\u200B-\u200D\uFEFF\s]/g, '')) continue;
            const style = vm.entTextStyles?.[entity] || vm.textStyles[objectIndex] || {};
            const font = style.font || object.start?.font
                || `${object.start?.fontSize || 12}px sans-serif`;
            // Entry scales a text entity as a whole.  F1-style HUD projects
            // create a 20px textbox clone and shrink it to 40%; ignoring that
            // entity scale made the DOM text exactly 2.5x too large.
            const entityTextScale = Math.max(0.01, Math.abs(vm.entScaleY[entity] || 1));
            const scaledFont = font.replace(/(\d+(?:\.\d+)?)px/i,
                (_, size) => `${Math.max(1, Number(size) * displayScale * entityTextScale)}px`);
            rows.push([entity, text, vm.entX[entity], vm.entY[entity], z.get(objectIndex) || 10,
                style.color || object.start?.color || '#000000',
                style.background || object.start?.background || 'transparent',
                scaledFont,
                Math.abs(vm.entW[entity] * vm.entScaleX[entity]),
                Math.abs(vm.entH[entity] * vm.entScaleY[entity]),
                object.start?.textAlign || 0,
                vm.entRot[entity] || 0,
                !!object.start?.lineBreak,
                !!object.start?.underline,
                !!object.start?.strike]);
        }
        const live = new Set();
        for (const row of rows) {
            const entity = row[0];
            live.add(entity);
            let node = textNodes.get(entity);
            if (!node) {
                node = el('div', 'ev-text-object', textLayer);
                node._cache = {};
                textNodes.set(entity, node);
            }
            if (node.style.display !== 'block') node.style.display = 'block';
            if (node._cache.text !== row[1]) {
                node.textContent = row[1];
                node._cache.text = row[1];
            }
            const lineBreak = row[12];
            const align = row[10]; // Entry: 0=center, 1=left, 2=right
            const x = row[2];
            const y = row[3];
            const left = `${(((lineBreak ? x - row[8] / 2 : x) + 240) / 480) * 100}%`;
            const top = `${((135 - (lineBreak ? y + row[9] / 2 : y)) / 270) * 100}%`;
            const zIndex = String(row[4]);
            const color = row[5];
            const background = row[6];
            const font = row[7];
            const width = lineBreak ? `${(row[8] / 480) * 100}%` : 'max-content';
            const height = lineBreak ? `${(row[9] / 270) * 100}%` : 'auto';
            const minHeight = lineBreak ? '0' : `${(row[9] / 270) * 100}%`;
            const whiteSpace = lineBreak ? 'pre-wrap' : 'pre';
            const overflowWrap = lineBreak ? 'anywhere' : 'normal';
            const textAlign = align === 2 ? 'right' : align === 1 ? 'left' : 'center';
            const anchorX = lineBreak ? 0 : align === 2 ? -100 : align === 1 ? 0 : -50;
            const anchorY = lineBreak ? 0 : -50;
            const transform = `translate(${anchorX}%, ${anchorY}%) rotate(${-row[11]}deg)`;
            const textDecoration = `${row[13] ? 'underline ' : ''}${row[14] ? 'line-through' : ''}`.trim() || 'none';

            const c = node._cache;
            if (c.left !== left) { node.style.left = left; c.left = left; }
            if (c.top !== top) { node.style.top = top; c.top = top; }
            if (c.zIndex !== zIndex) { node.style.zIndex = zIndex; c.zIndex = zIndex; }
            if (c.color !== color) { node.style.color = color; c.color = color; }
            if (c.background !== background) { node.style.background = background; c.background = background; }
            if (c.font !== font) { node.style.font = font; c.font = font; }
            if (c.width !== width) { node.style.width = width; c.width = width; }
            if (c.height !== height) { node.style.height = height; c.height = height; }
            if (c.minHeight !== minHeight) { node.style.minHeight = minHeight; c.minHeight = minHeight; }
            if (c.whiteSpace !== whiteSpace) { node.style.whiteSpace = whiteSpace; c.whiteSpace = whiteSpace; }
            if (c.overflowWrap !== overflowWrap) { node.style.overflowWrap = overflowWrap; c.overflowWrap = overflowWrap; }
            if (c.textAlign !== textAlign) { node.style.textAlign = textAlign; c.textAlign = textAlign; }
            if (c.transform !== transform) { node.style.transform = transform; c.transform = transform; }
            if (c.textDecoration !== textDecoration) { node.style.textDecoration = textDecoration; c.textDecoration = textDecoration; }
        }
        for (const [entity, node] of textNodes) {
            if (live.has(entity)) continue;
            if (node.style.display !== 'none') node.style.display = 'none';
        }
    }

    function paintBubbles() {
        const vm = runtime?.vm;
        if (!vm) return;
        const order = [...vm.drawOrder()];
        const z = new Map(order.map((objectIndex, index) => [objectIndex, index + 1]));
        const live = new Set();
        for (let entity = 0; entity < vm.entityCapacity; entity += 1) {
            const dialog = vm.dialogs[entity];
            const objectIndex = vm.entObject[entity];
            if (!dialog || !vm.entAlive[entity] || !vm.entVisible[entity]) continue;
            live.add(entity);
            let node = bubbleNodes.get(entity);
            if (!node) {
                node = el('div', 'ev-bubble', bubbleLayer);
                node._cache = {};
                bubbleNodes.set(entity, node);
            }
            if (node.style.display !== 'block') node.style.display = 'block';
            node.classList.toggle('is-think', dialog.type === 'think');
            if (node._cache.text !== dialog.text) {
                node.textContent = dialog.text;
                node._cache.text = dialog.text;
            }
            const sx = Math.max(3, Math.min(97, ((vm.entX[entity] + 240) / 480) * 100));
            const topY = vm.entY[entity]
                + Math.abs(vm.entH[entity] * vm.entScaleY[entity]) / 2 + 10;
            const sy = Math.max(5, Math.min(95, ((135 - topY) / 270) * 100));
            const left = `${sx}%`;
            const top = `${sy}%`;
            const zIndex = String((z.get(objectIndex) || 10) * 2);
            if (node._cache.left !== left) { node.style.left = left; node._cache.left = left; }
            if (node._cache.top !== top) { node.style.top = top; node._cache.top = top; }
            if (node._cache.zIndex !== zIndex) { node.style.zIndex = zIndex; node._cache.zIndex = zIndex; }
        }
        for (const [entity, node] of bubbleNodes) {
            if (live.has(entity)) continue;
            if (node.style.display !== 'none') node.style.display = 'none';
        }
    }

    function paintOverlays() {
        paintTexts();
        paintBubbles();
        paintVariableMonitors();
        paintTableMonitors();
    }

    function showAsk(question) {
        askQuestion.textContent = String(question ?? '');
        askInput.value = '';
        askLayer.hidden = false;
        requestAnimationFrame(() => askInput.focus({ preventScroll: true }));
    }

    askCard.addEventListener('submit', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!runtime) return;
        runtime.answer(askInput.value);
        askLayer.hidden = true;
        stageWrap.focus({ preventScroll: true });
        runtime.requestInputFrame();
    });

    function monitorValue(def) {
        if (!runtime?.vm) return '';
        if (def.variableType === 'list') {
            const list = runtime.vm.getList(def.id) ?? runtime.vm.getList(def.name) ?? [];
            const shown = [];
            let length = 0;
            for (let i = 0; i < list.length && i < 100 && length < 4096; i += 1) {
                const value = String(list[i] ?? '').slice(0, 512);
                shown.push(`${i + 1}: ${value}`);
                length += value.length + 8;
            }
            if (shown.length < list.length) shown.push(`… 외 ${list.length - shown.length}개`);
            return shown.join('\n');
        }
        const value = runtime.vm.getVariable(def.id) ?? runtime.vm.getVariable(def.name);
        return value === undefined ? '' : String(value);
    }

    function buildVariableMonitors(variables) {
        variableLayer.textContent = '';
        variableMonitors = [];
        for (const source of variables || []) {
            if (!source) continue;
            const def = {
                id: String(source.id ?? ''),
                name: String(source.name ?? source.id ?? ''),
                variableType: source.variableType === 'list' ? 'list' : 'variable',
            };
            const monitor = el('div', 'ev-variable', variableLayer);
            monitor.classList.toggle('is-list', def.variableType === 'list');
            monitor.hidden = source.visible !== true;
            monitor.dataset.variableId = def.id;
            monitor.style.left = `${Math.max(0, Math.min(100, ((Number(source.x) || 0) + 240) / 4.8))}%`;
            monitor.style.top = `${Math.max(0, Math.min(100, (135 - (Number(source.y) || 0)) / 2.7))}%`;
            el('span', 'ev-variable-name', monitor).textContent = def.name;
            const valueNode = el('span', 'ev-variable-value', monitor);
            variableMonitors.push({ def, monitor, valueNode, last: null });
        }
    }

    function buildTableMonitors(tables) {
        tableMonitors = [];
        for (const [index, source] of (tables || []).entries()) {
            if (!source) continue;
            const monitor = el('div', 'ev-variable is-list is-table', variableLayer);
            monitor.hidden = true;
            monitor.style.left = '8%';
            monitor.style.top = `${12 + (index % 3) * 8}%`;
            el('span', 'ev-variable-name', monitor).textContent = String(source.name || source.id || '테이블');
            const valueNode = el('span', 'ev-variable-value', monitor);
            tableMonitors.push({ index, monitor, valueNode, last: null });
        }
    }

    function paintTableMonitors() {
        for (const item of tableMonitors) {
            const mode = runtime?.vm?.tableVisible?.[item.index] || 0;
            item.monitor.hidden = !mode;
            if (!mode) continue;
            const table = runtime.vm.tables[item.index];
            if (!table) continue;
            const lines = [table.fields.join(' | ')];
            for (let i = 0; i < table.rows.length && i < 20; i += 1) {
                lines.push(table.rows[i].slice(0, 12).join(' | '));
            }
            if (table.rows.length > 20) lines.push(`… 외 ${table.rows.length - 20}행`);
            const value = lines.join('\n');
            if (value !== item.last) { item.last = value; item.valueNode.textContent = value; }
            item.monitor.classList.toggle('is-chart', mode === 2);
        }
    }

    function paintVariableMonitors() {
        for (const item of variableMonitors) {
            item.monitor.hidden = !runtime?.vm?.isMonitorVisible(
                item.def.id || item.def.name, item.def.variableType === 'list');
            const value = monitorValue(item.def);
            if (value === item.last) continue;
            item.last = value;
            item.valueNode.textContent = value;
        }
    }

    function refreshInputView() {
        // Input-driven VM frames may run between (or instead of) throttled rAF
        // callbacks. Keep coordinate/debug monitors in step with the real
        // pointer event rather than waiting for the 0.5 s metrics sample.
        paintOverlays();
    }

    function onFrame(m) {
        fpsPill.textContent = `화면 ${Math.round(m.fps)} fps · 로직 ${Math.round(m.tickHz)} tps`;
        // 실제 rAF 제출값과 VM tick을 그대로 표시한다. 임의 보정 FPS는 쓰지 않는다.
        fpsPill.classList.toggle('is-bad', m.overruns > 0);
        lastStats = {
            fps: Math.round(m.fps),
            rafHz: Math.round(m.rafHz),
            tickHz: Math.round(m.tickHz),
            frameMs: Number(m.frameMs.toFixed(1)),
            logicMs: Number(m.logicMs.toFixed(1)),
            renderMs: Number(m.renderMs.toFixed(1)),
            triangles: m.triangles,
            drawCalls: m.drawCalls,
            overruns: m.overruns,
            tier: lastStats?.tier ?? 0,
            name: lastStats?.name ?? '',
            steps: lastStats?.steps ?? 0,
            running: Boolean(runtime?.running),
            computeLevel: runtime?.computeLevel ?? current.computeLevel,
            speed: runtime?.turbo ?? current.turbo,
            budgetUsage: runtime?.stepBudget ? Math.min(1, m.stepsPerTick / runtime.stepBudget) : 0,
        };
        const diagFps = diagnosticReadout.querySelector('[data-ev-diag="fps"]');
        const diagTick = diagnosticReadout.querySelector('[data-ev-diag="tick"]');
        const diagFrame = diagnosticReadout.querySelector('[data-ev-diag="frame"]');
        const diagTier = diagnosticReadout.querySelector('[data-ev-diag="tier"]');
        const diagFaces = diagnosticReadout.querySelector('[data-ev-diag="faces"]');
        if (diagFps) diagFps.textContent = `${Math.round(m.fps)} fps`;
        if (diagTick) diagTick.textContent = `${Math.round(m.tickHz)} tps`;
        if (diagFrame) diagFrame.textContent = `${m.frameMs.toFixed(1)} ms`;
        if (diagTier) diagTier.textContent = `T${lastStats.tier || runtime?.analysis?.tier || '—'}`;
        if (diagFaces) diagFaces.textContent = fmtInt(m.triangles || 0);
        if (runtime?.running && current.computeSetting === 0) {
            // 낮은 TPS만으로 단계를 올리지 않는다. 한 논리 tick을 여러 rAF로
            // 나누는 작품은 화면은 부드러운데 TPS만 낮을 수 있다. 실제 한 화면의
            // 메인 스레드 점유가 길게 이어질 때만 예산을 올린다.
            const overloaded = m.logicMs > 12;
            autoOverloadSamples = overloaded ? autoOverloadSamples + 1 : 0;
            const severe = m.logicMs > 45;
            autoSevereSamples = severe ? autoSevereSamples + 1 : 0;
            let next = current.computeLevel;
            if (next === 1 && autoOverloadSamples >= 3) next = 2;
            else if (next === 2 && autoOverloadSamples >= 3) next = 3;
            else if (next === 3 && autoOverloadSamples >= 3) next = 4;
            else if (next === 4 && autoSevereSamples >= 5 && isExtremeComputeWork(runtime.analysis)) next = 5;
            if (next !== current.computeLevel) {
                current.computeLevel = next;
                runtime.setComputeLevel(next);
                applyRenderMode();
                computeSelect?.select(next);
                coverCompute?.select(next);
                autoOverloadSamples = 0;
                autoSevereSamples = 0;
            }
        }
        paintOverlays();
    }

    // ── 실행 제어 ────────────────────────────────────────────────────────

    function setRunning(on) {
        playButton.innerHTML = `${on ? ICON.pause : ICON.play}<span>${on ? '일시정지' : '실행'}</span>`;
        playButton.title = on ? '일시정지' : '실행';
        playButton.setAttribute('aria-label', playButton.title);
        root.classList.toggle('is-running', on);
        if (cover.hidden) {
            pauseOverlay.hidden = on;
        } else {
            pauseOverlay.hidden = true;
        }
    }

    function startWork() {
        if (!runtime || !booted) return;
        if (stopped) {
            // 정지 뒤 새 실행은 보존해 둔 지점이 아니라 작품 처음부터 시작한다.
            runtime.restart();
            stopped = false;
            root.classList.remove('is-stopped');
            stopButton.innerHTML = `${ICON.stop}<span>정지하기</span>`;
            stopButton.title = '정지하기';
            stopButton.setAttribute('aria-label', '정지하기');
        }
        root.classList.remove('is-idle');
        cover.hidden = true;
        pauseOverlay.hidden = true;
        if (fpsPill.textContent === '—') {
            fpsPill.textContent = '화면 60 fps · 로직 60 tps';
        }
        runtime.start();
        setRunning(true);
        stageWrap.focus({ preventScroll: true });
    }

    playButton.onclick = () => {
        if (!runtime || !booted) return;
        if (runtime.running) {
            runtime.pause();
            setRunning(false);
        } else {
            startWork();
        }
    };

    stopButton.onclick = () => {
        if (!runtime || !booted) return;
        if (stopped) {
            stopped = false;
            root.classList.remove('is-stopped');
            stopButton.innerHTML = `${ICON.stop}<span>정지하기</span>`;
            stopButton.title = '정지하기';
            stopButton.setAttribute('aria-label', '정지하기');
            pauseTitle.textContent = '일시정지됨';
            pauseDesc.textContent = '화면을 클릭하거나 실행 버튼을 눌러 계속';
            startWork();
            return;
        }
        runtime.pause();
        stopped = true;
        root.classList.add('is-stopped');
        setRunning(false);
        pauseTitle.textContent = '정지됨';
        pauseDesc.textContent = '정지 취소로 이어서 실행하거나 실행 버튼으로 처음부터 시작';
        stopButton.innerHTML = `${ICON.undo}<span>정지 취소</span>`;
        stopButton.title = '정지 취소';
        stopButton.setAttribute('aria-label', '정지 취소');
    };

    goButton.addEventListener('pointerup', (event) => {
        event.preventDefault();
        event.stopPropagation();
        startWork();
    });
    goButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        startWork();
    });

    originButton.onclick = () => {
        onFallback('이 작품은 엔트리 원본으로 실행합니다');
    };

    function onFullscreen() {
        const full = document.fullscreenElement === root;
        fullButton.innerHTML = full ? ICON.exitFull : ICON.full;
        fullButton.title = full ? '전체화면 끄기' : '전체화면';
        fullButton.setAttribute('aria-label', fullButton.title);
        root.classList.toggle('is-full', full);
        // 전체화면에서는 조작 바가 사라진다 — 버튼에 있던 포커스도 같이 사라지므로
        // 키가 아무 것의 것도 아니게 된다. 무대가 다시 가져간다.
        if (full) stageWrap.focus({ preventScroll: true });
        runtime?.renderStaticFrame();
        runtime?.requestInputFrame();
    }
    document.addEventListener('fullscreenchange', onFullscreen);

    fullButton.onclick = () => {
        if (document.fullscreenElement === root) void document.exitFullscreen();
        else void root.requestFullscreen().catch(() => showError('전체화면으로 바꾸지 못했습니다'));
    };

    volumeInput.value = String(current.volume);
    volumeIcon.innerHTML = current.volume === 0 ? ICON.muted : ICON.sound;
    volumeInput.oninput = () => {
        current.volume = Math.max(0, Math.min(100, Number(volumeInput.value) || 0));
        volumeIcon.innerHTML = current.volume === 0 ? ICON.muted : ICON.sound;
        volumeSetting.value = String(current.volume);
        volumeSetting.previousElementSibling.textContent = `${current.volume}%`;
        runtime?.setVolume?.(current.volume);
        persistSettings();
    };
    volumeIcon.onclick = (event) => {
        event.stopPropagation();
        volumePopover.hidden = !volumePopover.hidden;
        if (!volumePopover.hidden) volumeInput.focus({ preventScroll: true });
    };
    volumePopover.addEventListener('pointerdown', (event) => event.stopPropagation());
    root.addEventListener('pointerdown', (event) => {
        if (!volumeControl.contains(event.target)) volumePopover.hidden = true;
    }, true);

    // ── 입력 ─────────────────────────────────────────────────────────────
    // 런타임은 DOM을 건드리지 않는다(헤드리스에서도 돌아야 한다) — 이벤트 등록은
    // 전부 여기 있다. 대시보드(`public/eniwanvm/dashboard.js`)와 같은 배선이다.

    /**
     * 작품이 상대 마우스를 쓰는지 **컴파일 결과로** 판정한다. 작품 이름이나 사용자
     * 질문으로 추측하지 않는다 — 2D 작품에서 클릭이 포인터를 잠그면 커서가 사라져
     * 아무것도 못 하게 된다.
     */
    const wantsPointerLock = () => Boolean(runtime?.program?.usesRelativeMouse);

    stageWrap.addEventListener('pointermove', (e) => {
        if (!runtime) return;
        if (runtime.input.locked) {
            // 락 중에는 clientX/Y가 멈춰 있다 — 움직임은 movementX/Y에만 있다.
            runtime.pushMouseDelta(e.movementX || 0, e.movementY || 0);
            runtime.requestInputFrame();
            refreshInputView();
            return;
        }
        runtime.setPointerPosition(e.clientX, e.clientY);
        runtime.requestInputFrame();
        refreshInputView();
    });

    let activeStagePointerId = null;
    stageWrap.addEventListener('pointerdown', (e) => {
        if (!runtime || !booted) return;
        // 시작 표지·설정·질문 UI·일시정지 오버레이도 무대 안에 있지만 게임 입력은 아니다.
        // 여기서 pointer capture를 잡으면 오버레이 버튼이나 빈 공간의 클릭이 무대로 잡혀 동작하지 않는다.
        if (e.target instanceof Element && e.target.closest('.ev-cover, .ev-dock, .ev-ask, .ev-pause-overlay, .ev-settings-shade')) return;
        const p = runtime.setPointerPosition(e.clientX, e.clientY);
        activeStagePointerId = e.pointerId;
        runtime.setPointerDown(true);
        // 빠르게 드래그해 무대 바깥으로 나가더라도 pointermove를 계속 받는다.
        // 캡처하지 않으면 마지막 좌표가 멈춰 작품 쪽에서는 원점/이전 위치로
        // 되돌아간 것처럼 보인다.
        try { stageWrap.setPointerCapture(e.pointerId); } catch { /* 지원하지 않는 호스트 */ }
        stageWrap.focus({ preventScroll: true });
        // 포인터 락은 사용자 제스처 안에서만 허용된다 — 여기가 유일한 자리다.
        if (wantsPointerLock() && !runtime.isPointerLocked()) runtime.requestPointerLock();
        // 폴링(`is_clicked`)만 쓰는 작품도, hat 블록을 쓰는 작품도 있다 — 둘 다 준다.
        runtime.wake('mouse_clicked');
        // `when_object_click`은 **눌린 오브젝트에게만** 간다(`clickAt`). 번호 없이
        // 깨우면 작품의 모든 오브젝트의 클릭 블록이 한꺼번에 터진다.
        runtime.clickAt(p.x, p.y);
        runtime.requestInputFrame();
        refreshInputView();
    });

    const onPointerUp = (e) => {
        if (e && activeStagePointerId !== null && e.pointerId !== activeStagePointerId) return;
        if (!runtime?.input.mouseDown) return;
        if (e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
            runtime.setPointerPosition(e.clientX, e.clientY);
        }
        runtime.setPointerDown(false);
        runtime.wake('mouse_click_cancled');
        runtime.releaseObjectClick();
        runtime.requestInputFrame();
        refreshInputView();
        activeStagePointerId = null;
        try {
            if (e && stageWrap.hasPointerCapture(e.pointerId)) stageWrap.releasePointerCapture(e.pointerId);
        } catch { /* 이미 해제된 포인터 */ }
    };
    // 무대 밖에서 손을 떼도 눌린 상태로 남지 않게 window에서 받는다.
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    stageWrap.addEventListener('lostpointercapture', onPointerUp);

    canvas.addEventListener('wheel', (e) => {
        if (!runtime?.vm) return;
        runtime.pushWheel(e.deltaY, e.deltaX);
        runtime.requestInputFrame();
        refreshInputView();
        // 락 중이면 페이지가 스크롤되면 안 된다.
        if (runtime.input.locked) e.preventDefault();
    }, { passive: false });

    // 붙여넣기를 작품에 넘긴다 — `ev_clipboard`를 쓰는 작품에만 들어간다
    // (`pasteText`가 판정한다). 페이지의 다른 입력란은 그대로 둔다.
    const onPaste = (e) => {
        if (!runtime) return;
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        runtime.pasteText(text);
    };
    document.addEventListener('paste', onPaste);

    const onLockChange = () => {
        if (!runtime) return;
        runtime.setPointerLocked(runtime.isPointerLocked());
    };
    const onLockError = () => runtime?.setPointerLocked(false);
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('pointerlockerror', onLockError);

    stageWrap.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !settingsShade.hidden) {
            e.preventDefault();
            closeSettings();
            return;
        }
        if (!runtime?.vm) return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement
            || e.target instanceof HTMLButtonElement) return;
        runtime.setKey(e.keyCode, true);
        runtime.wake('when_some_key_pressed', -1, e.keyCode);
        runtime.requestInputFrame();
        refreshInputView();
        // 방향키·스페이스로 페이지가 스크롤되면 조작이 안 된다.
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
    });
    stageWrap.addEventListener('keyup', (e) => {
        if (runtime?.vm) {
            runtime.setKey(e.keyCode, false);
            runtime.requestInputFrame();
            refreshInputView();
        }
    });

    // 포커스를 잃으면 눌린 키가 영원히 눌린 상태로 남는다.
    const onBlur = () => {
        if (!runtime) return;
        if (runtime.vm) runtime.clearKeys();
        runtime.setPointerDown(false);
    };
    window.addEventListener('blur', onBlur);

    const nextFrame = () => new Promise((done) => {
        let settled = false;
        const finish = () => {
            if (!settled) {
                settled = true;
                done();
            }
        };
        requestAnimationFrame(finish);
        setTimeout(finish, 50);
    });

    function ensureRuntime() {
        if (runtime) return runtime;
        runtime = new EniwanRuntime(canvas, {
            onFrame,
            onPaint: paintOverlays,
            onAsk: showAsk,
            onInputFrame: refreshInputView,
            onError: (e) => showError(`실행 중 오류: ${e?.message ?? e}`),
        });
        runtime.setComputeLevel(current.computeLevel);
        runtime.setTurbo(current.turbo);
        runtime.setVolume(current.volume);
        buildDockControls();
        return runtime;
    }

    /** 속도 조절은 작품이 올라간 뒤에만 의미가 있어서 그때 만든다. */
    function buildDockControls() {
        if (computeSelect) return;
        computeSelect = dropdown(dockMid, '연산 규모', COMPUTE_LEVELS,
            (v) => `${v}단계`, current.computeLevel, (v) => {
                current.computeLevel = v;
                current.computeSetting = v;
                runtime?.setComputeLevel(v);
                coverCompute?.select(v);
                settingsCompute.value = String(v);
                applyRenderMode();
                persistSettings();
            });
        speedSelect = numberField(dockMid, '배속 ×', current.turbo, (v) => {
                current.turbo = v;
                runtime?.setTurbo(v);
                coverTurbo?.select(v);
                settingsTurbo.value = String(v);
                persistSettings();
            });
    }

    function buildCoverControls(analysis) {
        coverOptions.textContent = '';
        current.computeLevel = current.computeSetting || recommendedComputeLevel(analysis);
        runtime?.setComputeLevel(current.computeLevel);
        applyRenderMode();
        computeSelect?.select(current.computeLevel);
        settingsCompute.value = String(current.computeSetting);
        const tierLabel = el('div', 'ev-cover-tier-label', coverOptions);
        const recommended = recommendedComputeLevel(analysis);
        tierLabel.innerHTML = `<strong>연산 규모</strong><span>추천값: ${recommended}단계</span>`;
        const tierRow = el('div', 'ev-cover-tier-row', coverOptions);
        const buttons = [];
        const computeLevelDescription = (value) => ({
            1: '1단계 · 가벼운 이미지·텍스트 작품에 알맞습니다.',
            2: '2단계 · 일반적인 상호작용과 가벼운 붓 작품에 알맞습니다.',
            3: '3단계 · 대부분의 작품에 알맞은 표준 실행 예산입니다.',
            4: '4단계 · 대형 3D와 무거운 반복 연산에 알맞습니다.',
            5: '5단계 · 매우 복잡한 재귀·분석 작품에 더 많은 실행 예산을 줍니다.',
        }[value] || '작품에 맞는 실행 예산을 선택합니다.');
        let recommend = null;
        const selectTier = (value) => {
            for (const button of buttons) button.classList.toggle('is-on', Number(button.dataset.value) === value);
        };
        for (const value of COMPUTE_LEVELS) {
            const button = el('button', 'ev-cover-tier', tierRow);
            button.type = 'button';
            button.dataset.value = String(value);
            button.textContent = `${value}단계`;
            button.title = `${value}단계 연산 예산`;
            button.onclick = () => {
                current.computeLevel = value;
                current.computeSetting = value;
                runtime?.setComputeLevel(value);
                computeSelect?.select(value);
                settingsCompute.value = String(value);
                selectTier(value);
                recommend.textContent = computeLevelDescription(value);
                applyRenderMode();
                persistSettings();
            };
            buttons.push(button);
        }
        coverCompute = {
            select(value) {
                selectTier(Number(value));
                if (recommend) recommend.textContent = computeLevelDescription(Number(value));
            },
        };
        selectTier(current.computeLevel);
        recommend = el('p', 'ev-cover-recommend', coverOptions);
        recommend.textContent = computeLevelDescription(current.computeLevel);
        /* 배속은 실행 중 도구 막대와 설정에서 조절한다. 시작 화면은 실행 결정을 단순하게 둔다. */
        coverTurbo = {
            select(value) { settingsTurbo.value = String(value); },
        };
    }

    function paintCoverStats(analysis, program, compileMs) {
        tierChip.textContent = `Dorongi v${DORONGI_VERSION} · 티어 ${analysis.tier}`;
        tierChip.className = `ev-chip ev-chip--t${analysis.tier}`;
        coverStats.textContent = '';
        const rows = [
            ['호환성', '정상'],
            ['추천', `${current.computeLevel}단계${analysis.metrics.recursive ? ' · 재귀' : ''}`],
            ['준비', `${compileMs.toFixed(1)} ms`],
        ];
        for (const [k, v] of rows) {
            const cell = el('div', 'ev-stat', coverStats);
            el('span', 'ev-stat-k', cell).textContent = k;
            el('span', 'ev-stat-v', cell).textContent = v;
        }
    }

    /**
     * 분석 → 컴파일 → 관문. 관문이 막으면 `onFallback`으로 끝내고 무대를 만들지
     * 않는다 — WebGL 컨텍스트를 만든 뒤 버리면 그만큼 그래픽 메모리가 묶인다.
     */
    async function bootProject(project, label, thumb) {
        normalizeProject(project);
        buildVariableMonitors(project.variables);
        buildTableMonitors(project.tables);
        coverLine.textContent = 'Dorongi로 옮기는 중…';
        await nextFrame();
        if (disposed) return;

        let result;
        try {
            result = await ensureRuntime().load(project, label);
        } catch (e) {
            coverLine.textContent = '';
            showError(`컴파일 실패: ${e?.message ?? e}`);
            return;
        }
        if (disposed) return;

        const { analysis, program, compileMs } = result;
        runtime.setTessCompatibility(current.tessMode);
        applyEnvironment();
        applyRenderMode();
        configureEnvironmentNotices(program);
        buildCoverControls(analysis);
        const gate = decideGate({ analysis, program, force: current.force });
        if (!gate.run) {
            onFallback(gate.reason);
            return;
        }

        // 닉네임을 읽는 작품에만, **시작하기 전에 한 번** 받아 둔다. 블록이
        // 읽는 순간에 받으러 가면 그 틱이 네트워크를 기다리게 된다.
        if (program.usesNickname) {
            const nickname = await fetchNickname();
            if (disposed) return;
            runtime.vm?.setHostText(HOST_NICKNAME, nickname);
        }

        booted = true;
        coverSettings.disabled = false;
        coverQuick.hidden = false;
        paintCoverBoost();
        lastStats = {
            fps: 0, frameMs: 0, logicMs: 0, renderMs: 0, triangles: 0, drawCalls: 0,
            overruns: 0, tier: analysis.tier, name: label,
            steps: program.code ? program.code.length : 0, running: false,
        };
        paintCoverStats(analysis, program, compileMs);
        if (thumb) coverArt.style.backgroundImage = `url("${thumb}")`;
        coverTitle.textContent = label;
        coverDescription.textContent = '엔트리 작품을 Dorongi VM으로 더 빠르고 안정적으로 실행합니다.';
        coverLine.textContent = gate.code === 'forced'
            ? '미지원 블록을 제외하고 실행합니다. 작품 결과가 달라질 수 있습니다.'
            : '호환성 검사를 통과했습니다.';
        coverLine.classList.toggle('is-warn', gate.code === 'forced');
        goButton.hidden = false;
        playButton.disabled = false;
        stopButton.disabled = false;
        // 컴파일과 자산 준비까지만 끝낸다. 작품 로직은 사용자가 가운데 시작
        // 버튼을 누른 뒤에만 돈다. 표지에서 실행 예산을 고를 시간도 보장한다.
        root.classList.add('is-idle');
    }

    async function load() {
        // Prefer the exact project already held by the Entry editor. This keeps
        // unsaved edits and imported projects and avoids a server round trip.
        const live = await readCurrentEntryProject(projectId);
        if (disposed) return;
        if (live) {
            root.dataset.eniwanvmSource = live.source;
            const pageThumb = thumbUrl(document.querySelector('meta[property="og:image"]')?.content);
            await bootProject(live.project, live.name, pageThumb);
            return;
        }

        let work;
        try {
            work = await fetchWork(projectId, groupId);
        } catch (e) {
            coverLine.textContent = '';
            showError(e?.message ?? String(e));
            return;
        }
        if (disposed) return;
        root.dataset.eniwanvmSource = 'server';

        // graphql이 주는 모양은 `.ent` 안의 project.json과 같다 — 변환기가 필요 없다.
        // 장면 목록(`scenes`)까지 같이 넘긴다: 이걸 빼면 두 번째 장면의 코드가
        // 첫 장면에서 같이 돌고 `장면 시작하기`가 갈 곳을 못 찾는다.
        await bootProject(
            {
                objects: work.objects,
                variables: work.variables,
                functions: work.functions,
                scenes: work.scenes,
            },
            String(work.name ?? projectId),
            thumbUrl(work.thumb),
        );
    }

    void load();

    // ── 바깥에서 쓰는 것 ─────────────────────────────────────────────────

    return {
        /** 팝업이 읽는 지금 상태. 아직 아무것도 안 올라갔으면 null. */
        stats: () => lastStats,

        /**
         * 페이지가 무대를 다시 그려 자리가 새로 생겼을 때 — 실행기를 **옮겨 심는다.**
         * 새로 올리지 않는다: 그러면 작품을 다시 불러오고 컴파일하고, 돌던 작품이
         * 처음으로 돌아간다. 캔버스는 자리를 옮겨도 WebGL 컨텍스트를 잃지 않는다.
         */
        attach(nextHost) {
            if (disposed || !nextHost || root.parentElement === nextHost) return;
            nextHost.appendChild(root);
        },

        setSettings(next) {
            current.force = next.force;
            if (next.computeLevel !== current.computeSetting) {
                current.computeSetting = next.computeLevel;
                const level = next.computeLevel || recommendedComputeLevel(runtime?.analysis);
                current.computeLevel = level;
                runtime?.setComputeLevel(level);
                applyRenderMode();
                computeSelect?.select(level);
                coverCompute?.select(level);
            }
            if (next.turbo !== current.turbo) {
                current.turbo = next.turbo;
                runtime?.setTurbo(next.turbo);
                speedSelect?.select(next.turbo);
                coverTurbo?.select(next.turbo);
            }
            if (next.renderMode !== current.renderMode) {
                current.renderMode = next.renderMode;
                renderModeSelect.value = next.renderMode;
                applyRenderMode();
            }
            if (next.deviceType !== current.deviceMode) {
                current.deviceMode = next.deviceType;
                deviceModeSelect.value = next.deviceType;
            }
            if (next.touchMode !== current.touchMode) {
                current.touchMode = next.touchMode;
                touchModeSelect.value = next.touchMode;
            }
            current.boostMode = next.boostMode === true;
            boostToggle.checked = current.boostMode;
            paintCoverBoost();
            current.tessMode = next.tessMode;
            tessModeSelect.value = current.tessMode;
            current.diagnostics = next.diagnostics === true;
            diagnosticsToggle.checked = current.diagnostics;
            root.classList.toggle('show-diagnostics', current.diagnostics);
            if (Number.isFinite(Number(next.volume)) && Number(next.volume) !== current.volume) {
                current.volume = Math.max(0, Math.min(100, Math.round(Number(next.volume))));
                volumeInput.value = String(current.volume);
                volumeSetting.value = String(current.volume);
                volumeSetting.previousElementSibling.textContent = `${current.volume}%`;
                volumeIcon.innerHTML = current.volume === 0 ? ICON.muted : ICON.sound;
                runtime?.setVolume?.(current.volume);
            }
            forceToggle.checked = current.force === true;
            applyEnvironment();
            runtime?.setTessCompatibility(current.tessMode);
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            document.removeEventListener('fullscreenchange', onFullscreen);
            document.removeEventListener('pointerlockchange', onLockChange);
            document.removeEventListener('pointerlockerror', onLockError);
        document.removeEventListener('paste', onPaste);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
            stageWrap.removeEventListener('lostpointercapture', onPointerUp);
            window.removeEventListener('blur', onBlur);
            runtime?.dispose();
            runtime = null;
            root.remove();
        },
    };
}

export default mountPlayer;
