/**
 * Workflow owner = the robot (spec 2026-10-29 workflow-robot-owner): the pure parts -- the list row's robot and lock
 * marks, the Owner select's state, the owner change's preview as dialog lines, and the chat save_workflow refusal of a
 * locked robot workflow. The editor (workflow-editor.js) and chat.js do the DOM and the API calls.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.RobotOwner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

    /** Robot-owned and running: read-only everywhere until someone unlocks it. */
    function isLocked(wf) {
        return !!(wf?.is_robot && wf?.locked);
    }

    /** The list row's marks: 🤖 on a robot workflow, 🔒 beside it while it runs; '' on a personal one. */
    function rowMarks(wf, t) {
        if (!wf?.is_robot) return '';
        const robot = `<span class="flex-shrink-0" title="${esc(t('workflow.owner.robot'))}">🤖</span>`;
        return isLocked(wf) ? `${robot}<span class="flex-shrink-0" title="${esc(t('workflow.lock.banner'))}">🔒</span>` : robot;
    }

    /** The Owner select: only for a caller who may use the robot (GET /robot can_use); "Robot", read-only, once it is the robot's. */
    function ownerView(robot, wf) {
        if (!robot?.can_use) return { show: false };
        return wf?.is_robot ? { show: true, value: 'robot', disabled: true } : { show: true, value: 'me', disabled: false };
    }

    /** PUT /owner {confirm:false}'s preview as confirmation lines: the workflows sharing what moves, the servers the robot lacks. */
    function previewLines(preview, t) {
        return [
            ...(preview?.shared_with || []).map((w) => t('workflow.owner.confirmShared', { name: w.name })),
            ...(preview?.needs_servers || []).map((name) => t('workflow.owner.confirmServers', { name })),
        ];
    }

    /** The names the robot already has: the change is refused until they are renamed. */
    function clashLines(preview, t) {
        return (preview?.clashes || []).map((c) => t('workflow.owner.clash', { kind: c.kind, name: c.name }));
    }

    /**
     * A run door that looks disabled while the workflow is locked: one that runs in the browser (a prompt-mode ▶, a
     * swarm's or an ingestion's Start, an audio workflow's ▶). ■ on an active workflow opens the live view: kept.
     */
    function runDoorDisabled(locked, { button, swarm, ingestion, realtime } = {}) {
        return !!locked && !!(realtime || swarm || ingestion || button === 'run');
    }

    /**
     * chat save_workflow onto an existing workflow: a locked robot workflow is refused with the lock message, never
     * stopped (spec: the person unlocks deliberately). `apiJson(method, path)` → {ok, status, json}. Null = go on.
     */
    async function chatSaveRefusal(apiJson, workflowId) {
        const r = await apiJson('GET', `/workflows/${workflowId}`);
        const wf = r?.ok ? r.json?.data : null;
        if (!isLocked(wf)) return null;
        return { success: false, error_code: 'locked',
            error: `${wf.name || `Workflow #${workflowId}`} is running as the robot. Unlock it first.` };
    }

    return { isLocked, runDoorDisabled, rowMarks, ownerView, previewLines, clashLines, chatSaveRefusal };
});
