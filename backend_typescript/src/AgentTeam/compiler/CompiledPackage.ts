import { readFileSync } from 'node:fs';
import {
  array_unique, count, entries, has, implode, is_array, isEmptyArr, oarr, pathExtension, preg_split, sortStrings, str_starts_with,
  strlen, strtolower, strtoupper, strval, substr, trim, values,
} from './php';
import { LangGraphPackage } from './LangGraphPackage';
import { PlaybookEmit } from './PlaybookEmit';
import { PythonEmitHelpers } from './PythonEmitHelpers';
import * as path from 'node:path';

/** frontend/assets/py/code_node_harness.py (PHP: HARNESS, from backend/src/AgentTeam/Services). */
const HARNESS = path.resolve(__dirname, '../../../../frontend/assets/py/code_node_harness.py');

/**
 * The files that make a compiled ADK, MAF or NOOA package run on its own, in its own folder, as LangGraph's
 * modular package does: requirements.txt, .env.example, README.md, the code-node harness (a copy,
 * code_harness.py), each code node's code (code/), each used skill's folder (skills/) and the
 * Start's documents (start_documents/). workflow.py, common.py and api.py are the target generator's.
 * Mirrors backend/src/AgentTeam/Services/CompiledPackage.php.
 */
export class CompiledPackage
{
    /** What every package imports besides its framework: the MCP client, .env, the run server. */
    private static readonly BASE_REQUIREMENTS = ['httpx', 'python-dotenv', 'fastapi', 'uvicorn'];

    /** The document converter's lazy imports, by attachment extension. */
    private static readonly DOCUMENT_REQUIREMENTS: Record<string, string> = { pdf: 'pypdf', docx: 'mammoth', pptx: 'python-pptx', xlsx: 'openpyxl' };

    /**
     * @param analyzed ADKGenerator's analysis, with 'startDocuments' already pointing at start_documents/
     * @param documentFiles the start_documents/ entries (LangGraphPackage::startDocuments()['files'])
     * @return list of {path, code, encoding?}
     */
    static async files(analyzed: any, skillsRoot: string, documentFiles: any, framework: any,
        frameworkTitle: string): Promise<any[]> {
        const skills: any = await LangGraphPackage.skillFiles({ agentData: analyzed['agents'] ?? [] }, skillsRoot);
        const out: any[] = [
            { path: 'requirements.txt', code: CompiledPackage.requirements(analyzed, skills, framework) },
            { path: '.env.example', code: CompiledPackage.envExample(analyzed) },
            { path: 'README.md', code: CompiledPackage.readme(analyzed, frameworkTitle) },
        ];
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
        const p: any = oarr();
        for (const d of [...values(analyzed['agents'] ?? []), ...values(analyzed['playbooks'] ?? [])]) {
            if ((d['provider'] ?? '') !== '') {
                p[strtolower(strval(d['provider']))] = true;
            }
        }
        return Object.keys(p);
    }

    /** requirements.txt: one per line, sorted, unique. */
    private static requirements(analyzed: any, skillFiles: any, framework: any): string {
        let req: string[] = [...values<string>(framework), ...CompiledPackage.BASE_REQUIREMENTS];
        // A playbook node runs the shared interpreter (langchain-core + langgraph + its provider's package).
        for (const line of values<string>(PlaybookEmit.extraDeps(analyzed))) {
            if (str_starts_with(line, 'pip install ')) {
                req.push(...preg_split('/\\s+/', trim(substr(line, strlen('pip install ')))));
            }
        }
        for (const f of values(skillFiles)) {
            if (f['rel'] === 'SKILL.md') {
                req.push(...values<string>(LangGraphPackage.skillDependencies(f['bytes'])));
            }
        }
        for (const doc of values(analyzed['startDocuments'] ?? [])) {
            const ext = strtolower(pathExtension(strval(is_array(doc) ? (doc['path'] ?? doc['name'] ?? '') : '')));
            if (Object.hasOwn(CompiledPackage.DOCUMENT_REQUIREMENTS, ext)) {
                req.push(CompiledPackage.DOCUMENT_REQUIREMENTS[ext]);
            }
        }
        req = sortStrings(values<string>(array_unique(req)).map((r) => strval(r)));
        return req.join('\n') + '\n';
    }

    /** .env.example: every variable the program reads, commented (an empty KEY= would mask the runner's python/.env). */
    private static envExample(analyzed: any): string {
        const L: string[] = [];
        L.push('# Environment of the workflow "' + strval(analyzed['workflow']['name']) + '" -- copy this file to .env and fill it in.');
        L.push('# The program reads .env from its own folder first, then from the folder two levels up');
        L.push('# (a local runner\'s .env). A variable already set in the environment is never overridden.');
        L.push('');
        const keys: any = oarr();
        for (const p of CompiledPackage.providers(analyzed)) {
            const k = PythonEmitHelpers.providerKeyEnv(p);
            if (k !== null && k !== undefined) {
                if (!has(keys, k)) keys[k] = [];
                keys[k].push(p);
            }
        }
        if (count(keys) > 0) {
            L.push('# API keys of the LLM providers this workflow uses');
            for (const [k, provs] of entries(keys)) {
                L.push('# ' + implode(', ', array_unique(provs)));
                L.push(`# ${k}=`);
            }
        } else {
            L.push('# No LLM provider is used by a node of this workflow.');
        }
        L.push('');
        const decision: any = oarr();
        for (const d of values(analyzed['decisions'] ?? [])) {
            for (const c of values(d['decision'])) {
                decision[strval(c['key_env'])] = strval(c['url_env']);
            }
        }
        if (count(decision) > 0) {
            L.push('# Decision models the dispatchers may route with (each URL variable is optional: a gateway)');
            for (const [key, url] of entries(decision)) {
                L.push(`# ${key}=`);
                L.push(`# ${url}=`);
            }
            L.push('');
        }
        const slugs = analyzed['serverSlugs'] ?? [];
        if (count(slugs) > 0) {
            L.push('# MCP servers: the URL compiled in, and the HTTP headers the server needs (never compiled in)');
            for (const [url, slug] of entries(slugs)) {
                const up = strtoupper(strval(slug));
                L.push(`MCP_URL_${up}=${url}`);
                L.push('# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}');
                L.push(`# MCP_HEADERS_${up}=`);
            }
            L.push('');
        }
        L.push('# Optional');
        L.push('# Where saved outputs go (default: outputs/ in this folder)');
        L.push('# SYNERGYAI_OUTPUT_ROOT=./outputs');
        if (count(LangGraphPackage.skillDirs({ agentData: analyzed['agents'] ?? [] })) > 0) {
            L.push('# Where the skills are read from (default: skills/ in this folder)');
            L.push('# SYNERGYAI_SKILLS_DIR=./skills');
        }
        return L.join('\n') + '\n';
    }

    /** README.md: what the folder is, install, configure, run, serve. */
    private static readme(analyzed: any, frameworkTitle: string): string {
        const name = strval(analyzed['workflow']['name']);
        const L: string[] = [];
        L.push(`# ${name}`);
        L.push('');
        L.push(`A ${frameworkTitle} program compiled from the SynergyAI workflow editor. It runs on its own: no database,`);
        L.push('no SynergyAI server. Everything it needs is in this folder.');
        L.push('');
        L.push('## Install');
        L.push('');
        L.push('```sh');
        L.push('python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt');
        L.push('cp .env.example .env   # then fill in the API keys and MCP headers');
        L.push('```');
        L.push('');
        L.push('## Run');
        L.push('');
        L.push('```sh');
        L.push('python workflow.py "your prompt"   # one run (no text: the Start node\'s prompt)');
        L.push('python api.py --port 8000          # the run server SynergyAI\'s editor talks to');
        L.push('```');
        L.push('');
        L.push('## Files');
        L.push('');
        L.push('- `workflow.py` -- the workflow: one node of the canvas per agent / executor, run in the canvas order.');
        L.push('- `api.py`, `common.py` -- the run server.');
        if (!isEmptyArr(analyzed['code'] ?? [])) {
            L.push('- `code/` -- each code node\'s Python, read at every run (edit it here to change the node).');
            L.push('- `code_harness.py` -- the code-node contract (inputs, exits, declared MCP servers, timeout), as the editor runs it.');
        }
        if (count(LangGraphPackage.skillDirs({ agentData: analyzed['agents'] ?? [] })) > 0) {
            L.push('- `skills/` -- the skills the agents run.');
        }
        if (!isEmptyArr(analyzed['startDocuments'] ?? [])) {
            L.push('- `start_documents/` -- the documents attached to the Start node.');
        }
        L.push('- `outputs/` -- the saved results, when output storage is on (`SYNERGYAI_OUTPUT_ROOT` overrides).');
        return L.join('\n') + '\n';
    }
}
