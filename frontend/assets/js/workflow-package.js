/**
 * Workflow packages: pure helpers that find what a workflow depends on (skills, MCP servers, code
 * components, playbooks) so it can be exported as a zip with those dependencies and imported elsewhere.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.WorkflowPackage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const INGESTION_TYPES = ['loader', 'splitter', 'vectorstore'];

    const isId = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

    /**
     * What `nodes` (exportWorkflow().nodes) need. ctx.toolServers maps a tool name to the servers
     * offering it; ctx.serverNameById maps a registered server id to its name.
     */
    function collectDependencies(nodes, ctx) {
        const skills = new Set(), servers = new Set(), components = new Set(), playbooks = new Set();
        const warnings = [];
        let playbookAtRunTime = false;
        const toolServers = (ctx && ctx.toolServers) || new Map();
        const serverNameById = (ctx && ctx.serverNameById) || new Map();

        for (const node of nodes || []) {
            const cfg = node.config || {};
            const type = node.node_type;

            if (type === 'agent') {
                if (cfg.bound_skill && cfg.bound_skill.dir_name) skills.add(cfg.bound_skill.dir_name);
                for (const tool of cfg.tools || []) {
                    const owners = toolServers.get(tool) || [];
                    if (!owners.length) {
                        warnings.push({ kind: 'tool-missing', node: node.id, message: `Tool "${tool}" is offered by no registered server; nothing was bundled for it.` });
                        continue;
                    }
                    owners.forEach((s) => servers.add(s));
                    if (owners.length > 1) warnings.push({ kind: 'tool-ambiguous', node: node.id, message: `Tool "${tool}" is offered by several servers (${owners.join(', ')}); all were bundled.` });
                }
            }
            if (type === 'code') (cfg.mcp_servers || []).forEach((s) => servers.add(s));
            if (INGESTION_TYPES.includes(type) && typeof cfg.store === 'string') {
                const m = /^mcp:(\d+)$/.exec(cfg.store);
                const name = m && serverNameById.get(Number(m[1]));
                if (name) servers.add(name);
            }
            if (isId(cfg.code_component_id)) components.add(Number(cfg.code_component_id));
            if (type === 'start' && isId(cfg.start_option)) components.add(Number(cfg.start_option));
            if ((type === 'playbook' || type === 'agent') && isId(cfg.playbook_id)) playbooks.add(Number(cfg.playbook_id));
            if (type === 'playbook' && cfg.playbook_source === 'input') playbookAtRunTime = true;
        }

        const byNumber = (a, b) => a - b;
        return {
            skills: [...skills].sort(),
            servers: [...servers].sort(),
            components: [...components].sort(byNumber),
            playbooks: [...playbooks].sort(byNumber),
            playbookAtRunTime,
            warnings,
        };
    }

    return { collectDependencies };
});
