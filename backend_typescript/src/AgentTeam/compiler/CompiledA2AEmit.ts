import {
  JSON_UNESCAPED_SLASHES, JSON_UNESCAPED_UNICODE, asciiTranslit, date, empty, entries, has, implode, intval, json_encode, keysOf, oarr,
  preg_replace, rtrim, sprintf, str_replace, strtolower, strval, substr, toArr, toObject, trim, values,
} from './php';
import { GraphAnalyzer } from './GraphAnalyzer';
import { PythonEmitHelpers } from './PythonEmitHelpers';
import { LangGraphRuntime } from './LangGraphRuntime';
import { RunServerEmitter } from './RunServerEmitter';
import { LangGraphGenerator } from '../LangGraphGenerator';

/** isset($a[$k1][$k2]...) over any PHP array shape. */
function isset(v: any, ...ks: string[]): boolean {
  let cur = v;
  for (const k of ks) {
    if (!has(cur, k)) return false;
    cur = cur[k];
  }
  return true;
}

/** One server's entry of layout(). */
export interface A2AServerEntry {
  display: string;
  kind: string;
  file: string;
  port: number;
  index: number;
  menu?: Array<[string, string]>;
}

/**
 * The A2A code structure of the ADK, MAF and NOOA targets: LangGraph's A2A design, copied -- one A2A agent
 * server per node (a2a-sdk 1.1, Agent Card at /.well-known/agent-card.json, JSON-RPC at /, gates over
 * INPUT_REQUIRED) and an orchestrator that spawns them (AgentSupervisor), sends each node its input as a task
 * and walks the canvas. The orchestrator is framework-free and the same for the three targets; each server runs
 * its node with the target's own runtime: it imports the package's common.py and agents/ (the "agents in
 * separate files" layout, which the A2A package carries too), so the runtime is not copied into every server.
 * Same scope as LangGraph's A2A: agents, dispatchers (decision models too), playbooks, skills; code nodes and
 * Start options are refused; no listening.
 * Mirrors backend/src/AgentTeam/Services/CompiledA2AEmit.php.
 */
export class CompiledA2AEmit
{
    static readonly BASE_PORT = 8701;

    /** LangGraph's refusals, word for word: A2A has no code nodes and no Start option (event trigger). */
    static refuse(analyzed: any): void {
        if ((analyzed['triggerNodeId'] ?? null) !== null) {
            throw new Error('A Start option (an event or schedule trigger) needs the single-file or modular format: '
                + 'compile this workflow as a single file or with agents in separate files.');
        }
        if (!empty(analyzed['code'])) {
            throw new Error('Code nodes are not supported by the A2A packaging yet. Compile this workflow as a single file'
                + ' or with agents in separate files.');
        }
    }

    /** The A2A version every card and the orchestrator agree on: "<workflow id>-<Ymd>" (LangGraph's). */
    static version(analyzed: any): string {
        return String(intval(analyzed['workflow']?.['id'] ?? 0)) + '-' + date('Ymd');
    }

    /**
     * One server per agent, dispatcher and playbook node, in canvas order: servers/<nid>_<slug>.py on port
     * 8701 + index (A2A_BASE_PORT moves the range).
     */
    static layout(analyzed: any): Record<string, A2AServerEntry> {
        const menus = GraphAnalyzer.dispatchMenus(analyzed)['menus'];
        const out: Record<string, A2AServerEntry> = oarr();
        let i = 0;
        for (const rawNid of values(toArr(analyzed['order'] ?? []))) {
            const nid = strval(rawNid);
            let kind: string, display: string;
            if (isset(analyzed, 'playbooks', nid)) {
                kind = 'playbook';
                display = strval(analyzed['playbooks'][nid]['display']);
            } else if (isset(analyzed, 'agents', nid)) {
                kind = has(menus, nid) ? 'dispatcher' : 'agent';
                display = strval(analyzed['agents'][nid]['name']);
            } else {
                continue;
            }
            const ascii = str_replace(["'", '"', '`', '^', '~'], '', asciiTranslit(display) || display);
            const slug = substr(strtolower(trim(strval(preg_replace('/[^a-z0-9]+/i', '-', ascii)), '-')) || 'node', 0, 40);
            const slugOr = slug === '0' ? 'node' : slug;   // PHP's `?:`: "0" is falsy too
            out[nid] = { display: display, kind: kind, file: `servers/${nid}_${slugOr}.py`,
                port: CompiledA2AEmit.BASE_PORT + i, index: i };
            if (kind === 'dispatcher') {
                out[nid]['menu'] = values(menus[nid]).map((t: any) => [strval(t['id']), strval(t['name'])] as [string, string]);
            }
            i++;
        }
        return out;
    }

    /** orchestrator.py: the canvas as data, LangGraph's supervisor and remote node runner, the graph walk, the CLI. */
    static orchestrator(analyzed: any, title: string): string {
        const layout = CompiledA2AEmit.layout(analyzed);
        const startId = strval(analyzed['startNodeId'] ?? '');
        let outId = '';
        for (const [id, node] of entries(toArr(analyzed['byId']))) {
            if (GraphAnalyzer.typeOf(node) === 'output') { outId = strval(id); break; }
        }
        const eff = (id: string): string[] => {
            const keep: string[] = [];
            const parents = has(analyzed['parents'], id) ? analyzed['parents'][id] : [];
            for (const rawP of values(toArr(parents))) {
                const p = strval(rawP);
                if (p === startId || has(layout, p)) {
                    keep.push(p);
                }
            }
            return keep.length > 0 ? keep : (startId !== '' ? [startId] : []);
        };
        const nodes: any = oarr();
        const layers: string[][] = [];
        for (const layer of values(toArr(analyzed['layers']))) {
            const ids = values(toArr(layer)).map((n: any) => strval(n)).filter((n) => has(layout, n));
            for (const n of ids) {
                nodes[n] = { kind: layout[n]['kind'], name: layout[n]['display'], parents: eff(n) };
            }
            if (ids.length > 0) {
                layers.push(ids);
            }
        }
        const agents: any = oarr();
        for (const [nid, e] of entries<A2AServerEntry>(layout)) {
            agents[nid] = { display: e['display'], file: e['file'], kind: e['kind'], port: e['port'], index: e['index'] };
        }
        const graph = { start: startId, output: outId, output_parents: outId !== '' ? eff(outId) : [],
            sinks: outId === '' && layers.length > 0 ? layers[layers.length - 1] : [], layers: layers, nodes: toObject(nodes) };
        const name = strval(analyzed['workflow']['name']);
        const endpoints: string[] = [];
        for (const [nid, e] of entries<A2AServerEntry>(layout)) {
            endpoints.push(sprintf('  %-6s %-24s %-36s http://127.0.0.1:%d/   (env A2A_AGENT_%s_URL)', nid, e['display'], e['file'], e['port'], nid));
        }
        const q = '"""';
        const L: string[] = [];
        L.push(`${q}A2A orchestrator for workflow ` + json_encode(name, JSON_UNESCAPED_UNICODE) + ` -- ${title}.`);
        L.push('');
        L.push('One A2A agent server per node (servers/, spawned by AgentSupervisor at the first run), each running its');
        L.push('node with the ' + title + ' runtime in common.py; this file walks the canvas (GRAPH): each layer\'s reached');
        L.push('nodes get their input (the request plus their parents\' outputs) as an A2A task, together; a dispatcher\'s');
        L.push('route decides which of its children run; the Output node merges what reached it.');
        L.push('');
        L.push('AGENT ENDPOINTS  (id, name, file, default URL; env override)');
        L.push('===============');
        L.push(...endpoints);
        L.push('');
        L.push('TO RUN');
        L.push('======');
        L.push('  pip install -r requirements.txt');
        L.push('  python orchestrator.py "your prompt here"   [--keep-serving] [--no-spawn]');
        L.push('  python api.py --port 8000                    # the run server SynergyAI\'s editor talks to');
        L.push('  # A2A_BASE_PORT (default 8701) moves the port range; A2A_AGENT_<id>_URL points one agent elsewhere.');
        L.push(q);
        L.push('from __future__ import annotations');
        L.push('');
        L.push('import argparse, asyncio, json, os, subprocess, sys, threading, time, uuid');
        L.push('from typing import Callable');
        L.push('');
        L.push('from dotenv import load_dotenv');
        L.push('');
        L.push('_HERE = os.path.dirname(os.path.abspath(__file__))');
        L.push('for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):   # own .env first, then python/.env');
        L.push('    load_dotenv(os.path.join(_d, ".env"))');
        L.push('');
        L.push('import httpx');
        L.push('from a2a import types as T');
        L.push('from a2a.client import create_client, ClientConfig');
        L.push('from a2a.helpers.proto_helpers import new_data_part, get_data_parts, get_text_parts');
        L.push('');
        L.push('WORKFLOW_ID = ' + String(intval(analyzed['workflow']['id'])));
        L.push('WORKFLOW_NAME = ' + PythonEmitHelpers.pyStr(name));
        L.push('WORKFLOW_VERSION = ' + PythonEmitHelpers.pyStr(CompiledA2AEmit.version(analyzed)) + '   # every agent card must carry it');
        L.push('DEFAULT_PROMPT = ' + PythonEmitHelpers.pyStr(strval(analyzed['startPrompt'] ?? '')));
        L.push('A2A_BASE_PORT = int(os.environ.get("A2A_BASE_PORT", "' + CompiledA2AEmit.BASE_PORT + '"))');
        L.push('START_DOCUMENTS = ' + PythonEmitHelpers.jsonToPython(analyzed['startDocuments'] ?? []) + '   # the Start\'s documents (start_documents/ in this folder)');
        L.push('OUTPUT_STORAGE_ENABLED = ' + (!empty(analyzed['outputStorageEnabled']) ? 'True' : 'False'));
        const folder = analyzed['outputFolder'] ?? null;
        L.push('OUTPUT_FOLDER = ' + ((folder !== null && folder !== '') ? PythonEmitHelpers.pyStr(strval(folder)) : 'None'));
        L.push('');
        L.push('AGENTS = ' + PythonEmitHelpers.jsonToPython(agents) + '   # node id -> server file, port, kind');
        L.push('ORDER = ' + PythonEmitHelpers.jsonToPython(keysOf(layout).map((k) => strval(k))));
        L.push('GRAPH = ' + PythonEmitHelpers.jsonToPython(graph) + '   # the canvas: layers, each node\'s kind and parents');
        L.push('');
        L.push('');
        L.push(LangGraphRuntime.runEventsBlock());
        L.push(LangGraphGenerator.contextBuilderBlock());
        L.push(PythonEmitHelpers.documentConverterBlock());
        L.push('NODE_DURATIONS = {}   # display name -> seconds of A2A round trip');
        L.push('');
        L.push('');
        L.push(LangGraphGenerator.a2aRemoteBlock());
        L.push(`# ==============================================================
# THE GRAPH WALK -- each layer's reached nodes run together over A2A
# ==============================================================
def _with_documents(prompt: str) -> str:
    """The prompt with the Start's documents, converted to Markdown, placed before it (as every target does)."""
    parts = []
    for doc in START_DOCUMENTS:
        name, path = doc.get("name", "Document"), doc.get("path", "")
        if path and not os.path.isabs(path):
            path = os.path.join(_HERE, path)   # start_documents/ in this folder
        try:
            parts.append(f"### {name}\\n\\n{_convert_doc_to_markdown(path)}" if path else f"### {name}\\n\\n_(no path)_")
        except Exception as e:
            parts.append(f"### {name}\\n\\n_(conversion failed: {e})_")
    if not parts:
        return prompt
    return "## Attached Documents\\n\\n" + "\\n\\n---\\n\\n".join(parts) + "\\n\\n---\\n\\n" + prompt


def _save_output(text: str) -> str | None:
    """The Output node's storage rule: when ON, the answer goes to outputs/ in this folder (SYNERGYAI_OUTPUT_ROOT
    overrides) or the workflow's custom folder; returns the file's path, or None when OFF."""
    if not OUTPUT_STORAGE_ENABLED or not text:
        return None
    import re
    m = re.search(r"(?is)<!doctype html.*?</html\\s*>", text) or re.search(r"(?is)<html[\\s>].*?</html\\s*>", text)
    text, ext = (m.group(0), "html") if m else (text, "md")
    slug = "".join(c if c.isalnum() else "_" for c in WORKFLOW_NAME).strip("_")[:60] or "workflow"
    root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(_HERE, "outputs")
    folder = os.path.expanduser(OUTPUT_FOLDER) if OUTPUT_FOLDER else os.path.join(root, "workflow")
    folder = folder if os.path.isabs(folder) else os.path.join(root, folder)
    os.makedirs(folder, exist_ok=True)
    out = os.path.join(folder, f"{WORKFLOW_ID}-{slug}_{time.strftime('%Y%m%d-%H%M%S')}.{ext}")
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    return os.path.abspath(out)


async def run(user_prompt: str, session: str | None = None) -> str:
    """Run the workflow once on \`user_prompt\` over the agent servers (already serving). Returns the Output's
    merge, or why a dispatcher did not route when nothing reached the Output."""
    prompt = _with_documents(str(user_prompt or DEFAULT_PROMPT or "Hello"))
    nodes = GRAPH["nodes"]
    out = {}        # node id -> {"source", "text"}: the nodes that ran
    routes = {}     # dispatcher id -> the child ids its route lets run
    unrouted = ""

    def reached(nid: str) -> bool:
        return any((p == GRAPH["start"] or p in out) and (p not in routes or nid in routes[p])
                   for p in nodes[nid]["parents"])

    async def run_node(nid: str) -> str:
        nonlocal unrouted
        node = nodes[nid]
        request = build_context(prompt, [p for p in node["parents"] if p != GRAPH["start"]], out)
        res = await _run_remote_node(nid, request)
        if node["kind"] == "dispatcher":
            routes[nid] = {res["route"]} if res["route"] else set()
            if not res["route"]:
                unrouted = res["text"]
        return res["text"]

    for layer in GRAPH["layers"]:
        ready = [nid for nid in layer if reached(nid)]
        texts = await asyncio.gather(*(run_node(nid) for nid in ready))
        for nid, text in zip(ready, texts):
            out[nid] = {"source": nodes[nid]["name"], "text": text}
    if GRAPH["output"]:
        merge = [p for p in GRAPH["output_parents"] if p in out and (p not in routes or GRAPH["output"] in routes[p])]
    else:
        merge = [p for p in GRAPH["sinks"] if p in out]
    parts = [out[p]["text"] for p in merge if out[p]["text"]]
    merged = parts[0] if len(parts) == 1 else "\\n\\n---\\n\\n".join(parts)
    return merged or unrouted


def main() -> None:
    ap = argparse.ArgumentParser(description=f"A2A orchestrator for workflow {WORKFLOW_NAME!r}")
    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")
    ap.add_argument("--keep-serving", action="store_true", help="leave the agent servers running after the run")
    ap.add_argument("--no-spawn", action="store_true", help="do not start the agent servers (they already run elsewhere)")
    a = ap.parse_args()
    sup = AgentSupervisor(spawn=not a.no_spawn)
    try:
        sup.start()
        answer = asyncio.run(run(" ".join(a.prompt) or DEFAULT_PROMPT or "Hello"))
        print("\\n=== FINAL OUTPUT ===\\n" + answer, flush=True)
        saved = _save_output(answer)   # the CLI saves; a served run (api.py) answers without writing a file
        if saved:
            print(f"  Document saved to: {saved}", flush=True)
    finally:
        if not a.keep_serving:
            sup.stop()


if __name__ == "__main__":
    main()`);
        return implode('\n', L) + '\n';
    }

    /** api.py: the run server over the orchestrator (LangGraph's A2A api.py: agents start with the first run). */
    static api(analyzed: any, title: string): string {
        const name = json_encode(strval(analyzed['workflow']['name']), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        return '"""Run server for workflow ' + name + ` (A2A, ${title})

`
            + 'Serves the run protocol the SynergyAI frontend speaks over orchestrator.run(); the agent servers start\n'
            + 'with the first run (_ensure_agents) and stop with this process. No authentication: bind to 127.0.0.1\n'
            + 'or a trusted LAN interface only.\n' + '"""' + '\n'
            + `from __future__ import annotations

import argparse, asyncio, atexit, json, os, sys, time, uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import uvicorn

from orchestrator import run as run_workflow, AgentSupervisor, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME, WORKFLOW_VERSION
from orchestrator import set_event_sink, resolve_gate

_SUPERVISOR = None   # the agent servers: started with the first run, stopped with this process


def _ensure_agents() -> None:
    """Start the A2A agent servers once, on the first run (blocking: called through asyncio.to_thread)."""
    global _SUPERVISOR
    if _SUPERVISOR is None:
        _SUPERVISOR = AgentSupervisor(spawn=True)
        atexit.register(_stop_agents)   # before start(): a fleet that half came up is still torn down
        _SUPERVISOR.start()


def _stop_agents() -> None:
    """Shutdown hook: stop the agent servers this process spawned (idempotent, never raises)."""
    global _SUPERVISOR
    sup, _SUPERVISOR = _SUPERVISOR, None
    if sup is None:
        return
    try:
        sup.stop()
    except Exception as exc:   # noqa: BLE001 -- best effort on the way out
        print(f"[supervisor] stop failed: {exc}", flush=True)
`
            + RunServerEmitter.runtimeBlock();
    }

    /**
     * servers/<nid>_<slug>.py: node `nid` as an A2A agent server. $runNode is the target's
     * `async def run_node(request_text, trace) -> {"text", "route", "notes", "status"}` for this node; the
     * serving code (Agent Card, executor paused at gates, gate bridge, main) is LangGraph's.
     */
    static server(analyzed: any, nid: string, runNode: string, title: string): string {
        const e = CompiledA2AEmit.layout(analyzed)[nid];
        const ag: any = isset(analyzed, 'agents', nid) ? analyzed['agents'][nid] : [];
        const pb: any = isset(analyzed, 'playbooks', nid) ? analyzed['playbooks'][nid] : [];
        const node: any = { id: nid, kind: e['kind'], display: e['display'],
            provider: strval(ag['provider'] ?? pb['provider'] ?? ''),
            system_prompt: strval(ag['systemPrompt'] ?? pb['instructions'] ?? '') };
        if (e['menu'] !== undefined) {
            node['menu'] = e['menu'];
        }
        const q = '"""';
        return `${q}A2A agent server for node ${nid} (` + str_replace([q, '\n'], ['\'\'\'', ' '], e['display']) + ') of workflow '
            + json_encode(strval(analyzed['workflow']['name']), JSON_UNESCAPED_UNICODE) + ` -- ${title}.

`
            + 'The orchestrator (orchestrator.py, one folder up) sends this node its input as an A2A task, streams its\n'
            + 'status, answers its gates and reads the \'result\' artifact (text + route/notes/status). The node runs with\n'
            + `the package's runtime (common.py, agents/).
${q}
`
            + `from __future__ import annotations

import argparse, asyncio, os, sys, time

_PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PKG)   # common.py, agents/ and workflow.py live one folder up

import workflow as W   # noqa: E402 -- fills the node tables from agents/; the runtime is common.py
from common import *   # noqa: E402,F401,F403
import common as _C    # noqa: E402

import uvicorn  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from a2a import types as T  # noqa: E402
from a2a.server.agent_execution import AgentExecutor, RequestContext  # noqa: E402
from a2a.server.events import EventQueue  # noqa: E402
from a2a.server.request_handlers import DefaultRequestHandler  # noqa: E402
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater  # noqa: E402
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes  # noqa: E402
from a2a.helpers.proto_helpers import new_task_from_user_message, new_data_part, get_data_parts  # noqa: E402
`
            + 'NODE = ' + PythonEmitHelpers.jsonToPython(node) + '\n\n\n'
            + (e['kind'] === 'dispatcher' ? CompiledA2AEmit.dispatcherHelpers() + '\n\n\n' : '')
            + rtrim(runNode, '\n') + '\n\n\n'
            + LangGraphGenerator.a2aAgentServerBlock() + '\n'
            + '# The shared playbook runtime (common.py) asks GATE_BRIDGE for its gates: over A2A here.\n'
            + '_C.GATE_BRIDGE = _a2a_gate if NODE["kind"] == "playbook" else None\n'
            + 'WORKFLOW_NAME = ' + PythonEmitHelpers.pyStr(strval(analyzed['workflow']['name'])) + '\n'
            + 'WORKFLOW_VERSION = ' + PythonEmitHelpers.pyStr(CompiledA2AEmit.version(analyzed)) + '\n'
            + `AGENT_CARD = build_agent_card(f"http://127.0.0.1:{os.environ.get('A2A_PORT', '${e['port']}')}/")

`
            + 'if __name__ == "__main__":\n    main()\n';
    }

    /** The dispatcher servers' shared helpers: reading a chooser model's reply, asking a decision model. */
    static dispatcherHelpers(): string {
        return `def _a2a_pick(reply: str, menu: list) -> tuple:
    """(chosen child id | None, notes) from a chooser model's reply: the name alone on its first line, else the
    menu name that appears first in the reply (every target's dispatcher reads it so)."""
    lines = [ln.strip() for ln in reply.strip().splitlines()]
    first = lines[0].strip(' "\\'*\`#:-').lower() if lines else ""
    notes = "\\n".join(lines[1:]).strip()
    for cid, nm in menu:
        if nm.strip().lower() == first:
            return cid, notes
    low = reply.lower()
    hits = [(low.index(nm.strip().lower()), cid) for cid, nm in menu if nm.strip().lower() in low]
    return (min(hits)[1] if hits else None), notes


def _a2a_unrouted(name: str, menu: list) -> str:
    return f"Error: dispatcher {name!r} did not route the request. Expected one of: {', '.join(n for _, n in menu)}."


async def _a2a_decide(key: str, router, request_text: str, menu: list, question: str, floor: float,
                      unclear_branch: str, name: str) -> tuple:
    """Decision model \`key\` (Jev...), no LLM turn: (chosen child id | None, this node's text, not_classified).
    Unclear / low confidence goes to the unclear branch when set, else "Not classified"; anything else is an Error."""
    targets = [{"id": c, "name": n, "description": ""} for c, n in menu]
    if router is None:
        res = DecisionResult("unavailable", reason=f"'{key}' is not an available decision provider")
    else:
        try:
            res = await asyncio.wait_for(asyncio.to_thread(router.route, request_text, targets, question, floor),
                                         router.TIMEOUT_S + 1)
        except Exception as e:   # a timeout included: an 'error' outcome (did not route)
            res = DecisionResult("error", reason=f"{type(e).__name__}: no answer within {router.TIMEOUT_S + 1}s"
                                 if isinstance(e, asyncio.TimeoutError) else str(e))
    not_classified = res.outcome in ("unclear", "low_confidence")
    if res.outcome == "routed":
        print(f"[node] {name!r} {key} routed to {res.target['name']!r} (no LLM turn)", flush=True)
        return str(res.target["id"]), request_text, False
    if not_classified and unclear_branch:
        chosen = next((c for c, n in menu if n == unclear_branch), None)
        if chosen is not None:
            return chosen, request_text, False
    msg = (f'{"Not classified" if not_classified else "Error"}: dispatcher "{name}" did not route the request '
           f"({key}: {res.outcome}: {res.reason}).")
    print(f"[node] ⚠ {msg}", flush=True)
    return None, msg, not_classified`;
    }

    /**
     * The whole A2A package: the "agents in separate files" package's runtime and node modules (common.py,
     * agents/, workflow.py), one server per node, orchestrator.py, api.py, the package files.
     *
     * @param array $modular [workflow.py, common.py, agents/ files] from the target's packageFiles()
     * @param array<string,string> $runNodes node id => that node's run_node source
     */
    static package(analyzed: any, modular: any, runNodes: any, packageFiles: any, root: string, title: string): { root: string; files: any[] } {
        const [workflowPy, commonPy, nodeFiles] = values(modular);
        const files: any[] = [
            { path: 'orchestrator.py', code: CompiledA2AEmit.orchestrator(analyzed, title) },
            { path: 'api.py', code: CompiledA2AEmit.api(analyzed, title) },
            { path: 'workflow.py', code: workflowPy },
            { path: 'common.py', code: commonPy },
        ];
        files.push(...values(nodeFiles));
        for (const [nid, src] of entries(runNodes)) {
            files.push({ path: CompiledA2AEmit.layout(analyzed)[nid]['file'], code: CompiledA2AEmit.server(analyzed, strval(nid), src, title) });
        }
        return { root: root, files: [...files, ...values(packageFiles)] };
    }
}

