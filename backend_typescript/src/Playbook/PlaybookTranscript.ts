import fs from 'fs';
import path from 'path';
import { isoNow } from './php';

/**
 * Append-only JSONL transcript of one playbook run (playbook-<runId>.jsonl).
 * Mirrors backend/src/Playbook/PlaybookTranscript.php.
 */
export class PlaybookTranscript {
  constructor(private readonly dir: string) {}

  append(runId: number, event: Record<string, any>): void {
    const line = JSON.stringify({ ...event, ts: isoNow() }) + '\n';
    const file = this.path(runId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  }

  read(runId: number): any[] {
    const file = this.path(runId);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
  }

  private path(runId: number): string {
    return this.dir.replace(/\/+$/, '') + '/playbook-' + runId + '.jsonl';
  }
}
