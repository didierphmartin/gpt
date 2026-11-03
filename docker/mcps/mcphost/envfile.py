"""Settings file (.env) helpers; twins of parseEnv / renderEnv / mergeEnv / envFields in workflow-package.js."""
import re

SECRET_FIELD_RE = re.compile(r"key|secret|token|password|passwd|credential|dsn|connection_string|conn_str|connstr|auth|bearer|private", re.I)
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
_QUOTE_NEEDED = re.compile(r"[\s#\"'\\]")
_NEWLINE = re.compile(r"\r\n|\n|\r")
_LINES = re.compile(r"\r?\n")


def _render_line(key: str, value) -> str:
    if not _NAME.match(key):
        raise ValueError("invalid setting name: " + key)
    s = "" if value is None else str(value)
    if not _QUOTE_NEEDED.search(s):
        return f"{key}={s}"
    esc = _NEWLINE.sub("\\\\n", s.replace("\\", "\\\\").replace('"', '\\"'))
    return f'{key}="{esc}"'


def parse(text: str) -> dict:
    """KEY=value lines to a dict: "..." unescapes \\\\ \\" \\n, '...' is literal, an unquoted value ends at " #"."""
    out = {}
    for raw in _LINES.split(text or ""):
        m = _LINE.match(raw)
        if not m:
            continue
        rest = m.group(2).strip()
        if rest[:1] == '"':
            v, i = "", 1
            while i < len(rest):
                c = rest[i]
                if c == '"':
                    break
                if c == "\\" and i + 1 < len(rest):
                    i += 1
                    n = rest[i]
                    v += {"n": "\n", "r": "\r", "t": "\t"}.get(n, n)
                else:
                    v += c
                i += 1
        elif rest[:1] == "'":
            end = rest.find("'", 1)
            v = rest[1:] if end == -1 else rest[1:end]
        else:
            v = re.sub(r"\s+#.*$", "", rest).strip()
        out[m.group(1)] = v
    return out


def merge(text: str, values: dict) -> str:
    """`text` with `values` set: other lines kept, a declared key replaced in place, a new one appended."""
    lines_out = {k: _render_line(k, v) for k, v in values.items()}   # invalid names raise before anything is merged
    text = text or ""
    if not text:
        return "".join(l + "\n" for l in lines_out.values())
    done = set()
    lines = []
    for raw in _LINES.split(re.sub(r"\r?\n$", "", text, count=1)):
        m = _LINE.match(raw)
        if m and m.group(1) in lines_out:
            done.add(m.group(1))
            lines.append(lines_out[m.group(1)])
        else:
            lines.append(raw)
    lines += [l for k, l in lines_out.items() if k not in done]
    return "\n".join(lines) + "\n"


def _unquote(v: str) -> str:
    return v[1:-1] if len(v) >= 2 and v[0] in "\"'" and v[-1] == v[0] else v


def _norm(f: dict) -> dict:
    name = f.get("name")
    secret = f.get("secret")
    default = f.get("default")
    return {
        "name": name,
        "label": f.get("label") or "",
        "required": bool(f.get("required")),
        "secret": bool(secret) if secret is not None else bool(SECRET_FIELD_RE.search(name or "")),
        "default": "" if default is None else str(default),
    }


def fields(manifest: dict | None, env_example: str) -> list:
    """Settings a server needs: manifest["env"] wins, else parsed from its .env.example."""
    if isinstance(manifest, dict) and isinstance(manifest.get("env"), list):
        return [_norm(f) for f in manifest["env"]]
    out, pending = [], []
    for raw in _LINES.split(env_example or ""):
        line = raw.strip()
        if not line:
            pending = []
            continue
        if line.startswith("#"):
            pending.append(re.sub(r"^#+\s*", "", line).strip())
            continue
        m = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$", line)
        if not m:
            pending = []
            continue
        out.append(_norm({"name": m.group(1), "label": " ".join(pending), "default": _unquote(m.group(2).strip())}))
        pending = []
    return out
