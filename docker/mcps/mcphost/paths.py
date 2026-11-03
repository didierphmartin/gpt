"""Path rules for files written into a server folder (twins of isSafeSegment / isSafeWritePath in workflow-package.js)."""


def is_safe_segment(name: str) -> bool:
    """One folder / file name with no way out of its parent: non-empty, no "/", "\\" or "..", no leading "."."""
    return isinstance(name, str) and bool(name) and "/" not in name and "\\" not in name and ".." not in name and not name.startswith(".")


def is_safe_rel_path(path: str) -> bool:
    """A path inside a server folder: no empty, "." or ".." segment, no backslash, no segment starting with "."
    except a final ".env.example" (".env" is written separately)."""
    if not isinstance(path, str) or not path:
        return False
    segs = path.split("/")
    for i, seg in enumerate(segs):
        if not seg or seg in (".", "..") or "\\" in seg:
            return False
        if seg.startswith(".") and not (i == len(segs) - 1 and seg == ".env.example"):
            return False
    return True
