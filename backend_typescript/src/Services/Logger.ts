import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * File logger for the Node backend — the equivalent of PHP's `error_log`.
 *
 * Node/tsx normally logs only to the terminal (stdout/stderr), which is hard to
 * inspect after the fact. This module:
 *   1. mirrors EVERY console.* call into a log file (so all existing logging is
 *      captured without touching call sites), and
 *   2. exposes a structured `log` helper for targeted diagnostics.
 *
 * Path: env `BACKEND_LOG_FILE`, else `<cwd>/logs/backend.log`. When running via
 * `npm run dev` (tsx watch src/index.ts) the cwd is the backend root, so the file
 * lands at `backend_typescript/logs/backend.log`.
 */
const LOG_FILE = process.env.BACKEND_LOG_FILE || join(process.cwd(), 'logs', 'backend.log');

try {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
} catch {
  /* ignore — logging must never crash the app */
}

export function backendLogFilePath(): string {
  return LOG_FILE;
}

function stamp(): string {
  return new Date().toISOString();
}

function fmt(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? '\n' + arg.stack : ''}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function writeLine(level: string, args: unknown[]): void {
  try {
    appendFileSync(LOG_FILE, `[${stamp()}] [${level}] ${args.map(fmt).join(' ')}\n`);
  } catch {
    /* never let logging break a request */
  }
}

/** Structured logging helper for targeted, greppable diagnostics. */
export const log = {
  info: (...args: unknown[]) => writeLine('INFO', args),
  warn: (...args: unknown[]) => writeLine('WARN', args),
  error: (...args: unknown[]) => writeLine('ERROR', args),
  debug: (...args: unknown[]) => writeLine('DEBUG', args),
};

let installed = false;

/**
 * Mirror all console.* output into the log file (in addition to the terminal).
 * Call once at startup, before anything logs.
 */
export function initFileLogging(options: { truncate?: boolean } = {}): void {
  if (installed) return;
  installed = true;

  if (options.truncate) {
    try {
      writeFileSync(LOG_FILE, '');
    } catch {
      /* ignore */
    }
  }

  const methods: Array<['log' | 'info' | 'warn' | 'error' | 'debug', string]> = [
    ['log', 'LOG'],
    ['info', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
    ['debug', 'DEBUG'],
  ];

  for (const [method, level] of methods) {
    const original = (console[method] as (...a: unknown[]) => void).bind(console);
    (console as unknown as Record<string, (...a: unknown[]) => void>)[method] = (...args: unknown[]) => {
      original(...args);
      writeLine(level, args);
    };
  }

  writeLine('INFO', [`=== backend log started (pid ${process.pid}) → ${LOG_FILE} ===`]);
}
