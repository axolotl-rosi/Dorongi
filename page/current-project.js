/**
 * Read the project that is already open in Entry's workspace.
 *
 * This module runs in the page world (page/main.js is injected as a module), so
 * it can see window.Entry. Reading the model directly keeps unsaved edits and
 * avoids downloading the last published copy through GraphQL.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function call(object, name, fallback) {
    try {
        const fn = object?.[name];
        return typeof fn === 'function' ? fn.call(object) : fallback;
    } catch {
        return fallback;
    }
}

function detachedJSON(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

export function isWorkspacePage(locationLike = globalThis.location) {
    return /^\/ws(?:\/|$)/.test(String(locationLike?.pathname ?? ''));
}

/**
 * Take a side-effect-free snapshot. Entry.exportProject() stops a running
 * project, so we intentionally use the same serializers without calling it.
 */
export function snapshotEntryProject(projectId, root = globalThis) {
    const Entry = root?.Entry;
    const workspace = isWorkspacePage(root?.location);
    if (!Entry?.container || !Entry?.scene || !Entry?.variableContainer) return null;

    const loadedId = Entry.projectId == null ? '' : String(Entry.projectId);
    const requestedId = projectId == null ? '' : String(projectId);
    // Outside the editor, only accept an exact project match. In /ws the live
    // workspace is authoritative, including imported and not-yet-saved work.
    if (!workspace && requestedId && loadedId !== requestedId) return null;

    const objects = call(Entry.container, 'toJSON', null);
    if (!Array.isArray(objects) || objects.length === 0) return null;

    const project = {
        objects,
        scenes: call(Entry.scene, 'toJSON', []),
        variables: call(Entry.variableContainer, 'getVariableJSON', []),
        messages: call(Entry.variableContainer, 'getMessageJSON', []),
        functions: call(Entry.variableContainer, 'getFunctionJSON', []),
        tables: call(root.DataTable ?? Entry.DataTable, 'getTableJSON', []),
        speed: Number.isFinite(Entry.FPS) ? Entry.FPS : 60,
        interface: call(Entry, 'captureInterfaceState', undefined),
        expansionBlocks: Entry.expansionBlocks ?? [],
        aiUtilizeBlocks: Entry.aiUtilizeBlocks ?? [],
        hardwareLiteBlocks: Entry.hardwareLiteBlocks ?? [],
        learning: call(Entry.aiLearning, 'toJSON', undefined),
        externalModules: root.entryModuleLoader?.moduleList ?? [],
        externalModulesLite: root.entryModuleLoader?.moduleListLite ?? [],
    };

    const detached = detachedJSON(project);
    if (!detached?.objects?.length) return null;
    return {
        project: detached,
        name: String(Entry.projectName ?? root.document?.title ?? projectId ?? 'Entry project'),
        source: 'entry-memory',
    };
}

/** Wait briefly only in the editor, where Entry may still be initializing. */
export async function readCurrentEntryProject(projectId, root = globalThis, timeoutMs = 1200) {
    const workspace = isWorkspacePage(root?.location);
    const deadline = Date.now() + (workspace ? Math.max(0, timeoutMs) : 0);
    let firstAttempt = true;
    while (firstAttempt || (workspace && Date.now() < deadline)) {
        firstAttempt = false;
        const snapshot = snapshotEntryProject(projectId, root);
        if (snapshot) return snapshot;
        if (!workspace) break;
        await sleep(25);
    }
    return null;
}
