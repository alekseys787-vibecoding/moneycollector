// Cooperative pause primitive used by Ctrl+C handling. Workers `await
// checkPause()` at safe checkpoints (wallet boundaries, chain boundaries);
// the SIGINT handler in index.ts flips the shared state and the workers
// stall until the pause window expires (auto-resume) or the user double-
// taps Ctrl+C (process exits).
//
// Why cooperative: Node async is non-preemptive — we can't force a running
// promise to yield. So the pause only kicks in BETWEEN operations. With
// concurrency=4 and 17-chain wallet scans the worst-case latency between
// "Ctrl+C pressed" and "workers actually stopped" is one wallet × one chain
// ≈ 5-15s. That's acceptable for an undo-window UX.

import chalk from 'chalk';
import { log } from './logger';

interface PauseState {
  paused: boolean;
  resumeAt: number;  // ms epoch; auto-resume after this timestamp
}

const STATE: PauseState = { paused: false, resumeAt: 0 };
let LAST_RESUME_LOGGED = 0;

export function isPaused(): boolean {
  if (!STATE.paused) return false;
  // Expire the flag lazily — saves us a timer.
  if (Date.now() >= STATE.resumeAt) {
    STATE.paused = false;
    return false;
  }
  return true;
}

export function pauseDeadline(): number {
  return STATE.resumeAt;
}

// Called by the SIGINT handler on first Ctrl+C. Idempotent — if already
// paused, extends the window (which matches what users expect when they
// hold Ctrl+C and tap it a couple of times by accident; only an explicit
// double-tap during the existing window should exit).
export function requestPause(durationMs: number): void {
  STATE.paused = true;
  STATE.resumeAt = Date.now() + durationMs;
}

// Workers call this at safe checkpoints. Resolves immediately if not paused.
// Otherwise polls every 100ms until the resume deadline or the flag clears.
export async function checkPause(): Promise<void> {
  if (!STATE.paused) return;
  while (STATE.paused) {
    const remaining = STATE.resumeAt - Date.now();
    if (remaining <= 0) {
      STATE.paused = false;
      // Log "resumed" exactly once per pause cycle so concurrent workers
      // don't all spam the resume line.
      if (LAST_RESUME_LOGGED < STATE.resumeAt) {
        LAST_RESUME_LOGGED = STATE.resumeAt;
        log.info(chalk.green('▶ Pause window expired — resuming.'));
      }
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(remaining, 100)));
  }
}
