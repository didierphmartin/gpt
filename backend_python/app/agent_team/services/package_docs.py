"""Port of backend/src/AgentTeam/Services/PackageDocs.php.

The text an exported folder explains itself with, shared by every compile target: .env.example, and the
README sections whose facts do not depend on the target (requirements, getting the folder, installing,
configuring, the Start's run modes, running as a service). LangGraphPackage and CompiledPackage say what
their programs are and which files run them; the environment variables come from one place (their
envVariables()), so .env.example and the README name the same ones.

vars, the environment a program reads: {'keys': {KEY: [provider, ...]}, 'decision': {KEY: URL_KEY},
'mcp': {url: slug}, 'model': what MODEL_NAME does, or None when the program does not read it}.
"""
from __future__ import annotations

import re


class PackageDocs:
    # Where the editor keeps skills: a single file reads them from there (SYNERGYAI_SKILLS_DIR overrides).
    EDITOR_SKILLS_DIR = '~/Documents/synergyAI/skills'

    @staticmethod
    def envExample(wfName: str, vars: dict, optional: list) -> str:
        """.env.example: every variable the program reads, commented. optional: [what it does, "KEY=example"]."""
        L = ['# Environment of the workflow "' + wfName + '" -- copy this file to .env and fill it in.',
             '# The program reads .env from its own folder first, then from the folder two levels up',
             "# (a local runner's .env). A variable already set in the environment is never overridden.",
             '']
        if vars['keys']:
            L.append('# API keys of the LLM providers this workflow uses')
            for k, provs in vars['keys'].items():
                L.append('# ' + ', '.join(provs))
                L.append(f'# {k}=')
        else:
            L.append('# No LLM provider is used by a node of this workflow.')
        L.append('')
        if vars['decision']:
            L.append('# Decision models the dispatchers may route with (each URL variable is optional: a gateway)')
            for key, url in vars['decision'].items():
                L.append(f'# {key}=')
                L.append(f'# {url}=')
            L.append('')
        if vars['mcp']:
            L.append('# MCP servers: the URL compiled in, and the HTTP headers the server needs (never compiled in)')
            for url, slug in vars['mcp'].items():
                up = str(slug).upper()
                L.append(f'MCP_URL_{up}={url}')
                L.append('# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}')
                L.append(f'# MCP_HEADERS_{up}=')
            L.append('')
        L.append('# Optional')
        if vars['model'] is not None:
            L.append(f"# {vars['model']}")
            L.append('# MODEL_NAME=')
        for what, line in optional:
            L.append(f'# {what}')
            L.append(f'# {line}')
        return '\n'.join(L) + '\n'

    @staticmethod
    def head(name: str, intro: list, folder: str, vars: dict) -> list:
        """The README from its title through "Configure": what the folder is, what it needs, how to get into
        it, install the packages and fill in .env. intro: the opening paragraph, one line per entry."""
        L = [f'# {name}', '', *intro, '']
        L.append('## Requirements')
        L.append('')
        L.append('- Python 3.10 or newer (the code uses `match` statements). Check with `python3 --version`')
        L.append('  (Windows: `py --version`).')
        if vars['keys']:
            L.append('- An API key for each LLM provider the workflow uses: '
                     + ', '.join(', '.join(p) + f' (`{k}`)' for k, p in vars['keys'].items()) + '.')
        if vars['mcp']:
            L.append('- Network access to the MCP server' + ('s' if len(vars['mcp']) > 1 else '') + ' it calls: '
                     + ', '.join(f'<{u}>' for u in vars['mcp']) + '.')
        L.append('')
        L.append('## Get the folder')
        L.append('')
        L.append(f'The export is a zip holding one folder, `{folder}`. Unzip it (Windows: right-click the zip, then')
        L.append('"Extract All"), open a terminal and go into that folder: every command below runs from there.')
        L.append('')
        L.append('```sh')
        L.append(f'cd {folder}')
        L.append('```')
        L.append('')
        L.append('## Install')
        L.append('')
        L.append('Create a virtual environment in the folder and install the packages of `requirements.txt` into it.')
        L.append('')
        L.append('macOS / Linux:')
        L.append('')
        L.append('```sh')
        L.append('python3 -m venv .venv')
        L.append('. .venv/bin/activate')
        L.append('pip install -r requirements.txt')
        L.append('```')
        L.append('')
        L.append('Windows (PowerShell or Command Prompt):')
        L.append('')
        L.append('```bat')
        L.append('py -m venv .venv')
        L.append('.venv\\Scripts\\activate')
        L.append('pip install -r requirements.txt')
        L.append('```')
        L.append('')
        L.append('In each new terminal, activate the environment again (`. .venv/bin/activate`; Windows:')
        L.append('`.venv\\Scripts\\activate`) before the commands below. Once it is active, `python` is the')
        L.append("environment's Python on every system.")
        L.append('')
        L.append('## Configure')
        L.append('')
        L.append('Copy the example environment file to `.env`:')
        L.append('')
        L.append('```sh')
        L.append('cp .env.example .env')
        L.append('```')
        L.append('')
        L.append('(Windows: `copy .env.example .env`.) Then edit `.env`: remove the `# ` in front of each variable you')
        L.append('set, and write its value after the `=`.')
        L.append('')
        if vars['keys']:
            for k, provs in vars['keys'].items():
                L.append(f'- `{k}` -- required: the API key for ' + ', '.join(provs) + '.')
        else:
            L.append('- No API key: no node of this workflow calls an LLM provider.')
        for key, url in vars['decision'].items():
            L.append(f'- `{key}` -- optional: a decision model the dispatchers may route with (`{url}`: an optional gateway URL).')
        for url, slug in vars['mcp'].items():
            up = str(slug).upper()
            L.append(f'- `MCP_HEADERS_{up}` -- only if the MCP server at <{url}> needs HTTP headers: a JSON object,')
            L.append(f'  e.g. `{{"Authorization": "Bearer …"}}`. `MCP_URL_{up}` is already set to that URL; change it only if')
            L.append('  the server moved.')
        if vars['model'] is not None:
            L.append('- `MODEL_NAME` -- optional: ' + vars['model'][:1].lower() + vars['model'][1:] + '.')
        L.append('')
        L.append('The other variables in `.env.example` are optional. The program reads `.env` from its own folder; a')
        L.append('variable already set in the environment wins over `.env`.')
        L.append('')
        return L

    @classmethod
    def editorSkillsNote(cls, skills: list) -> list:
        """The intro note of an export that does not carry its skills (it reads them from the editor's folder);
        none when the workflow uses no skill. skills: the skill folders, in first-use order."""
        if not skills:
            return []
        one = len(skills) == 1
        return ['', 'Its agents run the skill' + ('' if one else 's') + ' ' + ', '.join(f'`{d}`' for d in skills)
                + ', read from `' + cls.EDITOR_SKILLS_DIR + '` (`SYNERGYAI_SKILLS_DIR` overrides): copy ' + ('it' if one else 'them'),
                'there, or export with "agents in separate files" for a folder that carries ' + ('it' if one else 'them') + '.']

    @staticmethod
    def modes(entry: str, startMode: str, defaultCron, defaultWatch, full: bool) -> list:
        """The run modes of an entry file whose CLI picks one mode per launch (choose_mode: a flag, then a
        prompt given on the command line, then the Start's mode). full: it has --watch, --once, --quiet and
        --verbose (a swarm's workflow.py has only a prompt and --cron)."""
        if startMode == 'cron':
            start = 'a run on each tick of its schedule' + (f' (`{defaultCron}`)' if defaultCron is not None else '') + ', until stopped'
        elif startMode == 'watch':
            start = ('a run each time its event trigger'
                     + (f" (`{defaultWatch['server']}.{defaultWatch['tool']}`)" if defaultWatch is not None else '')
                     + ' reports something new, until stopped')
        else:
            start = "one run on the Start node's prompt"
        L = []
        if full:
            L.append('One mode per launch: a flag picks it; else text on the command line means one run on that text; else')
            L.append('the program runs in the mode its Start node set.')
        else:
            L.append('One mode per launch: `--cron` runs on a schedule; else the program makes one run.')
        L.append('')
        L.append('| Command | Mode |')
        L.append('|---|---|')
        L.append(f"| `python {entry}` | the Start node's mode: {start} |")
        L.append(f'| `python {entry} "text"` | one run on the text |')
        if full:
            L.append(f'| `python {entry} --once ["text"]` | exactly one run, even when the Start is scheduled or listens |')
        L.append(f'| `python {entry} --cron [EXPR]` | a run on each tick of a 5-field cron schedule, until stopped'
                 + (f' (no EXPR: `{defaultCron}`)' if defaultCron is not None else ' (EXPR required: the Start node has no schedule)') + ' |')
        if full:
            L.append(f'| `python {entry} --watch [TRIGGER]` | a run each time an MCP tool reports something new, until stopped'
                     + (f" (no TRIGGER: `{defaultWatch['server']}.{defaultWatch['tool']}`)" if defaultWatch is not None
                        else ' (TRIGGER required, e.g. `\'outlook.wait_for_new {"args": {"folder": "Inbox"}}\'`)') + ' |')
        L.append('')
        L.append('Text goes before `--cron` (after it, it is read as the cron expression). Ctrl-C (or SIGTERM) stops a loop')
        L.append('after the current run.' + (' `--quiet` prints only the done / failed line of each run; `--verbose` adds each' if full else ''))
        if full:
            L.append("node's output.")
        L.append('')
        return L

    @staticmethod
    def service(name: str, title: str, folder: str, entry: str, args: str, startMode: str) -> list:
        """Running entry as a service: a launchd agent (macOS) and a systemd unit (Linux), with the folder's own
        environment's Python. args: the arguments after the entry file, '' for none."""
        slug = re.sub(r'[^a-z0-9]+', '-', name, flags=re.IGNORECASE | re.ASCII).strip('-').lower()
        if slug in ('', '0'):
            slug = 'workflow'
        L = []
        L.append('## Running as a service')
        L.append('')
        L.append(f"Replace `/path/to/{folder}` (Windows: `C:\\path\\to\\{folder}`) with this folder's absolute path.")
        if startMode == 'prompt' and args == '':
            L.append("This workflow's default is one run, and a service is restarted when it exits: add `--cron EXPR`"
                     + f' (or another loop flag) after `{entry}` so it keeps running.')
        L.append('')
        L.append(f'macOS (launchd): save as `~/Library/LaunchAgents/ai.synergy.{slug}.plist`, then')
        L.append(f'`launchctl load ~/Library/LaunchAgents/ai.synergy.{slug}.plist`.')
        L.append('')
        L.append('```xml')
        L.append('<?xml version="1.0" encoding="UTF-8"?>')
        L.append('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">')
        L.append('<plist version="1.0">')
        L.append('<dict>')
        L.append('  <key>Label</key>')
        L.append(f'  <string>ai.synergy.{slug}</string>')
        L.append('  <key>ProgramArguments</key>')
        L.append('  <array>')
        L.append(f'    <string>/path/to/{folder}/.venv/bin/python</string>')
        L.append(f'    <string>/path/to/{folder}/{entry}</string>')
        for a in ([] if args == '' else args.split(' ')):
            L.append(f'    <string>{a}</string>')
        L.append('  </array>')
        L.append('  <key>WorkingDirectory</key>')
        L.append(f'  <string>/path/to/{folder}</string>')
        L.append('  <key>KeepAlive</key>')
        L.append('  <true/>')
        # In the folder itself: launchd creates no folder, and a fresh unzip has no runs/.
        L.append('  <key>StandardOutPath</key>')
        L.append(f'  <string>/path/to/{folder}/service.log</string>')
        L.append('  <key>StandardErrorPath</key>')
        L.append(f'  <string>/path/to/{folder}/service.log</string>')
        L.append('</dict>')
        L.append('</plist>')
        L.append('```')
        L.append('')
        L.append(f'Linux (systemd): save as `/etc/systemd/system/{slug}.service`, then `systemctl enable --now {slug}`.')
        L.append('')
        L.append('```ini')
        L.append('[Unit]')
        L.append(f'Description={name} ({title})')
        L.append('After=network-online.target')
        L.append('')
        L.append('[Service]')
        L.append(f'ExecStart=/path/to/{folder}/.venv/bin/python /path/to/{folder}/{entry}' + ('' if args == '' else f' {args}'))
        L.append(f'WorkingDirectory=/path/to/{folder}')
        L.append('Restart=always')
        L.append('')
        L.append('[Install]')
        L.append('WantedBy=multi-user.target')
        L.append('```')
        L.append('')
        L.append('Windows (Task Scheduler): create a task triggered "At startup" whose action starts the program')
        L.append(f'`C:\\path\\to\\{folder}\\.venv\\Scripts\\python.exe` with the arguments `{entry}' + ('' if args == '' else f' {args}')
                 + f'`, starting in `C:\\path\\to\\{folder}`.')
        L.append('')
        return L

    @staticmethod
    def runServer(listen: bool, note: list | None = None) -> list:
        """The run server section: api.py's flags as its argparse defines them. listen: it has --listen."""
        L = []
        L.append('## Run server')
        L.append('')
        L.append('```sh')
        L.append('python api.py                # HTTP run server on http://127.0.0.1:8710/ (POST /runs, an SSE event stream per run)')
        L.append('python api.py --port 8800    # another port; --host 0.0.0.0 to serve the LAN')
        if listen:
            L.append("python api.py --listen       # the same, plus the Start's schedule / event trigger running in the background")
        L.append('```')
        L.append('')
        L.append('This is the server the SynergyAI editor talks to. `WORKFLOW_API_HOST` / `WORKFLOW_API_PORT` set the')
        L.append('defaults. It has no authentication: bind it to 127.0.0.1 or a trusted LAN interface only.')
        L += list(note or [])
        L.append('')
        return L
