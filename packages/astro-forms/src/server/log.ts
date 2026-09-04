/**
 * Zero-dep structured JSON logger. Emits one-line JSON via console.log /
 * console.warn / console.error so Passenger (and any stdout/stderr-capturing
 * host) sees structured, greppable events. Every reject branch,
 * storage/notify error, and boot event should log through this module —
 * Phase 1 must never be blind to what the abandon route is doing in
 * production.
 */

interface LogRecord {
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  [key: string]: unknown;
}

/** Log a structured info-level event. */
export function log(event: string, data?: Record<string, unknown>): void {
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level: 'info',
    event,
    ...data,
  };
  console.log(JSON.stringify(record));
}

/**
 * Log a structured warning: something is misconfigured but nothing failed,
 * so there is no Error to serialize. Goes to stderr via console.warn so a
 * host tailing only the error stream still sees it — an inert security
 * control (turnstile.ts) is exactly the case that must not hide in stdout.
 */
export function warn(event: string, data?: Record<string, unknown>): void {
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level: 'warn',
    event,
    ...data,
  };
  console.warn(JSON.stringify(record));
}

/** Log a structured error-level event, safely serializing the error. */
export function logError(event: string, err: unknown, data?: Record<string, unknown>): void {
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level: 'error',
    event,
    error: serializeError(err),
    ...data,
  };
  console.error(JSON.stringify(record));
}

function serializeError(err: unknown): { message: string; stack?: string; name?: string } | unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}
