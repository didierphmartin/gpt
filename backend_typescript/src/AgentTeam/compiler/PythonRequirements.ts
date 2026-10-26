import { array_unique, implode, is_array, pathExtension, sortStrings, strtolower, strval, values } from './php';

/** PHP `$x['k'] ?? null`. */
function at(x: any, k: string): any {
  if (x === null || x === undefined || typeof x !== 'object') return null;
  const v = Array.isArray(x) ? x[Number(k)] : x[k];
  return v === undefined ? null : v;
}

/**
 * The pip requirement of each package a compiled program imports, written once: requirements.txt, the
 * `pip install` line of a script's TO RUN docstring and the README all print what these functions return,
 * so they cannot disagree. Each target says WHICH packages it needs (LangGraphPackage, CompiledPackage);
 * this says how each is installed. Ported from backend/src/AgentTeam/Services/PythonRequirements.php.
 */

/**
 * The version bounds a package is installed with: the floors (and caps) the generated code is written
 * against, as the local runner's langchain_runner/requirements.txt pins them. A package not listed here
 * (a skill's dependency, a document converter) is installed as named.
 */
const SPECS: Record<string, string> = {
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
  'mcp': 'mcp<2',   // nooa 0.0.8 targets the mcp 1.x SDK API (mcp 2.0 changed the client yield shape)
  'pydantic': 'pydantic>=2.8.0',
  'python-dotenv': 'python-dotenv>=1.0.0',
  'uvicorn': 'uvicorn>=0.30.0',
};

/** The document converter's lazy imports, by attachment extension. */
const DOCUMENT_REQUIREMENTS: Record<string, string> = { pdf: 'pypdf', docx: 'mammoth', pptx: 'python-pptx', xlsx: 'openpyxl' };

export class PythonRequirements {
  /** The converter packages the Start's documents need, by their extension. */
  static documentNames(startDocuments: any): string[] {
    const out: string[] = [];
    for (const doc of values(startDocuments ?? [])) {
      const ext = strtolower(pathExtension(strval(is_array(doc) ? (at(doc, 'path') ?? at(doc, 'name') ?? '') : '')));
      if (Object.hasOwn(DOCUMENT_REQUIREMENTS, ext)) out.push(DOCUMENT_REQUIREMENTS[ext]);
    }
    return out;
  }

  /** The requirement lines of names: each with its version bounds, one per package, sorted by name. */
  static lines(names: string[]): string[] {
    const sorted = sortStrings(values<string>(array_unique(names.map(strval))));
    return values<string>(array_unique(sorted.map((n) => (Object.hasOwn(SPECS, n) ? SPECS[n] : n))));
  }

  /** requirements.txt: lines(), one per line. */
  static txt(names: string[]): string {
    return implode('\n', PythonRequirements.lines(names)) + '\n';
  }

  /** One `pip install` command for names; a requirement with a character the shell reads is double-quoted. */
  static pipInstall(names: string[]): string {
    const args = PythonRequirements.lines(names).map((r) => (/^[A-Za-z0-9._-]+$/.test(r) ? r : '"' + r + '"'));
    return 'pip install ' + args.join(' ');
  }
}
