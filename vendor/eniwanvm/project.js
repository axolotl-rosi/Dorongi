/* 이 파일은 public/eniwanvm/project.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
/**
 * project.json 정규화 — EniwanVM에 들어오는 모든 작품이 지나는 문.
 *
 * `.ent` 안의 `temp/project.json`은 `objects[].script`와 `functions[].content`를
 * **JSON 문자열로** 들고 있다(엔트리 편집기가 저장할 때 그렇게 넣는다). 엔진은
 * 불러올 때 이걸 파싱하지만, 서버의 `/api/load`·`/api/latest-project`는 파일에 있는
 * 그대로 돌려준다 — 문자열이다.
 *
 * 이걸 파싱하지 않으면 블록 트리를 걷는 코드가 문자열을 만나 조용히 "스크립트 없음"으로
 * 넘어간다. 실제로 그랬다: horse-restore가 명령어 53,562개에서 **44개**로, 티어 3에서
 * 티어 1로 떨어졌는데 에러는 하나도 안 났다. 그래서 분석기와 컴파일러 **입구에서**
 * 부른다 — 바깥에서 부르는 걸 잊을 수 있는 자리에 두면 같은 사고가 반복된다.
 *
 * 멱등이다. 이미 배열이면 손대지 않으므로 이중 호출 비용은 타입 검사뿐이다.
 */

/** @param {object} project 파싱된 project.json @returns {object} 같은 객체(제자리 수정) */
export function normalizeProject(project) {
    if (!project || typeof project !== 'object') return project;

    for (const object of project.objects || []) {
        if (object && typeof object.script === 'string') {
            object.script = parseOrEmpty(object.script, `objects[${object.id || '?'}].script`);
        }
    }
    for (const fn of project.functions || []) {
        if (fn && typeof fn.content === 'string') {
            fn.content = parseOrEmpty(fn.content, `functions[${fn.id || '?'}].content`);
        }
    }
    return project;
}

/**
 * 모양·소리 파일의 주소.
 *
 * 엔트리 서버에 올라간 작품은 파일을 project.json에 담지 않고 **주소만** 들고
 * 있다(`fileurl`, 없으면 `filename`에서 규칙으로 만든다). 엔진과 같은 규칙을
 * 쓴다(`Entry.defaultPath + '/uploads/' + 앞2 + '/' + 그다음2 + ...`) — 규칙이
 * 다르면 "편집기에서는 보이는데 EniwanVM에서는 안 보이는" 모양이 생긴다.
 *
 * 돌려주는 주소는 **뿌리 상대 경로**다(`/uploads/…`). playentry 안에서 돌 때
 * 같은 출처가 되어 WebGL 텍스처로 쓸 수 있고(교차 출처면 CORS에 막힌다),
 * 바깥(대시보드)에서는 호스트가 앞에 도메인을 붙인다.
 *
 * `.ent`를 로컬에서 만든 작품은 `fileurl`이 `temp/…`(tar 안의 자리)다. 그건
 * 네트워크 주소가 아니므로 `null`을 돌려준다 — 가짜 주소를 돌려주면 호스트가
 * 404를 텍스처로 올리려 들고, 화면에는 아무 설명 없이 빈 자리가 남는다.
 * @returns {string|null}
 */
export function assetSrc(asset, kind = 'image') {
    if (!asset || typeof asset !== 'object') return null;
    const url = asset.fileurl;
    if (typeof url === 'string' && url) {
        // `blob:`/`data:`는 호스트가 직접 만들어 끼운 주소다(확장이 로컬 `.ent`
        // 꾸러미에서 꺼낸 그림). 그대로 쓴다 — 같은 문맥에서 만든 주소라
        // 텍스처로 올려도 교차 출처가 되지 않는다.
        if (/^(blob:|data:)/.test(url)) return url;
        if (/^(https?:)?\/\//.test(url) || url.startsWith('/')) return url;
        // `temp/…` 같은 꾸러미 안의 상대 경로. 여기서 끝낸다 — **filename 규칙으로
        // 넘기지 않는다.** 로컬에서 만든 그림도 `filename`은 들고 있어서, 규칙을
        // 적용하면 서버에 없는 `/uploads/…` 주소가 멀쩡한 모양처럼 나온다. 그러면
        // 관문은 "그릴 모양이 있다"로 보고 통과시키고, 화면은 404 16개로 텅 빈다.
        return null;
    }
    const name = asset.filename;
    if (typeof name !== 'string' || name.length < 4) return null;
    const ext = kind === 'sound'
        ? (typeof asset.ext === 'string' && asset.ext ? asset.ext : '.mp3')
        : `.${asset.imageType || 'png'}`;
    const dir = kind === 'sound' ? 'sound' : 'image';
    return `/uploads/${name.slice(0, 2)}/${name.slice(2, 4)}/${dir}/${name}${ext}`;
}

/**
 * 오브젝트의 **처음 상태와 에셋 목록**을 뽑는다.
 *
 * 컴파일러는 블록만 보고, 좌표·방향·크기·모양 같은 "처음 어떻게 놓여 있었나"는
 * 여기서 한 번에 모은다. 엔트리의 size는 퍼센트가 아니라 **픽셀 평균**
 * ((가로·|scaleX| + 세로·|scaleY|)/2, 엔진 `getSize`)이라, 모양 크기를 같이
 * 들고 있어야 `크기를 100으로` 블록이 맞는 값을 낸다.
 */
export function stageOf(project) {
    // 장면 목록. 엔진은 **지금 장면의 오브젝트만** 그리고 돌리므로(`장면 시작하기`가
    // 이걸 갈아탄다), 목록과 순서를 그대로 들고 와야 한다.
    //
    // 장면이 적혀 있지 않은 작품(테스트에서 손으로 만든 project나 아주 옛
    // 작품)은 **장면 하나짜리**로 본다 — 그러면 모든 오브젝트가 그 장면에
    // 속해 예전과 똑같이 돈다.
    let sceneList = (project?.scenes || []).map((s, i) => ({
        id: String(s?.id ?? ''),
        name: String(s?.name ?? `장면 ${i + 1}`),
    }));
    // The public project query used by a player may omit the scenes array even
    // though every object still carries its scene id. Treat distinct ids as
    // real scenes; otherwise backgrounds from scene A cover the renderer in
    // scene B and start_scene can only restart a fake single scene.
    if (!sceneList.length) {
        const inferred = [];
        const seen = new Set();
        for (const object of project?.objects || []) {
            const id = String(object?.scene ?? '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            inferred.push({ id, name: `장면 ${inferred.length + 1}` });
        }
        if (inferred.length > 1) sceneList = inferred;
    }
    const scenes = sceneList.length ? sceneList : [{ id: '', name: '장면 1' }];
    const sceneOf = new Map(scenes.map((s, i) => [s.id, i]));

    const objects = (project?.objects || []).map((object, index) => {
        const sprite = object?.sprite || {};
        const e = object?.entity || {};
        const pictures = (sprite.pictures || []).map((p) => ({
            id: String(p?.id ?? ''),
            name: String(p?.name ?? ''),
            width: Number(p?.dimension?.width) || 0,
            height: Number(p?.dimension?.height) || 0,
            src: assetSrc(p, 'image'),
        }));
        const sounds = (sprite.sounds || []).map((s) => ({
            id: String(s?.id ?? ''),
            name: String(s?.name ?? ''),
            duration: Number(s?.duration) || 0,
            src: assetSrc(s, 'sound'),
        }));
        let shape = pictures.findIndex((p) => p.id === String(object?.selectedPictureId ?? ''));
        if (shape < 0) shape = pictures.length ? 0 : -1;
        return {
            index,
            id: String(object?.id ?? `object${index}`),
            name: String(object?.name ?? `object${index}`),
            objectType: object?.objectType === 'textBox' ? 'textBox' : 'sprite',
            // 회전 방식. 'free'가 아니면 엔진은 회전을 **0으로 눌러** 두고,
            // 'vertical'에서는 이동방향을 바꿀 때 돌지 않고 좌우로 뒤집는다.
            // 이걸 안 들고 오면 좌우회전 오브젝트가 EniwanVM에서만 빙빙 돈다.
            rotateMethod: object?.rotateMethod === undefined ? 'free' : String(object.rotateMethod),
            scene: String(object?.scene ?? ''),
            // 목록에 없는 장면 id를 든 오브젝트는 첫 장면으로 본다 — 어디에도
            // 안 속하게 두면 그 오브젝트는 영원히 안 보이고 코드도 안 돈다.
            sceneIndex: sceneOf.get(String(object?.scene ?? '')) ?? 0,
            pictures,
            sounds,
            start: {
            shape,
                x: Number(e.x) || 0,
                y: Number(e.y) || 0,
                rotation: Number(e.rotation) || 0,
                // 엔트리 기본 이동방향은 90(오른쪽)이다. 0으로 떨어뜨리면
                // `이동 방향으로 10 움직이기`가 전부 위로 간다.
                direction: e.direction === undefined ? 90 : Number(e.direction) || 0,
                scaleX: e.scaleX === undefined ? 1 : Number(e.scaleX) || 0,
                scaleY: e.scaleY === undefined ? 1 : Number(e.scaleY) || 0,
                width: Number(e.width) || (shape >= 0 ? pictures[shape].width : 0),
                height: Number(e.height) || (shape >= 0 ? pictures[shape].height : 0),
                visible: e.visible === undefined ? true : !!e.visible,
                text: String(e.text || object?.text || ''),
                font: String(e.font || object?.font || ''),
                fontSize: Number(e.fontSize || object?.fontSize) || 12,
                color: String(e.colour || e.fontColour || object?.colour || object?.fontColour || '#000000'),
                background: String(e.bgColor || object?.bgColor || 'transparent'),
                textAlign: Number(e.textAlign ?? object?.textAlign) || 0,
                lineBreak: Boolean(e.lineBreak ?? object?.lineBreak),
                underline: Boolean(e.underline ?? e.underLine ?? object?.underline ?? object?.underLine),
                strike: Boolean(e.strike ?? object?.strike),
                // 회전·크기의 중심(엔진 regX/regY, **모양 픽셀 좌표**). 거의 항상
                // 모양의 가운데(= 폭/2)지만, 다른 값이면 그 오브젝트만 엉뚱한 데를
                // 축으로 돈다. 기본값은 가운데로 둔다 — 엔진도 모양을 바꿀 때
                // `폭/2 + (이전 regX - 이전 폭/2)`로 **중심에서의 치우침**을 보존한다.
                regX: e.regX === undefined ? null : Number(e.regX) || 0,
                regY: e.regY === undefined ? null : Number(e.regY) || 0,
            },
        };
    });
    return { objects, scenes };
}

function parseOrEmpty(text, where) {
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        // 삼켜 버리면 "블록이 없는 작품"으로 보인다. 어디가 깨졌는지 말해 준다.
        throw new Error(`project.json 정규화 실패 — ${where}: ${e.message}`);
    }
}

export default normalizeProject;
