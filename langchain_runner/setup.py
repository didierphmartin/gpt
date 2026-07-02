"""One-shot installer for the langchain_runner.

Copies the runtime files into the user's local environment at
~/Documents/synergyAI/python/, builds a virtual environment there, and
pip-installs both the LangGraph and Google ADK stacks (so LangGraph- and
ADK-compiled scripts run from the same venv). Re-run with --force to pick up
requirements.txt changes on an existing install.

Usage:
    python3 setup.py                       # install at default location
    python3 setup.py --path /other/place   # install elsewhere
    python3 setup.py --force               # overwrite existing files
    python3 setup.py --skip-venv           # copy files only, no env build

After install, start the runner with:
    cd ~/Documents/synergyAI/python
    source .venv/bin/activate
    python main.py
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


# Runtime files copied into the user install. Tests / examples / old
# result dumps stay in the repo (not part of the shipped runtime).
RUNTIME_FILES = [
    "main.py",
    "graph_builder.py",
    "workflow_loader.py",
    "mcp_tools.py",
    "code_generator.py",
    "script_io.py",
    "requirements.txt",
    "README.md",
    # NOTE: index.html is intentionally NOT in this list. The UI now
    # lives only at the install location (~/Documents/synergyAI/python/
    # index.html) and is hand-edited there. Re-running setup.py --force
    # must NOT overwrite the user's UI. Fresh installs that need a
    # default index.html should grab it from the repo history once.
]

# Subdirectories created inside the install.
#  - `scripts/` — where the webapp's workflow editor saves generated .py files
#  - `outputs/` — where script_io.write_output() writes results so the UI
#                 can list and render them
INSTALL_SUBDIRS = ["scripts", "outputs"]

# .env template — what the runner reads on startup. Generated scripts
# pick a provider per agent based on the workflow editor's config and
# read each provider's key from these variables. Fill in only the
# providers your workflows use; the rest can stay blank.
ENV_EXAMPLE = """\
# === LLM provider API keys ===
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_API_KEY=        # for Gemini (langchain-google-genai)
XAI_API_KEY=           # for Grok (api.x.ai)
DEEPSEEK_API_KEY=      # for DeepSeek (api.deepseek.com)
KIMI_API_KEY=          # for Kimi / Moonshot (api.moonshot.cn)

# === Optional global override ===
# Setting MODEL_NAME forces every agent in every script to use this
# model regardless of what the workflow configured. Leave blank to
# honour each agent's per-node setting.
MODEL_NAME=

# === URL of the PHP backend (for the "Live workflow" debug panel) ===
GPT_BACKEND_URL=http://localhost/gpt/backend
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install langchain_runner locally.")
    parser.add_argument(
        "--path",
        default=str(Path.home() / "Documents" / "synergyAI" / "python"),
        help="Install location (default: ~/Documents/synergyAI/python).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing files at the target.",
    )
    parser.add_argument(
        "--skip-venv",
        action="store_true",
        help="Skip venv creation + pip install (just copy files).",
    )
    return parser.parse_args()


def copy_runtime(src_dir: Path, dst_dir: Path, force: bool) -> None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    for name in RUNTIME_FILES:
        src = src_dir / name
        dst = dst_dir / name
        if not src.exists():
            print(f"  skip (missing): {name}")
            continue
        if dst.exists() and not force:
            print(f"  keep (exists):  {name}")
            continue
        shutil.copy2(src, dst)
        print(f"  copied:         {name}")
    for sub in INSTALL_SUBDIRS:
        (dst_dir / sub).mkdir(exist_ok=True)
        print(f"  subdir:         {sub}/")
    env_example = dst_dir / ".env.example"
    if not env_example.exists() or force:
        env_example.write_text(ENV_EXAMPLE, encoding="utf-8")
        print("  wrote:          .env.example")
    # We deliberately do NOT create `.env` here. Following the Python
    # convention, the user creates their own `.env` from the template:
    #   cp .env.example .env && edit
    # That keeps secrets clearly user-owned, avoids any chance of
    # overwriting on re-install, and prevents `.env` from looking like
    # something the installer manages.


def _parse_skill_deps(skills_root: Path) -> list[str]:
    """Scan installed skills for the PyPI packages they declare in SKILL.md.

    Compiled scripts execute folder-backed skills via subprocess, so the venv
    must contain the skills' own deps (e.g. beautifulsoup4) — not just the
    LangGraph stack in requirements.txt. Returns the sorted union across every
    SKILL.md found under ``skills_root``.
    """
    deps: set[str] = set()
    if not skills_root.is_dir():
        return []
    for md in skills_root.rglob("SKILL.md"):
        try:
            lines = md.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            continue
        # Only the YAML frontmatter (between the leading '---' fences) is
        # authoritative — a 'dependencies:' line in the prose body is not a
        # real declaration and must not be installed.
        if not lines or lines[0].strip() != "---":
            continue
        for line in lines[1:]:
            s = line.strip()
            if s == "---":
                break  # end of frontmatter
            if s.lower().startswith("dependencies:"):
                val = s.split(":", 1)[1].strip().strip("[]")
                for d in val.split(","):
                    d = d.strip().strip("'").strip('"')
                    if d:
                        deps.add(d)
                break
    return sorted(deps)


def build_venv(dst_dir: Path) -> None:
    venv_dir = dst_dir / ".venv"
    if venv_dir.exists():
        print(f"  venv exists at {venv_dir} — reusing")
    else:
        print(f"  creating venv at {venv_dir}")
        subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], check=True)

    pip = venv_dir / ("Scripts" if sys.platform == "win32" else "bin") / "pip"
    reqs = dst_dir / "requirements.txt"
    if not reqs.exists():
        print(f"  ! no requirements.txt at {reqs}, skipping install")
    else:
        print(f"  installing requirements (this can take a minute)")
        subprocess.run([str(pip), "install", "--upgrade", "pip"], check=True)
        subprocess.run([str(pip), "install", "-r", str(reqs)], check=True)

    # Install the dependencies the installed SKILLS declare. Compiled scripts
    # run those skills as subprocesses, so the venv needs e.g. beautifulsoup4 —
    # without this the GEO skills exited 1 with "beautifulsoup4 is required".
    # Skills live as a sibling of the python install (~/Documents/synergyAI/),
    # overridable via SYNERGYAI_SKILLS_DIR.
    skills_root = Path(
        os.environ.get("SYNERGYAI_SKILLS_DIR", str(dst_dir.parent / "skills"))
    ).expanduser()
    skill_deps = _parse_skill_deps(skills_root)
    if skill_deps:
        print(f"  installing skill dependencies ({len(skill_deps)}): {', '.join(skill_deps)}")
        # check=False: a single bad/unavailable package shouldn't abort the
        # whole install; the runtime auto-installer is a backstop.
        subprocess.run([str(pip), "install", *skill_deps], check=False)
    else:
        print(f"  no skill dependencies found under {skills_root}")


def main() -> int:
    args = parse_args()
    src_dir = Path(__file__).resolve().parent
    dst_dir = Path(args.path).expanduser().resolve()

    print(f"Installing langchain_runner")
    print(f"  source: {src_dir}")
    print(f"  target: {dst_dir}")
    print()

    print("Copying runtime files:")
    copy_runtime(src_dir, dst_dir, args.force)
    print()

    if args.skip_venv:
        print("Skipping venv creation (--skip-venv).")
    else:
        print("Building Python environment:")
        try:
            build_venv(dst_dir)
        except subprocess.CalledProcessError as exc:
            print(f"\n! venv/pip step failed: {exc}", file=sys.stderr)
            print("  You can retry just the env build with:")
            print(f"    cd {dst_dir} && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt")
            return 1
    print()

    print("Done.")
    print()
    print("Next steps:")
    print(f"  1. cd {dst_dir}")
    print(f"  2. cp .env.example .env  # then fill in your API keys")
    print(f"  3. source .venv/bin/activate")
    print(f"  4. python main.py        # opens http://127.0.0.1:8765")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
