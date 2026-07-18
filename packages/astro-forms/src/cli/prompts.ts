/**
 * Thin `node:readline/promises` wrapper (CLI-01, zero external deps —
 * 05-RESEARCH.md "Don't Hand-Roll" scope excludes commander/yargs, not the
 * Node standard library).
 */
import { createInterface } from 'node:readline/promises';

/**
 * True only when attached to a real interactive terminal. Any non-TTY
 * stdin (a child_process pipe, a CI runner, redirected input) is treated
 * as non-interactive — callers must gate `confirmOverwrite` on this first
 * so a spawned/CI run never blocks waiting for a keypress that will never
 * arrive (T-05-14).
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Asks a y/N confirmation on the real TTY and resolves to the answer.
 * Only ever called after `isInteractive()` has been checked by the caller.
 */
export async function confirmOverwrite(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} (y/N) `);
    return answer.trim().toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
}
