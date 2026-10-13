/**
 * playentry.org의 graphql에서 작품 데이터를 그대로 읽는다.
 *
 * 돌려받는 것은 `.ent` 안의 `temp/project.json`과 같은 모양이다 — 그래서 변환기를
 * 따로 두지 않는다. `objects[].script`와 `functions[].content`가 **JSON 문자열**로
 * 오는 것까지 같고, 그 파싱은 EniwanVM 입구(`vendor/eniwanvm/project.js`)가 한다.
 *
 * 에셋 주소를 여기서 만들지는 않는다. 주소는 `objects[].sprite.pictures[]`에 이미
 * 들어 있고(`fileurl`/`filename`), 그 규칙을 아는 곳은 EniwanVM 입구
 * (`vendor/eniwanvm/project.js`의 `assetSrc`) 한 곳이다 — 규칙이 두 곳에 있으면
 * "편집기에서는 보이는데 실행기에서는 안 보이는" 모양이 생긴다.
 */

const GRAPHQL_URL = '/graphql/SELECT_PROJECT';

/** EniwanVM이 읽는 필드(objects·variables·functions) + 화면에 띄울 이름/썸네일. */
const SELECT_PROJECT = (extra = '') => `query SELECT_PROJECT($id: ID!, $groupId: ID) {
  project(id: $id, groupId: $groupId) {
    id
    name
    thumb
    objects
    variables
    functions${extra}
  }
}`;

/**
 * 장면 목록은 **있으면 받는다**.
 *
 * graphql은 모르는 필드 하나에 질의 **전체**를 거절한다. 엔트리가 이 필드를
 * 지금 주는지(또는 이름이 바뀌는지)는 서버 스키마에 달려 있으므로, 받아 보고
 * 거절당하면 장면 없이 한 번 더 묻는다 — 스키마가 바뀐 날 작품이 아예 안
 * 열리는 쪽보다, 장면 하나짜리로 도는 쪽이 낫다.
 */
const SCENES_FIELD = '\n    scenes';

/** 엔트리 자신의 csrf 방어. 이 헤더가 없으면 graphql이 "form tampered with"로 거절한다. */
function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content ?? '';
}

/**
 * 작품 썸네일을 그릴 주소, 신뢰할 수 없으면 null.
 *
 * `thumb`은 작품이 들고 있는 데이터라 작성자가 아무 곳이나 가리킬 수 있다. 바깥을
 * 가리키는 값은 보는 사람의 브라우저가 그 호스트를 호출하게 만들므로 버린다.
 * 남은 것은 파싱해서 돌려주므로, `url("...")` 안에 들어가도 따옴표나 괄호로
 * 빠져나갈 조각이 남지 않는다.
 */
export function thumbUrl(thumb) {
    if (typeof thumb !== 'string' || !thumb) return null;
    try {
        const url = new URL(thumb, location.origin);
        return url.origin === location.origin ? url.href : null;
    } catch {
        return null;
    }
}

async function ask(query, id, groupId, fetchImpl) {
    const response = await fetchImpl(GRAPHQL_URL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'csrf-token': csrfToken() },
        body: JSON.stringify({ query, variables: { id, groupId } }),
    });
    if (!response.ok) throw new Error(`작품을 불러오지 못했습니다 (HTTP ${response.status})`);
    const body = await response.json();
    return { work: body.data?.project, failure: body.errors?.[0]?.message };
}

export async function fetchWork(id, groupId = null, { fetchImpl } = {}) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    let { work, failure } = await ask(SELECT_PROJECT(SCENES_FIELD), id, groupId, doFetch);
    // 장면 필드 때문에 거절당했으면 그것만 빼고 다시 묻는다. 작품이 없거나
    // 비공개여서 거절당한 경우에는 다시 물어도 같은 답이 오므로, 두 번째
    // 응답의 실패 문구를 그대로 사람에게 보여 준다.
    if (!work && failure) {
        ({ work, failure } = await ask(SELECT_PROJECT(), id, groupId, doFetch));
    }
    if (failure) throw new Error(failure);
    if (!work) throw new Error('작품을 찾을 수 없습니다 (비공개이거나 삭제된 작품일 수 있습니다)');
    return work;
}
