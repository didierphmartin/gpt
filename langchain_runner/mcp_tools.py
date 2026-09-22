"""LangChain tool wrappers backed by the PHP backend.

Both built-in PHP tools and MCP tools are invoked through the single
``POST /api/v1/tools/execute`` endpoint. The Python side never talks
MCP transport directly — the PHP backend handles that.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Callable

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field, create_model

logger = logging.getLogger(__name__)


def _schema_to_pydantic(name: str, input_schema: Any) -> type[BaseModel]:
    """Build a pydantic model from a JSON-schema-ish dict (minimal)."""
    if not isinstance(input_schema, dict):
        return create_model(f"{name}Args")

    props = input_schema.get("properties") or {}
    if not isinstance(props, dict):
        return create_model(f"{name}Args")

    required = set(input_schema.get("required") or [])
    type_map = {
        "string": str,
        "integer": int,
        "number": float,
        "boolean": bool,
        "array": list,
        "object": dict,
    }
    fields: dict[str, tuple[Any, Any]] = {}
    for pname, pspec in props.items():
        spec = pspec if isinstance(pspec, dict) else {}
        ptype = type_map.get(spec.get("type", "string"), str)
        default = ... if pname in required else None
        fields[pname] = (ptype, Field(default, description=spec.get("description", "")))
    if not fields:
        return create_model(f"{name}Args")
    return create_model(f"{name}Args", **fields)  # type: ignore[arg-type]


def _make_tool_callable(
    backend_url: str,
    jwt: str,
    tool_name: str,
    log_sink: Callable[[str, str], None] | None,
) -> Callable[..., str]:
    headers = {"Authorization": f"Bearer {jwt}", "Content-Type": "application/json"}
    exec_url = f"{backend_url.rstrip('/')}/api/v1/tools/execute"

    def _invoke(**kwargs: Any) -> str:
        if log_sink:
            log_sink("tool_call", f"→ {tool_name}({json.dumps(kwargs, default=str)[:200]})")
        try:
            with httpx.Client(timeout=180) as client:
                r = client.post(
                    exec_url,
                    headers=headers,
                    json={"tool_name": tool_name, "parameters": kwargs},
                )
                r.raise_for_status()
                data = r.json()
        except Exception as e:
            msg = f"Tool {tool_name} failed: {e}"
            if log_sink:
                log_sink("tool_error", msg)
            return json.dumps({"error": str(e)})

        if not data.get("success", True):
            err = data.get("error", "unknown error")
            if log_sink:
                log_sink("tool_error", f"← {tool_name}: {err}")
            return json.dumps({"error": err})

        result = data.get("result")
        out = result if isinstance(result, str) else json.dumps(result, default=str)[:8000]
        if log_sink:
            log_sink("tool_result", f"← {tool_name}: {out[:200]}")
        return out

    return _invoke


def build_tools(
    tool_defs: list[dict[str, Any]],
    backend_url: str,
    jwt: str,
    allowed_names: set[str],
    log_sink: Callable[[str, str], None] | None = None,
) -> list[StructuredTool]:
    """Wrap each backend tool definition as a LangChain StructuredTool.

    ``allowed_names`` is the explicit filter — empty set yields no tools.
    Names from the backend may carry the ``mcp_`` prefix; filtering matches
    against both the prefixed and unprefixed forms.
    """
    tools: list[StructuredTool] = []
    for t in tool_defs:
        name = t.get("name") or t.get("tool_name")
        if not name:
            continue
        bare = name[4:] if name.startswith("mcp_") else name
        if name not in allowed_names and bare not in allowed_names:
            continue

        input_schema = t.get("input_schema") or {}
        args_model = _schema_to_pydantic(bare, input_schema)
        fn = _make_tool_callable(backend_url, jwt, name, log_sink)
        tools.append(
            StructuredTool.from_function(
                func=fn,
                name=bare,
                description=t.get("description") or f"Tool {bare}",
                args_schema=args_model,
            )
        )
    return tools


# Back-compat alias (the file is still imported as mcp_tools).
build_mcp_tools = build_tools
