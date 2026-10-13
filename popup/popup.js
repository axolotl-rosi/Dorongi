/**
 * 팝업 — 설정을 쓰고, 지금 돌고 있는 작품의 실측값을 읽어 온다.
 *
 * 설정은 `chrome.storage.local`에 쓰기만 한다. 적용은 content script가
 * `storage.onChanged`로 받아서 하므로, 팝업이 탭을 직접 건드릴 일은 없다 —
 * 팝업이 닫혀 있는 동안에도 설정이 먹어야 하니 그쪽이 맞다.
 *
 * 실측값만 예외다. 그건 페이지 월드의 실행기만 알고 있어서 물어봐야 한다:
 * 팝업 → content script → 페이지 → 되돌아오는 길. 답이 없으면(작품 페이지가
 * 아니거나 아직 아무것도 안 올라갔으면) 빈 안내를 둔다.
 */

const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = { enabled: true };

const $ = (id) => document.getElementById(id);

const el = {
    dot: $('dot'),
    enabled: $('enabled'),
    pillText: $('pillText'),
    liveEmpty: $('liveEmpty'),
    liveGrid: $('liveGrid'),
    mName: $('mName'),
    mFps: $('mFps'),
    mFrame: $('mFrame'),
    mLogic: $('mLogic'),
    mRender: $('mRender'),
    mTier: $('mTier'),
    mSteps: $('mSteps'),
};

let settings = { ...DEFAULTS };

// ── 설정 ─────────────────────────────────────────────────────────────────

function paintEnabled() {
    el.enabled.setAttribute('aria-checked', settings.enabled ? 'true' : 'false');
    el.pillText.textContent = settings.enabled ? '켜짐' : '꺼짐';
    el.dot.classList.toggle('is-off', !settings.enabled);
}

function paintSettings() {
    paintEnabled();
}

el.enabled.onclick = () => {
    settings.enabled = !settings.enabled;
    paintEnabled();
    void api.storage.local.set({ enabled: settings.enabled });
};

// ── 실측값 ───────────────────────────────────────────────────────────────

function paintStats(stats) {
    const has = Boolean(stats);
    el.liveEmpty.hidden = has;
    el.liveGrid.hidden = !has;
    if (!has) return;

    el.mName.textContent = stats.name || '—';
    el.mName.title = stats.name || '';
    // 아직 시작 전이면 0 fps가 아니라 "대기"가 맞다 — 0은 멈춘 것처럼 보인다.
    el.mFps.textContent = stats.running ? `${stats.fps}` : '대기';
    el.mFrame.textContent = `${stats.frameMs.toFixed(1)}ms`;
    el.mFrame.classList.toggle('is-bad', stats.frameMs > 16.6);
    el.mLogic.textContent = `${stats.logicMs.toFixed(1)}ms`;
    el.mRender.textContent = `${stats.renderMs.toFixed(1)}ms`;
    el.mTier.textContent = stats.tier ? `T${stats.tier}` : '—';
    el.mSteps.textContent = stats.steps ? stats.steps.toLocaleString('ko-KR') : '—';
}

async function pollStats() {
    try {
        const [tab] = await api.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return paintStats(null);
        // content script가 없는 탭이면 sendMessage가 거절된다 — 작품 페이지가
        // 아닌 보통 상태라서 조용히 빈 안내를 둔다.
        const stats = await api.tabs.sendMessage(tab.id, { __eniwanvm: 'stats' }).catch(() => null);
        paintStats(stats ?? null);
    } catch {
        paintStats(null);
    }
}

// ── 시작 ─────────────────────────────────────────────────────────────────

void api.storage.local.get(DEFAULTS).then((stored) => {
    settings = {
        enabled: stored.enabled !== false,
    };
    paintSettings();
});

void pollStats();
// 팝업이 열려 있는 동안만 돈다. 닫히면 이 문서가 사라져 타이머도 함께 사라진다.
setInterval(pollStats, 500);
