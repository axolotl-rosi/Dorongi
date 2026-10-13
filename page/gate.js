/**
 * 호환성 관문 — "이 작품을 EniwanVM으로 돌려도 되는가".
 *
 * EniwanVM은 엔트리의 대체 런타임이 아니다. 변수·리스트·연산·제어·펜·도형·글상자·
 * 키/마우스·소리·복제본·**모양(스프라이트) 그림**·장면·대화·대답까지는 있다.
 * 모양은 2026-10부터 그린다(`sprite-pass.js`) — 상태(모양 번호·효과·크기·뒤집기)는
 * 전부터 VM이 들고 있었고, 거기에 텍스처 패스가 붙었다. 그래서 "모양으로 그리니까
 * 물러난다"는 판정은 더 이상 쓰지 않는다. 대신 **그 모양을 받을 수 있는지**를 본다
 * — 받을 수 없는 그림은 그려도 빈 자리다.
 *
 * 빈 무대는 "느린 것보다 나쁜" 결과다. 사용자는 확장이 깨졌다고 생각하고, 작품은
 * 볼 수 없게 된다. 그래서 얹기 전에 여기서 걸러 **엔트리 원본으로 돌려보낸다.**
 *
 * 판정은 추측이 아니라 두 산출물로 한다:
 *   - `analyzeProject()`의 metrics — 작품이 **무엇을 그리는지**
 *   - `compileProject()`의 unsupported — 컴파일러가 **무엇을 못 옮겼는지**
 *
 * 순수 함수다(DOM·전역 없음). 검증 스크립트가 실제 `.ent`들을 먹여서 같은 판정을
 * 확인한다 — 화면에서만 돌아가는 판정은 회귀를 못 잡는다.
 */

/** 미지원 블록 목록을 "type ×개" 몇 개까지 보여 줄지. 나머지는 "…외 N종". */
const NAMES_SHOWN = 3;

/**
 * @param {{analysis: {metrics: object}, program: {unsupported?: {type:string,count:number}[],
 *   unsupportedTotal?: number, threads?: unknown[]}, force?: boolean}} input
 * @returns {{run: boolean, reason: string, code: string}}
 *   `run`이 false면 호출자는 iframe에 주소를 돌려줘야 한다. `reason`은 사용자에게
 *   그대로 보여 줄 한 줄, `code`는 검증·집계용 기계 이름이다.
 */
export function decideGate({ analysis, program, force = false }) {
    const m = analysis?.metrics ?? {};

    // 1. 그릴 것이 없다 — 가장 확실한 탈락 사유. 빈 무대는 "느린 것보다 나쁜"
    //    결과라 여기서 먼저 걸러낸다.
    //    세는 것은 셋이다: 펜·채우기·**받을 수 있는 모양 주소**. 모양 주소를
    //    같이 세는 이유는, 모양 패스가 받지 못한 그림을 그릴 수는 없기 때문이다
    //    (로컬에서 만든 `.ent`는 주소가 꾸러미 안의 `temp/…`다).
    const draws = (m.penTotal || 0) + (m.fillTotal || 0) + (m.pictureTotal || 0);
    if (draws === 0) {
        return {
            run: false,
            code: 'no-draw',
            reason: '그릴 모양도 펜 그림도 없습니다 — 엔트리 원본으로 실행합니다',
        };
    }

    // 2. 받을 수 없는 모양이 하나라도 있다 — 로컬에서 만든 `.ent`가 여기 온다
    //    (그림이 꾸러미 안에만 있고 엔트리 서버에는 없다). 1번을 통과해 버리는
    //    경우가 실제로 있다: 펜으로 선 몇 개를 그리는 작품이면 "그릴 것은 있다"가
    //    되지만 등장인물은 전부 안 보인다. 반쯤 빈 무대도 빈 무대다.
    //
    //    서버 작품은 모든 모양에 `/uploads/…` 주소가 있어서 이 조건에 걸리지
    //    않는다. 걸린다면 주소 규칙이 바뀐 것이고, 그때도 느린 원본이 맞는 답이다.
    if ((m.pictureMissing || 0) > 0) {
        return {
            run: false,
            code: 'local-picture',
            reason: '받을 수 없는 모양이 있습니다 (로컬에서 만든 그림) — 엔트리 원본으로 실행합니다',
        };
    }

    // 3. 복제본은 2026-10부터 VM이 직접 돌린다(개체 테이블 + 행 재사용). 그래서
    //    여기서 막지 않는다 — 대신 복제 상한을 넘겨 못 만든 복제본은 VM 통계
    //    `overruns`에 남으므로, 조용히 틀리는 게 아니라 숫자로 보인다.
    //    복제 블록 자체를 못 옮긴 경우는 아래 4번(미지원)이 그대로 잡는다.

    // 4. 컴파일러가 못 옮긴 블록. 하나라도 있으면 기본적으로 물러난다.
    const unsupportedTotal = program?.unsupportedTotal || 0;
    if (unsupportedTotal > 0 && !force) {
        return {
            run: false,
            code: 'unsupported',
            reason: `옮기지 못한 블록이 있습니다 (${describeUnsupported(program.unsupported)}) — 엔트리 원본으로 실행합니다`,
        };
    }

    // 5. 컴파일은 됐는데 실행할 스레드가 없다. 시작 블록이 없는 작품이 여기 온다.
    if (Array.isArray(program?.threads) && program.threads.length === 0) {
        return {
            run: false,
            code: 'no-thread',
            reason: '실행할 시작 블록이 없습니다 — 엔트리 원본으로 실행합니다',
        };
    }

    return { run: true, code: force && unsupportedTotal > 0 ? 'forced' : 'ok', reason: '' };
}

/** "locate_xy ×12, sound_something ×3 외 2종" */
export function describeUnsupported(list) {
    const items = Array.isArray(list) ? list : [];
    if (items.length === 0) return '종류 불명';
    const shown = items.slice(0, NAMES_SHOWN).map((u) => `${u.type} ×${u.count}`);
    const rest = items.length - shown.length;
    return rest > 0 ? `${shown.join(', ')} 외 ${rest}종` : shown.join(', ');
}

export default decideGate;
