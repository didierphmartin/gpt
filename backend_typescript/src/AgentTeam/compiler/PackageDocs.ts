import { count, entries, keysOf, strtolower, strtoupper, strval, trim, preg_replace } from './php';

/**
 * The text an exported folder explains itself with, shared by every compile target: .env.example, and the
 * README sections whose facts do not depend on the target (requirements, getting the folder, installing,
 * configuring, the Start's run modes, running as a service). LangGraphPackage and CompiledPackage say what
 * their programs are and which files run them; the environment variables come from one place (their
 * envVariables()), so .env.example and the README name the same ones.
 * Ported from backend/src/AgentTeam/Services/PackageDocs.php.
 *
 * EnvVars, the environment a program reads: keys KEY => providers, decision KEY => URL_KEY, mcp url => slug.
 */
export type EnvVars = { keys: Map<string, string[]>; decision: Map<string, string>; mcp: any };

export class PackageDocs {
  /** Where the editor keeps skills: a single file reads them from there (SYNERGYAI_SKILLS_DIR overrides). */
  static readonly EDITOR_SKILLS_DIR = '~/Documents/synergyAI/skills';

  /** .env.example: every variable the program reads, commented. optional: [what it does, "KEY=example"]. */
  static envExample(wfName: string, vars: EnvVars, optional: Array<[string, string]>): string {
    const L: string[] = [];
    L.push('# Environment of the workflow "' + wfName + '" -- copy this file to .env and fill it in.');
    L.push('# The program reads .env from its own folder first, then from the folder two levels up');
    L.push('# (a local runner\'s .env). A variable already set in the environment is never overridden.');
    L.push('');
    if (vars.keys.size) {
      L.push('# API keys of the LLM providers this workflow uses');
      for (const [k, provs] of vars.keys) {
        L.push('# ' + provs.join(', '));
        L.push(`# ${k}=`);
      }
    } else {
      L.push('# No LLM provider is used by a node of this workflow.');
    }
    L.push('');
    if (vars.decision.size) {
      L.push('# Decision models the dispatchers may route with (each URL variable is optional: a gateway)');
      for (const [key, url] of vars.decision) {
        L.push(`# ${key}=`);
        L.push(`# ${url}=`);
      }
      L.push('');
    }
    if (count(vars.mcp)) {
      L.push('# MCP servers: the URL compiled in, and the HTTP headers the server needs (never compiled in)');
      for (const [url, slug] of entries(vars.mcp)) {
        const up = strtoupper(strval(slug));
        L.push(`MCP_URL_${up}=${url}`);
        L.push('# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}');
        L.push(`# MCP_HEADERS_${up}=`);
      }
      L.push('');
    }
    L.push('# Optional');
    for (const [what, line] of optional) {
      L.push(`# ${what}`);
      L.push(`# ${line}`);
    }
    return L.join('\n') + '\n';
  }

  /**
   * The README from its title through "Configure": what the folder is, what it needs, how to get into it,
   * install the packages and fill in .env. intro: the opening paragraph, one line per entry.
   */
  static head(name: string, intro: string[], folder: string, vars: EnvVars): string[] {
    const L: string[] = [`# ${name}`, '', ...intro, ''];
    L.push('## Requirements');
    L.push('');
    L.push('- Python 3.10 or newer (the code uses `match` statements). Check with `python3 --version`');
    L.push('  (Windows: `py --version`).');
    if (vars.keys.size) {
      L.push('- An API key for each LLM provider the workflow uses: '
        + [...vars.keys].map(([k, p]) => p.join(', ') + ` (\`${k}\`)`).join(', ') + '.');
    }
    if (count(vars.mcp)) {
      L.push('- Network access to the MCP server' + (count(vars.mcp) > 1 ? 's' : '') + ' it calls: '
        + keysOf(vars.mcp).map((u) => `<${u}>`).join(', ') + '.');
    }
    L.push('');
    L.push('## Get the folder');
    L.push('');
    L.push(`The export is a zip holding one folder, \`${folder}\`. Unzip it (Windows: right-click the zip, then`);
    L.push('"Extract All"), open a terminal and go into that folder: every command below runs from there.');
    L.push('');
    L.push('```sh');
    L.push(`cd ${folder}`);
    L.push('```');
    L.push('');
    L.push('## Install');
    L.push('');
    L.push('Create a virtual environment in the folder and install the packages of `requirements.txt` into it.');
    L.push('');
    L.push('macOS / Linux:');
    L.push('');
    L.push('```sh');
    L.push('python3 -m venv .venv');
    L.push('. .venv/bin/activate');
    L.push('pip install -r requirements.txt');
    L.push('```');
    L.push('');
    L.push('Windows (PowerShell or Command Prompt):');
    L.push('');
    L.push('```bat');
    L.push('py -m venv .venv');
    L.push('.venv\\Scripts\\activate');
    L.push('pip install -r requirements.txt');
    L.push('```');
    L.push('');
    L.push('In each new terminal, activate the environment again (`. .venv/bin/activate`; Windows:');
    L.push('`.venv\\Scripts\\activate`) before the commands below. Once it is active, `python` is the');
    L.push('environment\'s Python on every system.');
    L.push('');
    L.push('## Configure');
    L.push('');
    L.push('Copy the example environment file to `.env`:');
    L.push('');
    L.push('```sh');
    L.push('cp .env.example .env');
    L.push('```');
    L.push('');
    L.push('(Windows: `copy .env.example .env`.) Then edit `.env`: remove the `# ` in front of each variable you');
    L.push('set, and write its value after the `=`.');
    L.push('');
    if (vars.keys.size) {
      for (const [k, provs] of vars.keys) L.push(`- \`${k}\` -- required: the API key for ` + provs.join(', ') + '.');
    } else {
      L.push('- No API key: no node of this workflow calls an LLM provider.');
    }
    for (const [key, url] of vars.decision) {
      L.push(`- \`${key}\` -- optional: a decision model the dispatchers may route with (\`${url}\`: an optional gateway URL).`);
    }
    for (const [url, slug] of entries(vars.mcp)) {
      const up = strtoupper(strval(slug));
      L.push(`- \`MCP_HEADERS_${up}\` -- only if the MCP server at <${url}> needs HTTP headers: a JSON object,`);
      L.push(`  e.g. \`{"Authorization": "Bearer …"}\`. \`MCP_URL_${up}\` is already set to that URL; change it only if`);
      L.push('  the server moved.');
    }
    L.push('');
    L.push('The other variables in `.env.example` are optional. The program reads `.env` from its own folder; a');
    L.push('variable already set in the environment wins over `.env`.');
    L.push('');
    return L;
  }

  /**
   * The intro note of an export that does not carry its skills (it reads them from the editor's folder);
   * none when the workflow uses no skill. skills: the skill folders, in first-use order.
   */
  static editorSkillsNote(skills: string[]): string[] {
    if (skills.length === 0) return [];
    const one = skills.length === 1;
    return ['', 'Its agents run the skill' + (one ? '' : 's') + ' ' + skills.map((d) => `\`${d}\``).join(', ')
      + ', read from `' + PackageDocs.EDITOR_SKILLS_DIR + '` (`SYNERGYAI_SKILLS_DIR` overrides): copy ' + (one ? 'it' : 'them'),
    'there, or export with "agents in separate files" for a folder that carries ' + (one ? 'it' : 'them') + '.'];
  }

  /**
   * The run modes of an entry file whose CLI picks one mode per launch (choose_mode: a flag, then a prompt
   * given on the command line, then the Start's mode). full: it has --watch, --once, --quiet and --verbose
   * (a swarm's workflow.py has only a prompt and --cron).
   */
  static modes(entry: string, startMode: string, defaultCron: string | null, defaultWatch: any, full: boolean): string[] {
    const watchName = (w: any) => `${strval(w['server'])}.${strval(w['tool'])}`;
    const start = startMode === 'cron'
      ? 'a run on each tick of its schedule' + (defaultCron !== null ? ` (\`${defaultCron}\`)` : '') + ', until stopped'
      : startMode === 'watch'
        ? 'a run each time its event trigger' + (defaultWatch !== null ? ` (\`${watchName(defaultWatch)}\`)` : '')
          + ' reports something new, until stopped'
        : 'one run on the Start node\'s prompt';
    const L: string[] = [];
    if (full) {
      L.push('One mode per launch: a flag picks it; else text on the command line means one run on that text; else');
      L.push('the program runs in the mode its Start node set.');
    } else {
      L.push('One mode per launch: `--cron` runs on a schedule; else the program makes one run.');
    }
    L.push('');
    L.push('| Command | Mode |');
    L.push('|---|---|');
    L.push(`| \`python ${entry}\` | the Start node's mode: ${start} |`);
    L.push(`| \`python ${entry} "text"\` | one run on the text |`);
    if (full) L.push(`| \`python ${entry} --once ["text"]\` | exactly one run, even when the Start is scheduled or listens |`);
    L.push(`| \`python ${entry} --cron [EXPR]\` | a run on each tick of a 5-field cron schedule, until stopped`
      + (defaultCron !== null ? ` (no EXPR: \`${defaultCron}\`)` : ' (EXPR required: the Start node has no schedule)') + ' |');
    if (full) {
      L.push(`| \`python ${entry} --watch [TRIGGER]\` | a run each time an MCP tool reports something new, until stopped`
        + (defaultWatch !== null ? ` (no TRIGGER: \`${watchName(defaultWatch)}\`)`
          : ' (TRIGGER required, e.g. `\'outlook.wait_for_new {"args": {"folder": "Inbox"}}\'`)') + ' |');
    }
    L.push('');
    L.push('Text goes before `--cron` (after it, it is read as the cron expression). Ctrl-C (or SIGTERM) stops a loop');
    L.push('after the current run.' + (full ? ' `--quiet` prints only the done / failed line of each run; `--verbose` adds each' : ''));
    if (full) L.push('node\'s output.');
    L.push('');
    return L;
  }

  /**
   * Running entry as a service: a launchd agent (macOS) and a systemd unit (Linux), with the folder's own
   * environment's Python. args: the arguments after the entry file, '' for none.
   */
  static service(name: string, title: string, folder: string, entry: string, args: string, startMode: string): string[] {
    const sl = strtolower(trim(preg_replace('/[^a-z0-9]+/i', '-', name), '-'));
    const slug = sl !== '' && sl !== '0' ? sl : 'workflow';
    const tail = args === '' ? '' : ` ${args}`;
    const L: string[] = [];
    L.push('## Running as a service');
    L.push('');
    L.push(`Replace \`/path/to/${folder}\` (Windows: \`C:\\path\\to\\${folder}\`) with this folder's absolute path.`);
    if (startMode === 'prompt' && args === '') {
      L.push('This workflow\'s default is one run, and a service is restarted when it exits: add `--cron EXPR`'
        + ` (or another loop flag) after \`${entry}\` so it keeps running.`);
    }
    L.push('');
    L.push(`macOS (launchd): save as \`~/Library/LaunchAgents/ai.synergy.${slug}.plist\`, then`);
    L.push(`\`launchctl load ~/Library/LaunchAgents/ai.synergy.${slug}.plist\`.`);
    L.push('');
    L.push('```xml');
    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
    L.push('<plist version="1.0">');
    L.push('<dict>');
    L.push('  <key>Label</key>');
    L.push(`  <string>ai.synergy.${slug}</string>`);
    L.push('  <key>ProgramArguments</key>');
    L.push('  <array>');
    L.push(`    <string>/path/to/${folder}/.venv/bin/python</string>`);
    L.push(`    <string>/path/to/${folder}/${entry}</string>`);
    for (const a of args === '' ? [] : args.split(' ')) L.push(`    <string>${a}</string>`);
    L.push('  </array>');
    L.push('  <key>WorkingDirectory</key>');
    L.push(`  <string>/path/to/${folder}</string>`);
    L.push('  <key>KeepAlive</key>');
    L.push('  <true/>');
    // In the folder itself: launchd creates no folder, and a fresh unzip has no runs/.
    L.push('  <key>StandardOutPath</key>');
    L.push(`  <string>/path/to/${folder}/service.log</string>`);
    L.push('  <key>StandardErrorPath</key>');
    L.push(`  <string>/path/to/${folder}/service.log</string>`);
    L.push('</dict>');
    L.push('</plist>');
    L.push('```');
    L.push('');
    L.push(`Linux (systemd): save as \`/etc/systemd/system/${slug}.service\`, then \`systemctl enable --now ${slug}\`.`);
    L.push('');
    L.push('```ini');
    L.push('[Unit]');
    L.push(`Description=${name} (${title})`);
    L.push('After=network-online.target');
    L.push('');
    L.push('[Service]');
    L.push(`ExecStart=/path/to/${folder}/.venv/bin/python /path/to/${folder}/${entry}` + tail);
    L.push(`WorkingDirectory=/path/to/${folder}`);
    L.push('Restart=always');
    L.push('');
    L.push('[Install]');
    L.push('WantedBy=multi-user.target');
    L.push('```');
    L.push('');
    L.push('Windows (Task Scheduler): create a task triggered "At startup" whose action starts the program');
    L.push(`\`C:\\path\\to\\${folder}\\.venv\\Scripts\\python.exe\` with the arguments \`${entry}` + tail
      + `\`, starting in \`C:\\path\\to\\${folder}\`.`);
    L.push('');
    return L;
  }

  /** The run server section: api.py's flags as its argparse defines them. listen: it has --listen. */
  static runServer(listen: boolean, note: string[] = []): string[] {
    const L: string[] = [];
    L.push('## Run server');
    L.push('');
    L.push('```sh');
    L.push('python api.py                # HTTP run server on http://127.0.0.1:8710/ (POST /runs, an SSE event stream per run)');
    L.push('python api.py --port 8800    # another port; --host 0.0.0.0 to serve the LAN');
    if (listen) {
      L.push('python api.py --listen       # the same, plus the Start\'s schedule / event trigger running in the background');
    }
    L.push('```');
    L.push('');
    L.push('This is the server the SynergyAI editor talks to. `WORKFLOW_API_HOST` / `WORKFLOW_API_PORT` set the');
    L.push('defaults. It has no authentication: bind it to 127.0.0.1 or a trusted LAN interface only.');
    L.push(...note);
    L.push('');
    return L;
  }
}
