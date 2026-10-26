import { readFileSync } from 'node:fs';
import { count, empty, entries, has, is_array, isEmptyArr, preg_replace, strtolower, strval, values } from './php';
import { CompiledA2AEmit } from './CompiledA2AEmit';
import { LangGraphPackage } from './LangGraphPackage';
import { EnvVars, PackageDocs } from './PackageDocs';
import { PlaybookEmit } from './PlaybookEmit';
import { PythonEmitHelpers } from './PythonEmitHelpers';
import { PythonRequirements } from './PythonRequirements';
import * as path from 'node:path';

/** frontend/assets/py/code_node_harness.py (PHP: HARNESS, from backend/src/AgentTeam/Services). */
const HARNESS = path.resolve(__dirname, '../../../../frontend/assets/py/code_node_harness.py');

/** A compile target, as CompiledPackage reads it (ADKPackage.TARGET, MAFGenerator.TARGET, NOOAGenerator.TARGET). */
export type CompiledTarget = { key: string; title: string; framework: readonly string[] };

/**
 * The files that make a compiled ADK, MAF or NOOA program run on its own, in its own folder, as LangGraph's
 * packages do: requirements.txt, .env.example, README.md and, for a package, the code-node harness (a copy,
 * code_harness.py), each code node's code (code/), each used skill's folder (skills/) and the Start's
 * documents (start_documents/). workflow.py, common.py and api.py are the target generator's.
 * layout: 'single' | 'modular' | 'a2a'. Mirrors backend/src/AgentTeam/Services/CompiledPackage.php.
 */
export class CompiledPackage
{
    /** What every compiled program imports besides its framework: the MCP client and .env. */
    private static readonly BASE_REQUIREMENTS = ['httpx', 'python-dotenv'];

    /** A package's run server (api.py; an A2A agent server serves with uvicorn too). */
    private static readonly SERVER_REQUIREMENTS = ['fastapi', 'uvicorn'];

    /** The A2A package: its servers are A2A servers, its orchestrator their client. */
    private static readonly A2A_REQUIREMENTS = ['a2a-sdk[http-server]'];

    /** The TO RUN install line of a package's files: the package's requirements.txt holds the list. */
    static readonly PIP_REQUIREMENTS = 'pip install -r requirements.txt';

    /**
     * @param analyzed the generator's analysis, with 'startDocuments' already pointing at start_documents/
     * @param documentFiles the start_documents/ entries (LangGraphPackage::startDocuments()['files'])
     * @return list of {path, code, encoding?}
     */
    static async files(analyzed: any, skillsRoot: string, documentFiles: any, target: CompiledTarget,
        layout: string = 'modular'): Promise<any[]> {
        const skills: any = await LangGraphPackage.skillFiles({ agentData: analyzed['agents'] ?? [] }, skillsRoot);
        const out: any[] = CompiledPackage.docFiles(analyzed, target, layout, values(skills),
            CompiledPackage.folder(analyzed, target, layout), layout === 'a2a' ? 'orchestrator.py' : 'workflow.py');
        if (!isEmptyArr(analyzed['code'] ?? [])) {
            let harness: string;
            try {
                harness = readFileSync(HARNESS, 'utf8');
            } catch {
                throw new Error('code node harness not found (frontend/assets/py/code_node_harness.py)');
            }
            out.push({ path: 'code_harness.py', code: harness });
            for (const [nid, cd] of entries(analyzed['code'])) {
                out.push(LangGraphPackage.codeFile(strval(nid), cd, CompiledPackage.isTrigger(analyzed, strval(nid))));
            }
        }
        for (const f of values(skills)) {
            out.push(f['entry']);
        }
        for (const f of values(documentFiles)) {
            out.push(f);
        }
        return out;
    }

    /**
     * The files a single-file export carries beside its script (filename): requirements.txt, .env.example and
     * README.md (the script reads the .env next to it first).
     */
    static singleFiles(analyzed: any, target: CompiledTarget, filename: string): any[] {
        return CompiledPackage.docFiles(analyzed, target, 'single', [], filename.replace(/\.py$/, ''), filename);
    }

    /** The folder a layout export unzips to: the package's root, the single file's name. */
    private static folder(analyzed: any, target: CompiledTarget, layout: string): string {
        return preg_replace('/[^a-z0-9_]+/i', '_', strtolower(strval(analyzed['workflow']['name']))) + '_' + target.key
            + (layout === 'a2a' ? '_a2a' : '');
    }

    private static docFiles(analyzed: any, target: CompiledTarget, layout: string, skillFiles: any[], folder: string,
        entry: string): any[] {
        return [
            { path: 'requirements.txt', code: PythonRequirements.txt(CompiledPackage.requirementNames(analyzed, target, layout, skillFiles)) },
            { path: '.env.example', code: PackageDocs.envExample(strval(analyzed['workflow']['name']), CompiledPackage.envVariables(analyzed),
                CompiledPackage.optionalEnv(analyzed, layout)) },
            { path: 'README.md', code: CompiledPackage.readme(analyzed, target, layout, folder, entry) },
        ];
    }

    /** code/<file> of a code node, as files() writes it. */
    static codePath(analyzed: any, nid: string): string {
        return LangGraphPackage.codeFile(nid, analyzed['code'][nid], CompiledPackage.isTrigger(analyzed, nid))['path'];
    }

    /** The Start option's hidden code node (StartOptionGraph) carries its trigger in its config. */
    private static isTrigger(analyzed: any, nid: string): boolean {
        const node = has(analyzed['byId'], nid) ? analyzed['byId'][nid] : null;
        const cfg = node !== null && has(node, 'config') ? node['config'] : null;
        return is_array(cfg !== null && has(cfg, 'start_trigger') ? cfg['start_trigger'] : null);
    }

    private static providers(analyzed: any): string[] {
        const p = new Set<string>();
        for (const d of [...values(analyzed['agents'] ?? []), ...values(analyzed['playbooks'] ?? [])]) {
            if ((d['provider'] ?? '') !== '') {
                p.add(strtolower(strval(d['provider'])));
            }
        }
        return [...p];
    }

    /**
     * The packages a target program of layout imports: the one list its requirements.txt, its TO RUN install
     * line and its README come from. skillFiles: the skills the package carries (their SKILL.md dependencies);
     * the single file reads its skills from the editor's folder and installs their dependencies at the first run.
     */
    static requirementNames(analyzed: any, target: CompiledTarget, layout: string, skillFiles: any[] = []): string[] {
        const req: string[] = [...target.framework, ...CompiledPackage.BASE_REQUIREMENTS];
        if (layout !== 'single') req.push(...CompiledPackage.SERVER_REQUIREMENTS);
        if (layout === 'a2a') req.push(...CompiledPackage.A2A_REQUIREMENTS);
        // A playbook node runs the shared interpreter (langchain-core + langgraph + its provider's package).
        req.push(...PlaybookEmit.requirementNames(analyzed));
        for (const f of skillFiles) {
            if (f['rel'] === 'SKILL.md') req.push(...LangGraphPackage.skillDependencies(f['bytes']));
        }
        req.push(...PythonRequirements.documentNames(analyzed['startDocuments'] ?? []));
        return req;
    }

    /** The single file's TO RUN install line (no requirements.txt beside the script in the editor's scripts/). */
    static pipInstall(analyzed: any, target: CompiledTarget): string {
        return PythonRequirements.pipInstall(CompiledPackage.requirementNames(analyzed, target, 'single'));
    }

    /** The environment the program reads that .env must provide (PackageDocs' vars). */
    static envVariables(analyzed: any): EnvVars {
        const keys = new Map<string, string[]>();
        for (const p of CompiledPackage.providers(analyzed)) {
            const k = PythonEmitHelpers.providerKeyEnv(p);
            if (k !== null) {
                if (!keys.has(k)) keys.set(k, []);
                keys.get(k)!.push(p);
            }
        }
        const decision = new Map<string, string>();
        for (const d of values(analyzed['decisions'] ?? [])) {
            for (const c of values(d['decision'])) {
                decision.set(strval(c['key_env']), strval(c['url_env']));
            }
        }
        // Only a playbook node reads MODEL_NAME (PlaybookEmit.supportBlock(), emitted with the playbook nodes).
        return { keys, decision, mcp: analyzed['serverSlugs'] ?? [],
            model: !empty(analyzed['playbooks'] ?? null) ? 'One model for every playbook node, instead of each node\'s own' : null };
    }

    /** The optional variables a layout program reads, as .env.example lists them: [what it does, KEY=example]. */
    private static optionalEnv(analyzed: any, layout: string): Array<[string, string]> {
        const single = layout === 'single';
        const o: Array<[string, string]> = [single
            ? ['Where saved outputs go (default: ~/Documents/synergyAI/outputs)', 'SYNERGYAI_OUTPUT_ROOT=/path/to/outputs']
            : ['Where saved outputs go (default: outputs/ in this folder)', 'SYNERGYAI_OUTPUT_ROOT=./outputs']];
        if (!single) o.push(['Where workflow.py writes its run logs (default: runs/ in this folder)', 'RUNS_DIR=./runs']);
        if (count(LangGraphPackage.skillDirs({ agentData: analyzed['agents'] ?? [] })) > 0) {
            o.push(single
                ? ['Where the skills are read from (default: ' + PackageDocs.EDITOR_SKILLS_DIR + ')', 'SYNERGYAI_SKILLS_DIR=/path/to/skills']
                : ['Where the skills are read from (default: skills/ in this folder)', 'SYNERGYAI_SKILLS_DIR=./skills']);
        }
        if (layout === 'a2a') o.push(['First port of the agent servers, one per node in order (default: 8701)', 'A2A_BASE_PORT=8701']);
        return o;
    }

    /** README.md: what the folder is, install, configure, the run modes, run server, service, files. */
    private static readme(analyzed: any, target: CompiledTarget, layout: string, folder: string, entry: string): string {
        const name = strval(analyzed['workflow']['name']);
        const title = target.title;
        const skills = LangGraphPackage.skillDirs({ agentData: analyzed['agents'] ?? [] });
        const intro: string[] = layout === 'single'
            ? [`A ${title} program compiled from the SynergyAI workflow editor, as one Python file: \`${entry}\`.`,
                'It runs on its own: no database, no SynergyAI server.']
            : layout === 'a2a'
                ? [`A ${title} program compiled from the SynergyAI workflow editor, as A2A agents: each node is an A2A`,
                    'server of its own (`servers/`), and `orchestrator.py` runs the workflow over them. It runs on its own: no',
                    'database, no SynergyAI server. Everything it needs is in this folder.']
                : [`A ${title} program compiled from the SynergyAI workflow editor, with each node in a file of its own`,
                    '(`agents/`). It runs on its own: no database, no SynergyAI server. Everything it needs is in this folder.'];
        if (layout === 'single') intro.push(...PackageDocs.editorSkillsNote(skills));
        const L = PackageDocs.head(name, intro, folder, CompiledPackage.envVariables(analyzed));
        L.push('## Run');
        L.push('');
        L.push('Run these from the folder, with the environment active.');
        L.push('');
        const startMode = strval(analyzed['startMode'] ?? 'prompt');
        if (layout === 'single') {
            L.push('```sh');
            L.push(`python ${entry} "your prompt"   # one run on the text (no text: the Start node's prompt)`);
            L.push('```');
            L.push('');
            L.push('The single file makes one run per launch: it has no schedule or event-trigger mode, and no run server.');
            L.push('Export with "agents in separate files" for those.');
            L.push('');
        } else {
            if (layout === 'a2a') {
                L.push('```sh');
                L.push('python orchestrator.py "your prompt"   # one run over the agent servers (no text: the Start node\'s prompt)');
                L.push('```');
                L.push('');
                L.push(...CompiledPackage.a2aServerLines(CompiledA2AEmit.layout(analyzed)));
                L.push('`workflow.py` runs the same workflow in one process, without the agent servers, in any of these modes:');
                L.push('');
            }
            L.push(...PackageDocs.modes('workflow.py', startMode, analyzed['defaultCron'] ?? null, analyzed['defaultWatch'] ?? null, true));
        }
        L.push('## Files written');
        L.push('');
        if (layout === 'single') {
            L.push('- `~/Documents/synergyAI/outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).');
        } else {
            L.push('- `outputs/` in this folder -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).');
            L.push('- `runs/` in this folder -- one `<date>_<run id>.jsonl` event log per run of `workflow.py` (`RUNS_DIR` overrides).');
        }
        L.push('');
        if (layout !== 'single') {
            L.push(...PackageDocs.runServer(layout === 'modular',
                layout === 'a2a' ? ['The agent servers start with its first run and stop when it exits.'] : []));
            L.push(...PackageDocs.service(name, title, folder, 'workflow.py', '', startMode));
        }
        L.push('## Files');
        L.push('');
        if (layout === 'single') {
            L.push(`- \`${entry}\` -- the whole program: the runtime, one node of the canvas per agent / executor, the CLI.`);
        } else {
            if (layout === 'a2a') {
                L.push('- `orchestrator.py` -- walks the canvas, sending each node its input as an A2A task.');
                L.push('- `servers/` -- one A2A agent server per node.');
            }
            L.push('- `workflow.py` -- the workflow: assembles the nodes and runs them; its CLI is above.');
            L.push('- `agents/` -- one module per node; `common.py` -- the runtime they share.');
            L.push('- `api.py` -- the run server.');
        }
        if (!isEmptyArr(analyzed['code'] ?? []) && layout !== 'single') {
            L.push('- `code/` -- each code node\'s Python, read at every run (edit it here to change the node).');
            L.push('- `code_harness.py` -- the code-node contract (inputs, exits, declared MCP servers, timeout), as the editor runs it.');
        }
        if (skills.length > 0 && layout !== 'single') {
            L.push('- `skills/` -- the skills the agents run.');
        }
        if (!isEmptyArr(analyzed['startDocuments'] ?? []) && layout !== 'single') {
            L.push('- `start_documents/` -- the documents attached to the Start node.');
        }
        return L.join('\n') + '\n';
    }

    /** The A2A servers: what starts them, their files and default URLs. servers: CompiledA2AEmit.layout(). */
    private static a2aServerLines(servers: any): string[] {
        const L: string[] = [];
        L.push('The orchestrator starts every agent server at its first run and stops them when it ends. `--keep-serving`');
        L.push('leaves them running; `--no-spawn` starts none and uses servers already running, each at its');
        L.push('`A2A_AGENT_<id>_URL` (default below; `A2A_BASE_PORT` moves the whole range).');
        L.push('');
        L.push('| Node | File | Default URL |');
        L.push('|---|---|---|');
        const all = entries(servers);
        for (const [nid, e] of all) L.push(`| ${strval(e['display'])} (${nid}) | \`${strval(e['file'])}\` | http://127.0.0.1:${strval(e['port'])}/ |`);
        L.push('');
        if (all.length) {
            const first = all[0][1];
            L.push(`To start one by hand: \`python ${strval(first['file'])} --port ${strval(first['port'])}\` (\`--host\` sets the interface).`);
            L.push('');
        }
        return L;
    }
}
