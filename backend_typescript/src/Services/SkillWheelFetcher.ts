import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';

/** A wheel-gathering failure with the HTTP status and extra fields the route should answer with. Mirrors SkillWheelError. */
export class SkillWheelError extends Error {
  constructor(message: string, private readonly status: number, private readonly extra: Record<string, any> = {}) {
    super(message);
  }

  statusCode(): number {
    return this.status;
  }

  data(): Record<string, any> {
    return this.extra;
  }
}

export type WheelRunner = (argv: string[]) => Promise<{ code: number; out: string }>;

/**
 * Mirrors src/Services/SkillWheelFetcher.php: gathers native (CPython 3.12) wheels for a skill's declared libraries
 * with `pip download`, one run per platform group, so the exported package can install offline. Libraries with no
 * binary wheel are built from source only when the result is pure Python.
 */
export class SkillWheelFetcher {
  static readonly PLATFORMS: string[][] = [
    ['manylinux_2_17_x86_64', 'manylinux2014_x86_64'],
    ['manylinux_2_17_aarch64', 'manylinux2014_aarch64'],
    ['macosx_11_0_arm64'],
  ];

  private readonly runner: WheelRunner;
  private tmp = '';
  /** dep => folder with its built pure wheel (null = not pure) */
  private built = new Map<string, string | null>();

  constructor(runner: WheelRunner | null = null, private readonly python = 'python3') {
    this.runner = runner ?? SkillWheelFetcher.spawnRunner;
  }

  /** deps: pip requirement strings. Returns wheel filename => bytes. */
  async fetch(depsIn: string[]): Promise<Record<string, Buffer>> {
    const deps = depsIn.map((d) => String(d).trim()).filter((d) => d !== '');
    for (const d of deps) {
      if (d.startsWith('-')) throw new SkillWheelError('Invalid library name: ' + d, 400);
    }
    if (deps.length === 0) return {};
    if ((await this.run([this.python, '-m', 'pip', '--version', '--no-cache-dir'])).code !== 0) {
      throw new SkillWheelError('Exporting a skill with libraries needs Python 3 on the server.', 503);
    }
    const tmp = `${os.tmpdir()}/skillwheels_${crypto.randomBytes(8).toString('hex')}`;
    fs.mkdirSync(tmp, { mode: 0o700 });
    this.tmp = tmp;
    this.built = new Map();
    try {
      const wheels: Record<string, Buffer> = {};
      for (let i = 0; i < SkillWheelFetcher.PLATFORMS.length; i++) {
        const group = SkillWheelFetcher.PLATFORMS[i];
        const dest = `${tmp}/p${i}`;
        fs.mkdirSync(dest);
        await this.gather(deps, group, dest);
        for (const name of whlFiles(dest)) wheels[name] ??= fs.readFileSync(`${dest}/${name}`);
      }
      return wheels;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async gather(deps: string[], group: string[], dest: string): Promise<void> {
    let r = await this.download(deps, group, dest);
    if (r.code === 0) return;
    SkillWheelFetcher.assertNoWheel(r);
    // Find which dependency has no binary wheel on this platform, and try it as pure Python.
    for (const dep of deps) {
      r = await this.download([dep], group, dest);
      if (r.code === 0) continue;
      SkillWheelFetcher.assertNoWheel(r);
      const built = await this.buildPure(dep);
      if (built === null) {
        throw new SkillWheelError(`No compatible wheel for ${dep} on ${group[0]}.`, 422, { library: dep, platform: group[0] });
      }
      // pip resolves the built wheel plus its own requirements from the index.
      r = await this.download([dep], group, dest, built);
      if (r.code !== 0) {
        SkillWheelFetcher.assertNoWheel(r);
        throw new SkillWheelError(`No compatible wheel for a requirement of ${dep} on ${group[0]}.`, 422, { library: dep, platform: group[0] });
      }
    }
  }

  /** Builds dep from source once per fetch; returns the folder holding its pure-Python wheel, or null. */
  private async buildPure(dep: string): Promise<string | null> {
    if (this.built.has(dep)) return this.built.get(dep)!;
    const dir = `${this.tmp}/built${this.built.size}`;
    fs.mkdirSync(dir);
    const r = await this.run([this.python, '-m', 'pip', 'wheel', '--no-cache-dir', '--no-deps', '--wheel-dir', dir, dep]);
    const files = r.code === 0 ? whlFiles(dir) : [];
    const pure = files.length > 0 && files.every((f) => /-(py3|py2\.py3)-none-any\.whl$/.test(f));
    const out = pure ? dir : null;
    this.built.set(dep, out);
    return out;
  }

  /** Only "no wheel" answers may fall back or become a 422; anything else (network, index, bad requirement) is a 502. */
  private static assertNoWheel(r: { code: number; out: string }): void {
    if (!/No matching distribution|Could not find a version/i.test(r.out)) {
      throw new SkillWheelError('Could not download the libraries: ' + r.out.trim().slice(-300), 502);
    }
  }

  private download(deps: string[], group: string[], dest: string, findLinks: string | null = null): Promise<{ code: number; out: string }> {
    const argv = [this.python, '-m', 'pip', 'download', '--no-cache-dir', '--only-binary=:all:', '--python-version', '3.12',
      '--implementation', 'cp', '--abi', 'cp312', '--abi', 'abi3', '--abi', 'none'];
    for (const platform of group) argv.push('--platform', platform);
    if (findLinks !== null) argv.push('--find-links', findLinks);
    argv.push('--dest', dest);
    return this.run([...argv, ...deps]);
  }

  private async run(argv: string[]): Promise<{ code: number; out: string }> {
    try {
      return await this.runner(argv);
    } catch {
      return { code: 127, out: '' };
    }
  }

  /** The command's exit code and its stdout+stderr; killed after 600 s (code 124). */
  private static spawnRunner(argv: string[]): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve({ code: 127, out: '' });
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: 124, out: out + '\ntimed out' });
      }, 600_000);
      child.stdout?.on('data', (b) => { out += b.toString(); });
      child.stderr?.on('data', (b) => { out += b.toString(); });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ code: 127, out: '' });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, out });
      });
    });
  }
}

function whlFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.whl')).sort();
  } catch {
    return [];
  }
}
