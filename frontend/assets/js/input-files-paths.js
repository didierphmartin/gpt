/**
 * Which input_files keys a skill run may stage (main thread: pyodide-runner.js; worker: pyodide.worker.js).
 *
 * A key is the absolute path the file is written to before the script runs (/scratch/<name> by
 * convention, as the run_skill_script schema says). A key that is not a usable path is refused
 * with a message for the model, and nothing runs:
 *   - a relative key would land in the skill folder, which in folder mode is the user's real
 *     folder on disk (a stray spec file ended up in a skill's source that way);
 *   - a key that is really content (a model put part of a JSON spec where the path goes) became
 *     a file whose name the browser's File System Access API refuses ("Name is not allowed")
 *     every time Pyodide synced the mount, so every later skill run on the page failed until a reload.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.InputFilesPaths = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    const MAX_NAME = 255;

    /** Why `key` cannot be staged, or null when it can. `mount` is the skill folder (/skill/<dir>). */
    function problem(key, mount) {
        const p = String(key).trim();
        if (!p) return 'the path is empty';
        if (/[\u0000-\u001f\u007f"]/.test(p)) return 'it contains a quote or a line break, so it looks like file content, not a path';
        if (!p.startsWith('/')) return 'it is not an absolute path';
        const parts = p.split('/').filter(Boolean);
        if (!parts.length) return 'it names no file';
        if (parts.includes('..')) return 'it contains ".."';
        if (parts.some((s) => s.length > MAX_NAME)) return `a name in it is longer than ${MAX_NAME} characters`;
        if (p === '/skill' || p.startsWith('/skill/') || (mount && (p === mount || p.startsWith(`${mount}/`)))) {
            return 'it is inside the skill folder, which input files must not change';
        }
        return null;
    }

    /** The message for the model when any key of `inputFiles` is refused, else null. */
    function refusal(inputFiles, mount) {
        if (!inputFiles || typeof inputFiles !== 'object') return null;
        const bad = [];
        for (const key of Object.keys(inputFiles)) {
            const why = problem(key, mount);
            if (why) bad.push(`"${shorten(key)}": ${why}`);
        }
        if (!bad.length) return null;
        return 'input_files refused, nothing was run. Each key must be the absolute path to write '
            + 'and each value the file\'s content, e.g. {"/scratch/spec.json": "{\\"name\\": \\"...\\"}"}.\n'
            + bad.map((b) => `- ${b}`).join('\n')
            + '\nCall run_skill_script again with the content under a /scratch/<name> key.';
    }

    function shorten(key) {
        const s = String(key).replace(/\s+/g, ' ').trim();
        return s.length > 60 ? `${s.slice(0, 57)}...` : s;
    }

    return { problem, refusal };
}));
