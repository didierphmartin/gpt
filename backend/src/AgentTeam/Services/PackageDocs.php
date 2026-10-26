<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * The text an exported folder explains itself with, shared by every compile target: .env.example, and the
 * README sections whose facts do not depend on the target (requirements, getting the folder, installing,
 * configuring, the Start's run modes, running as a service). LangGraphPackage and CompiledPackage say what
 * their programs are and which files run them; the environment variables come from one place (their
 * envVariables()), so .env.example and the README name the same ones.
 *
 * $vars, the environment a program reads: ['keys' => [KEY => list<provider>], 'decision' => [KEY => URL_KEY],
 * 'mcp' => [url => slug]].
 */
final class PackageDocs
{
    /** Where the editor keeps skills: a single file reads them from there (SYNERGYAI_SKILLS_DIR overrides). */
    public const EDITOR_SKILLS_DIR = '~/Documents/synergyAI/skills';

    /**
     * .env.example: every variable the program reads, commented. A variable with no value to suggest is a
     * comment too: an empty KEY= line in a copied .env would mask the runner's python/.env (the program reads
     * its own .env first, and an empty value counts as set).
     *
     * @param list<array{0:string,1:string}> $optional [what it does, "KEY=example"]
     */
    public static function envExample(string $wfName, array $vars, array $optional): string
    {
        $L = [];
        $L[] = '# Environment of the workflow "' . $wfName . '" -- copy this file to .env and fill it in.';
        $L[] = '# The program reads .env from its own folder first, then from the folder two levels up';
        $L[] = '# (a local runner\'s .env). A variable already set in the environment is never overridden.';
        $L[] = '';
        if ($vars['keys']) {
            $L[] = '# API keys of the LLM providers this workflow uses';
            foreach ($vars['keys'] as $k => $provs) {
                $L[] = '# ' . implode(', ', $provs);
                $L[] = "# {$k}=";
            }
        } else {
            $L[] = '# No LLM provider is used by a node of this workflow.';
        }
        $L[] = '';
        if ($vars['decision']) {
            $L[] = '# Decision models the dispatchers may route with (each URL variable is optional: a gateway)';
            foreach ($vars['decision'] as $key => $url) {
                $L[] = "# {$key}=";
                $L[] = "# {$url}=";
            }
            $L[] = '';
        }
        if ($vars['mcp']) {
            $L[] = '# MCP servers: the URL compiled in, and the HTTP headers the server needs (never compiled in)';
            foreach ($vars['mcp'] as $url => $slug) {
                $up = strtoupper((string) $slug);
                $L[] = "MCP_URL_{$up}={$url}";
                $L[] = '# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}';
                $L[] = "# MCP_HEADERS_{$up}=";
            }
            $L[] = '';
        }
        $L[] = '# Optional';
        foreach ($optional as [$what, $line]) {
            $L[] = "# {$what}";
            $L[] = "# {$line}";
        }
        return implode("\n", $L) . "\n";
    }

    /**
     * The README from its title through "Configure": what the folder is, what it needs, how to get into
     * it, install the packages and fill in .env.
     *
     * @param list<string> $intro the opening paragraph, one line per entry
     */
    public static function head(string $name, array $intro, string $folder, array $vars): array
    {
        $L = ["# {$name}", '', ...$intro, ''];
        $L[] = '## Requirements';
        $L[] = '';
        $L[] = '- Python 3.10 or newer (the code uses `match` statements). Check with `python3 --version`';
        $L[] = '  (Windows: `py --version`).';
        if ($vars['keys']) {
            $L[] = '- An API key for each LLM provider the workflow uses: '
                . implode(', ', array_map(fn($k, $p) => implode(', ', $p) . " (`{$k}`)", array_keys($vars['keys']), $vars['keys'])) . '.';
        }
        if ($vars['mcp']) {
            $L[] = '- Network access to the MCP server' . (count($vars['mcp']) > 1 ? 's' : '') . ' it calls: '
                . implode(', ', array_map(fn($u) => "<{$u}>", array_keys($vars['mcp']))) . '.';
        }
        $L[] = '';
        $L[] = '## Get the folder';
        $L[] = '';
        $L[] = "The export is a zip holding one folder, `{$folder}`. Unzip it (Windows: right-click the zip, then";
        $L[] = '"Extract All"), open a terminal and go into that folder: every command below runs from there.';
        $L[] = '';
        $L[] = '```sh';
        $L[] = "cd {$folder}";
        $L[] = '```';
        $L[] = '';
        $L[] = '## Install';
        $L[] = '';
        $L[] = 'Create a virtual environment in the folder and install the packages of `requirements.txt` into it.';
        $L[] = '';
        $L[] = 'macOS / Linux:';
        $L[] = '';
        $L[] = '```sh';
        $L[] = 'python3 -m venv .venv';
        $L[] = '. .venv/bin/activate';
        $L[] = 'pip install -r requirements.txt';
        $L[] = '```';
        $L[] = '';
        $L[] = 'Windows (PowerShell or Command Prompt):';
        $L[] = '';
        $L[] = '```bat';
        $L[] = 'py -m venv .venv';
        $L[] = '.venv\Scripts\activate';
        $L[] = 'pip install -r requirements.txt';
        $L[] = '```';
        $L[] = '';
        $L[] = 'In each new terminal, activate the environment again (`. .venv/bin/activate`; Windows:';
        $L[] = '`.venv\Scripts\activate`) before the commands below. Once it is active, `python` is the';
        $L[] = 'environment\'s Python on every system.';
        $L[] = '';
        $L[] = '## Configure';
        $L[] = '';
        $L[] = 'Copy the example environment file to `.env`:';
        $L[] = '';
        $L[] = '```sh';
        $L[] = 'cp .env.example .env';
        $L[] = '```';
        $L[] = '';
        $L[] = '(Windows: `copy .env.example .env`.) Then edit `.env`: remove the `# ` in front of each variable you';
        $L[] = 'set, and write its value after the `=`.';
        $L[] = '';
        if ($vars['keys']) {
            foreach ($vars['keys'] as $k => $provs) {
                $L[] = "- `{$k}` -- required: the API key for " . implode(', ', $provs) . '.';
            }
        } else {
            $L[] = '- No API key: no node of this workflow calls an LLM provider.';
        }
        foreach ($vars['decision'] as $key => $url) {
            $L[] = "- `{$key}` -- optional: a decision model the dispatchers may route with (`{$url}`: an optional gateway URL).";
        }
        foreach ($vars['mcp'] as $url => $slug) {
            $up = strtoupper((string) $slug);
            $L[] = "- `MCP_HEADERS_{$up}` -- only if the MCP server at <{$url}> needs HTTP headers: a JSON object,";
            $L[] = "  e.g. `{\"Authorization\": \"Bearer …\"}`. `MCP_URL_{$up}` is already set to that URL; change it only if";
            $L[] = '  the server moved.';
        }
        $L[] = '';
        $L[] = 'The other variables in `.env.example` are optional. The program reads `.env` from its own folder; a';
        $L[] = 'variable already set in the environment wins over `.env`.';
        $L[] = '';
        return $L;
    }

    /**
     * The intro note of an export that does not carry its skills (it reads them from the editor's folder);
     * none when the workflow uses no skill. $skills: the skill folders, in first-use order.
     */
    public static function editorSkillsNote(array $skills): array
    {
        if ($skills === []) {
            return [];
        }
        $one = count($skills) === 1;
        return ['', 'Its agents run the skill' . ($one ? '' : 's') . ' ' . implode(', ', array_map(fn($d) => "`{$d}`", $skills))
            . ', read from `' . self::EDITOR_SKILLS_DIR . '` (`SYNERGYAI_SKILLS_DIR` overrides): copy ' . ($one ? 'it' : 'them'),
            'there, or export with "agents in separate files" for a folder that carries ' . ($one ? 'it' : 'them') . '.'];
    }

    /**
     * The run modes of an entry file whose CLI picks one mode per launch (choose_mode: a flag, then a prompt
     * given on the command line, then the Start's mode). $full: it has --watch, --once, --quiet and --verbose
     * (a swarm's workflow.py has only a prompt and --cron).
     */
    public static function modes(string $entry, string $startMode, ?string $defaultCron, ?array $defaultWatch, bool $full): array
    {
        $start = match ($startMode) {
            'cron' => 'a run on each tick of its schedule' . ($defaultCron !== null ? " (`{$defaultCron}`)" : '') . ', until stopped',
            'watch' => 'a run each time its event trigger' . ($defaultWatch !== null ? " (`{$defaultWatch['server']}.{$defaultWatch['tool']}`)" : '')
                . ' reports something new, until stopped',
            default => 'one run on the Start node\'s prompt',
        };
        $L = [];
        if ($full) {
            $L[] = 'One mode per launch: a flag picks it; else text on the command line means one run on that text; else';
            $L[] = 'the program runs in the mode its Start node set.';
        } else {
            $L[] = 'One mode per launch: `--cron` runs on a schedule; else the program makes one run.';
        }
        $L[] = '';
        $L[] = '| Command | Mode |';
        $L[] = '|---|---|';
        $L[] = "| `python {$entry}` | the Start node's mode: {$start} |";
        $L[] = "| `python {$entry} \"text\"` | one run on the text |";
        if ($full) {
            $L[] = "| `python {$entry} --once [\"text\"]` | exactly one run, even when the Start is scheduled or listens |";
        }
        $L[] = "| `python {$entry} --cron [EXPR]` | a run on each tick of a 5-field cron schedule, until stopped"
            . ($defaultCron !== null ? " (no EXPR: `{$defaultCron}`)" : ' (EXPR required: the Start node has no schedule)') . ' |';
        if ($full) {
            $L[] = "| `python {$entry} --watch [TRIGGER]` | a run each time an MCP tool reports something new, until stopped"
                . ($defaultWatch !== null ? " (no TRIGGER: `{$defaultWatch['server']}.{$defaultWatch['tool']}`)"
                    : ' (TRIGGER required, e.g. `\'outlook.wait_for_new {"args": {"folder": "Inbox"}}\'`)') . ' |';
        }
        $L[] = '';
        $L[] = "Text goes before `--cron` (after it, it is read as the cron expression). Ctrl-C (or SIGTERM) stops a loop";
        $L[] = 'after the current run.' . ($full ? ' `--quiet` prints only the done / failed line of each run; `--verbose` adds each' : '');
        if ($full) {
            $L[] = 'node\'s output.';
        }
        $L[] = '';
        return $L;
    }

    /**
     * Running $entry as a service: a launchd agent (macOS) and a systemd unit (Linux), with the folder's own
     * environment's Python. $args: the arguments after the entry file, '' for none.
     */
    public static function service(string $name, string $title, string $folder, string $entry, string $args, string $startMode): array
    {
        $slug = strtolower(trim((string) preg_replace('/[^a-z0-9]+/i', '-', $name), '-')) ?: 'workflow';
        $L = [];
        $L[] = '## Running as a service';
        $L[] = '';
        $L[] = "Replace `/path/to/{$folder}` (Windows: `C:\\path\\to\\{$folder}`) with this folder's absolute path.";
        if ($startMode === 'prompt' && $args === '') {
            $L[] = 'This workflow\'s default is one run, and a service is restarted when it exits: add `--cron EXPR`'
                . " (or another loop flag) after `{$entry}` so it keeps running.";
        }
        $L[] = '';
        $L[] = "macOS (launchd): save as `~/Library/LaunchAgents/ai.synergy.{$slug}.plist`, then";
        $L[] = "`launchctl load ~/Library/LaunchAgents/ai.synergy.{$slug}.plist`.";
        $L[] = '';
        $L[] = '```xml';
        $L[] = '<?xml version="1.0" encoding="UTF-8"?>';
        $L[] = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
        $L[] = '<plist version="1.0">';
        $L[] = '<dict>';
        $L[] = '  <key>Label</key>';
        $L[] = "  <string>ai.synergy.{$slug}</string>";
        $L[] = '  <key>ProgramArguments</key>';
        $L[] = '  <array>';
        $L[] = "    <string>/path/to/{$folder}/.venv/bin/python</string>";
        $L[] = "    <string>/path/to/{$folder}/{$entry}</string>";
        foreach ($args === '' ? [] : explode(' ', $args) as $a) {
            $L[] = "    <string>{$a}</string>";
        }
        $L[] = '  </array>';
        $L[] = '  <key>WorkingDirectory</key>';
        $L[] = "  <string>/path/to/{$folder}</string>";
        $L[] = '  <key>KeepAlive</key>';
        $L[] = '  <true/>';
        // In the folder itself: launchd creates no folder, and a fresh unzip has no runs/.
        $L[] = '  <key>StandardOutPath</key>';
        $L[] = "  <string>/path/to/{$folder}/service.log</string>";
        $L[] = '  <key>StandardErrorPath</key>';
        $L[] = "  <string>/path/to/{$folder}/service.log</string>";
        $L[] = '</dict>';
        $L[] = '</plist>';
        $L[] = '```';
        $L[] = '';
        $L[] = "Linux (systemd): save as `/etc/systemd/system/{$slug}.service`, then `systemctl enable --now {$slug}`.";
        $L[] = '';
        $L[] = '```ini';
        $L[] = '[Unit]';
        $L[] = "Description={$name} ({$title})";
        $L[] = 'After=network-online.target';
        $L[] = '';
        $L[] = '[Service]';
        $L[] = "ExecStart=/path/to/{$folder}/.venv/bin/python /path/to/{$folder}/{$entry}" . ($args === '' ? '' : " {$args}");
        $L[] = "WorkingDirectory=/path/to/{$folder}";
        $L[] = 'Restart=always';
        $L[] = '';
        $L[] = '[Install]';
        $L[] = 'WantedBy=multi-user.target';
        $L[] = '```';
        $L[] = '';
        $L[] = 'Windows (Task Scheduler): create a task triggered "At startup" whose action starts the program';
        $L[] = "`C:\\path\\to\\{$folder}\\.venv\\Scripts\\python.exe` with the arguments `{$entry}" . ($args === '' ? '' : " {$args}")
            . "`, starting in `C:\\path\\to\\{$folder}`.";
        $L[] = '';
        return $L;
    }

    /** The run server section: api.py's flags as its argparse defines them. $listen: it has --listen. */
    public static function runServer(bool $listen, array $note = []): array
    {
        $L = [];
        $L[] = '## Run server';
        $L[] = '';
        $L[] = '```sh';
        $L[] = 'python api.py                # HTTP run server on http://127.0.0.1:8710/ (POST /runs, an SSE event stream per run)';
        $L[] = 'python api.py --port 8800    # another port; --host 0.0.0.0 to serve the LAN';
        if ($listen) {
            $L[] = 'python api.py --listen       # the same, plus the Start\'s schedule / event trigger running in the background';
        }
        $L[] = '```';
        $L[] = '';
        $L[] = 'This is the server the SynergyAI editor talks to. `WORKFLOW_API_HOST` / `WORKFLOW_API_PORT` set the';
        $L[] = 'defaults. It has no authentication: bind it to 127.0.0.1 or a trusted LAN interface only.';
        array_push($L, ...$note);
        $L[] = '';
        return $L;
    }
}
