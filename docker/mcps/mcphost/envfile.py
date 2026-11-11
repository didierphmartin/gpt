"""Settings file (.env) helpers; twins of parseEnv / renderEnv / mergeEnv / envFields in workflow-package.js."""
import re

SECRET_FIELD_RE = re.compile(r"key|secret|token|password|passwd|credential|dsn|connection|connection_string|conn_str|connstr|auth|bearer|private", re.I)
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
        # settings that go together: once one of a group is filled, the others are needed too
        **({"group": f["group"].strip()} if isinstance(f.get("group"), str) and f["group"].strip() else {}),
    }


def clean_list(entries) -> list:
    """A settings list as the editor sends it, checked and written compactly; ValueError says what is wrong.

    Each entry: name (a setting name, once), label, required, secret, default, group. secret is always written
    (otherwise the name decides it); required, default and group only when set."""
    if not isinstance(entries, list):
        raise ValueError("env must be a list")
    out, seen = [], set()
    for i, e in enumerate(entries, 1):
        if not isinstance(e, dict):
            raise ValueError(f"setting {i} is not an object")
        name = e.get("name")
        if not isinstance(name, str) or not _NAME.match(name.strip()):
            raise ValueError(f"setting {i}: invalid name {name!r} (letters, digits and _, not starting with a digit)")
        name = name.strip()
        if name in seen:
            raise ValueError(f"{name} is listed twice")
        seen.add(name)
        for k in ("label", "default", "group"):
            v = e.get(k)
            if v is not None and (isinstance(v, bool) or not isinstance(v, (str, int, float))):
                raise ValueError(f"{name}: {k} must be text")
        item = {"name": name}
        label = str(e.get("label") or "").strip()
        if label:
            item["label"] = label
        if e.get("required"):
            item["required"] = True
        item["secret"] = bool(e.get("secret"))
        default = "" if e.get("default") is None else str(e["default"])
        if default:
            item["default"] = default
        group = str(e.get("group") or "").strip()
        if group:
            item["group"] = group
        out.append(item)
    return out


def missing(fields: list, current: dict, skip=()) -> list:
    """Names still needed: a required field with no value, and every empty member of a group one of whose members is set."""
    live = [f for f in fields if f["name"] not in skip]
    started = {f["group"] for f in live if f.get("group") and current.get(f["name"])}
    return [f["name"] for f in live if not current.get(f["name"]) and (f["required"] or f.get("group") in started)]


def fields(manifest: dict | None, env_example: str) -> list:
    """Settings a server needs: manifest["env"] wins, else parsed from its .env.example."""
    if isinstance(manifest, dict) and isinstance(manifest.get("env"), list):
        # entries that are not {"name": "..."} objects are skipped: a bad manifest must not stop the server
        return [_norm(f) for f in manifest["env"] if isinstance(f, dict) and isinstance(f.get("name"), str)]
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
