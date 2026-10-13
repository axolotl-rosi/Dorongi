/**
 * 로그인한 사람의 닉네임을 **한 번만** 묻는다.
 *
 * 엔트리의 `닉네임` 블록은 `window.user.nickname`을 읽는다(로그인 전에는
 * 공백 한 칸). 우리 실행기는 엔진을 띄우지 않으므로 그 값을 직접 받아 와
 * `HOST_NICKNAME` 슬롯에 넣어 둔다 — 블록이 읽을 때마다 묻지 않는다:
 * 닉네임은 실행 중에 바뀌지 않고, 매 프레임 네트워크를 때리면 그게 곧
 * "EniwanVM을 켜면 엔트리가 느려진다"가 된다.
 *
 * 비밀값 다루기:
 *   - 토큰은 **이 페이지 문맥 안에서만** 쓴다. 콘솔에 찍지 않고, postMessage나
 *     확장의 다른 문맥(콘텐츠 스크립트·팝업)으로 내보내지 않는다. 밖으로
 *     나가는 것은 돌려받은 닉네임 문자열뿐이다.
 *   - 토큰이 없으면(로그아웃·다른 페이지) 헤더에 **빈 값을 넣지 않고 아예
 *     뺀다.** 빈 헤더는 서버 로그에 "토큰 깨짐"처럼 남아 원인을 흐린다.
 *   - 실패는 삼킨다. 닉네임을 못 받은 것 때문에 작품이 안 돌면 안 된다 —
 *     엔진의 로그아웃 기본값(공백 한 칸)을 그대로 돌려준다.
 */

const GRAPHQL_URL = '/graphql';

/** 로그아웃 상태의 엔진 기본값(`window.user ? … : ' '`). */
export const ANONYMOUS_NICKNAME = ' ';

/**
 * 닉네임만 묻는다.
 *
 * 프로필 사진은 묻지 않는다 — 엔트리에 그 값을 읽는 블록이 없어서 쓸 데가
 * 없고, graphql은 모르는 필드 하나에 **질의 전체**를 거절하므로 쓰지도 않는
 * 필드를 끼워 넣으면 닉네임까지 같이 날아간다.
 */
const SELECT_ME = 'query SELECT_ME { user { nickname } }';

/** sessionStorage는 시크릿 모드·샌드박스에서 던질 수 있다. 없으면 없는 것으로 본다. */
function sessionValue(key) {
    try {
        const value = sessionStorage.getItem(key);
        return typeof value === 'string' && value ? value : '';
    } catch {
        return '';
    }
}

/**
 * @param {object} [deps] 테스트에서 갈아끼우는 자리(fetch·토큰 읽기)
 * @returns {Promise<string>} 닉네임, 못 받으면 `' '`
 */
export async function fetchNickname({ fetchImpl, token, csrf } = {}) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    const xToken = token === undefined ? sessionValue('entry_xToken') : token;
    const csrfToken = csrf === undefined ? sessionValue('entry_csrfToken') : csrf;

    const headers = { 'content-type': 'application/json' };
    if (xToken) headers['x-token'] = xToken;
    if (csrfToken) headers['csrf-token'] = csrfToken;

    try {
        const response = await doFetch(GRAPHQL_URL, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({ query: SELECT_ME }),
        });
        if (!response.ok) return ANONYMOUS_NICKNAME;
        const body = await response.json();
        const nickname = body?.data?.user?.nickname;
        return typeof nickname === 'string' && nickname ? nickname : ANONYMOUS_NICKNAME;
    } catch {
        // 네트워크·파싱 실패. 여기서 던지면 작품이 아예 안 올라간다.
        return ANONYMOUS_NICKNAME;
    }
}

export default fetchNickname;
