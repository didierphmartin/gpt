import { Response } from 'express';

/**
 * Server-Sent Events writer mirroring the PHP backend's framing (SSEHubClient::sendDirect):
 *   event: <name>\n
 *   data: <line>\n        (one data: line per \n-split segment for string payloads)
 *   \n
 * String payloads are emitted RAW (not JSON), split on \n (the `chunk`/`progress` framing).
 * Object payloads are a single JSON data: line. After each frame, client-abort is checked and
 * CLIENT_ABORTED is thrown (mirrors connection_aborted()), which unwinds the upstream stream.
 */
export class SSEStream {
  private aborted = false;
  private started = false;

  constructor(private readonly res: Response) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.res.status(200);
    this.res.setHeader('Content-Type', 'text/event-stream;charset=UTF-8');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no');
    if (typeof (this.res as any).flushHeaders === 'function') (this.res as any).flushHeaders();
  }

  markAborted(): void {
    this.aborted = true;
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  send(event: string, data: string | object): void {
    if (this.aborted) throw new Error('CLIENT_ABORTED');
    let frame = `event: ${event}\n`;
    if (typeof data === 'string') {
      for (const line of data.split('\n')) frame += `data: ${line}\n`;
    } else {
      frame += `data: ${JSON.stringify(data)}\n`;
    }
    frame += '\n';
    this.res.write(frame);
    if (this.aborted) throw new Error('CLIENT_ABORTED');
  }

  end(): void {
    if (!this.aborted && !this.res.writableEnded) this.res.end();
  }
}
