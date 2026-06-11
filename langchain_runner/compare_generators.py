"""Compare Python vs PHP generator output for a given workflow.

Runs both generators against the same workflow ID, writes both outputs
side by side, and prints a unified diff. Useful for verifying the PHP
port stays in sync as we add features.

Usage:
    python compare_generators.py <workflow_id> [--backend-url URL] [--jwt TOKEN]

Env fallbacks:
    BACKEND_URL, BACKEND_JWT, PHP_CLI (default: php)
"""
from __future__ import annotations

import argparse
import asyncio
import difflib
import hashlib
import os
import subprocess
import sys
from pathlib import Path

from code_generator import generate_code
from workflow_loader import WorkflowLoader


PHP_BOOTSTRAP = r"""
<?php
declare(strict_types=1);

$autoload = __DIR__ . '/../backend/vendor/autoload.php';
if (!file_exists($autoload)) {
    fwrite(STDERR, "Autoload not found: $autoload\n");
    exit(1);
}
require $autoload;

use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

$configPath = __DIR__ . '/../backend/config.php';
if (!file_exists($configPath)) {
    fwrite(STDERR, "config.php not found at $configPath\n");
    exit(1);
}
$config = require $configPath;

$dbCfg = $config['database'] ?? $config['db'] ?? [];
$dsn = sprintf(
    "mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4",
    $dbCfg['host'] ?? 'localhost',
    (int)($dbCfg['port'] ?? 3306),
    $dbCfg['database'] ?? $dbCfg['name'] ?? ''
);
$pdo = new PDO($dsn, $dbCfg['username'] ?? $dbCfg['user'] ?? 'root',
               $dbCfg['password'] ?? $dbCfg['pass'] ?? '',
               [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);

$workflowId = (int)($argv[1] ?? 0);
if ($workflowId <= 0) {
    fwrite(STDERR, "Usage: php bootstrap.php <workflow_id>\n");
    exit(2);
}

$wfRepo    = new WorkflowRepository($pdo);
$graphRepo = new WorkflowGraphRepository($pdo);
$agentRepo = new AgentRepository($pdo);
$gen       = new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo);

try {
    $result = $gen->generate($workflowId);
} catch (Throwable $e) {
    fwrite(STDERR, "PHP generator failed: " . $e->getMessage() . "\n");
    exit(3);
}
echo $result['code'];
"""


def run_php_generator(php_cli: str, workflow_id: int) -> str:
    """Run the PHP generator via a temp bootstrap and return the code output."""
    bootstrap = Path(__file__).parent / "_php_bootstrap.php"
    bootstrap.write_text(PHP_BOOTSTRAP)
    try:
        proc = subprocess.run(
            [php_cli, str(bootstrap), str(workflow_id)],
            capture_output=True, text=True, timeout=60,
        )
    finally:
        bootstrap.unlink(missing_ok=True)

    if proc.returncode != 0:
        print("── PHP generator stderr ──", file=sys.stderr)
        print(proc.stderr, file=sys.stderr)
        sys.exit(proc.returncode)
    return proc.stdout


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workflow_id", type=int)
    ap.add_argument("--backend-url",
                    default=os.environ.get("BACKEND_URL", "http://localhost/gpt/backend"))
    ap.add_argument("--jwt", default=os.environ.get("BACKEND_JWT", ""))
    ap.add_argument("--php", default=os.environ.get("PHP_CLI", "php"))
    ap.add_argument("--write", action="store_true",
                    help="Write both outputs to disk (py_<id>.py / php_<id>.py)")
    args = ap.parse_args()

    if not args.jwt:
        print("BACKEND_JWT required (env or --jwt)", file=sys.stderr)
        return 1

    print(f"[1/2] Running Python generator against workflow {args.workflow_id}…")
    loader = WorkflowLoader(args.backend_url, args.jwt)
    py_result = await generate_code(args.workflow_id, loader)
    py_code = py_result["code"]

    print(f"[2/2] Running PHP generator against workflow {args.workflow_id}…")
    php_code = run_php_generator(args.php, args.workflow_id)

    # Normalize trailing newline differences
    py_code = py_code.rstrip() + "\n"
    php_code = php_code.rstrip() + "\n"

    py_md5 = hashlib.md5(py_code.encode()).hexdigest()
    php_md5 = hashlib.md5(php_code.encode()).hexdigest()

    if args.write:
        out_dir = Path(__file__).parent
        (out_dir / f"py_{args.workflow_id}.py").write_text(py_code)
        (out_dir / f"php_{args.workflow_id}.py").write_text(php_code)
        print(f"Wrote py_{args.workflow_id}.py and php_{args.workflow_id}.py")

    print()
    print(f"Python generator MD5 : {py_md5}  ({len(py_code)} bytes)")
    print(f"PHP    generator MD5 : {php_md5}  ({len(php_code)} bytes)")
    print()

    if py_code == php_code:
        print("✓ IDENTICAL — both generators produce byte-for-byte equal output.")
        return 0

    print("✗ DIFFER — unified diff below:\n")
    diff = difflib.unified_diff(
        py_code.splitlines(keepends=True),
        php_code.splitlines(keepends=True),
        fromfile=f"python/workflow_{args.workflow_id}.py",
        tofile=f"php/workflow_{args.workflow_id}.py",
        n=3,
    )
    sys.stdout.writelines(diff)
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
