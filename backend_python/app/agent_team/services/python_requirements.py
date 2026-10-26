"""Port of backend/src/AgentTeam/Services/PythonRequirements.php.

The pip requirement of each package a compiled program imports, written once: requirements.txt, the
`pip install` line of a script's TO RUN docstring and the README all print what these functions return,
so they cannot disagree. Each target says WHICH packages it needs (LangGraphPackage, CompiledPackage);
this says how each is installed.
"""
from __future__ import annotations

import os
import re


def _unique(items: list) -> list:
    out = []
    for x in items:
        if x not in out:
            out.append(x)
    return out


class PythonRequirements:
    # The version bounds a package is installed with: the floors (and caps) the generated code is written
    # against, as the local runner's langchain_runner/requirements.txt pins them. A package not listed here
    # (a skill's dependency, a document converter) is installed as named.
    SPECS = {
        'a2a-sdk[http-server]': 'a2a-sdk[http-server]>=1.1,<2',
        'agent-framework': 'agent-framework>=1.10,<2',
        'fastapi': 'fastapi>=0.115.0',
        'google-adk': 'google-adk>=2.3,<3',
        'httpx': 'httpx>=0.27.0',
        'langchain': 'langchain>=0.3.0',
        'langchain-anthropic': 'langchain-anthropic>=0.3.0',
        'langchain-core': 'langchain-core>=0.3.0',
        'langchain-google-genai': 'langchain-google-genai>=2.0.0',
        'langchain-openai': 'langchain-openai>=0.2.0',
        'langgraph': 'langgraph>=0.2.50',
        'mcp': 'mcp<2',   # nooa 0.0.8 targets the mcp 1.x SDK API (mcp 2.0 changed the client yield shape)
        'pydantic': 'pydantic>=2.8.0',
        'python-dotenv': 'python-dotenv>=1.0.0',
        'uvicorn': 'uvicorn>=0.30.0',
    }
    # The document converter's lazy imports, by attachment extension.
    DOCUMENT_REQUIREMENTS = {'pdf': 'pypdf', 'docx': 'mammoth', 'pptx': 'python-pptx', 'xlsx': 'openpyxl'}

    @classmethod
    def documentNames(cls, startDocuments: list) -> list:
        """The converter packages the Start's documents need, by their extension."""
        out = []
        for doc in startDocuments or []:
            path = str((doc.get('path') if doc.get('path') is not None else doc.get('name')) or '') if isinstance(doc, dict) else ''
            base = os.path.basename(path)
            ext = base.rsplit('.', 1)[1].lower() if '.' in base else ''
            if ext in cls.DOCUMENT_REQUIREMENTS:
                out.append(cls.DOCUMENT_REQUIREMENTS[ext])
        return out

    @classmethod
    def lines(cls, names: list) -> list:
        """The requirement lines of names: each with its version bounds, one per package, sorted by name."""
        names = sorted(_unique([str(n) for n in names]), key=lambda s: s.encode('utf-8'))
        return _unique([cls.SPECS.get(n, n) for n in names])

    @classmethod
    def txt(cls, names: list) -> str:
        """requirements.txt: lines(), one per line."""
        return '\n'.join(cls.lines(names)) + '\n'

    @classmethod
    def pipInstall(cls, names: list) -> str:
        """One `pip install` command for names; a requirement with a character the shell reads is double-quoted."""
        args = [r if re.fullmatch(r'[A-Za-z0-9._-]+', r) else '"' + r + '"' for r in cls.lines(names)]
        return 'pip install ' + ' '.join(args)
