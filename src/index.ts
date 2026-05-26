import 'dotenv/config';
import chalk from 'chalk';
import { log } from './utils/logger';
import { isPaused, requestPause } from './utils/pause';
import { runWizard } from './wizard';

// Swallow late RPC failures that arrive after we already moved on (rotated
// to a different URL, finished the wallet flow, etc.). Without this handler
// ethers' internal pollers can dump multi-line stack traces to stderr after
// the script's main flow has already completed successfully — looks scary,
// breaks nothing. We log a one-liner instead so the noise is bounded.
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.shortMessage || reason?.message || String(reason);
  const url = reason?.info?.requestUrl || reason?.payload?.method;
  log.warn(`(background) late RPC rejection: ${msg}${url ? ` [${url}]` : ''}`);
});

// Cooperative Ctrl+C / Ctrl+Break handling. Multi-stage:
//   1. First Ctrl+C → set a 3-second pause flag + attach a stdin listener.
//      Workers awaiting checkPause() stall at their next safe checkpoint.
//   2. Second Ctrl+C while paused → exit cleanly with code 130.
//   3. ANY input on stdin during pause (Enter, "y", any keystroke) → exit.
//      This handles the Windows-specific case where the user pressed Ctrl+C,
//      saw cmd.exe's "Terminate batch job (Y/N)?" prompt, typed Y+Enter, and
//      expected the script to exit. cmd's Y kills the .cmd batch wrapper
//      (npm.cmd) but Node, being a child of cmd, becomes orphaned and keeps
//      running. We can't intercept Y typed into cmd's prompt, but we CAN
//      grab anything the user subsequently types into the terminal — and
//      since cmd's batch prompt is one-shot, the next keystroke reaches us.
//   4. SIGBREAK (Ctrl+Break) → immediate exit, no pause window. Power-user
//      escape hatch.
//   5. No second tap, no stdin input → auto-resume after 3s.

const SIGINT_PAUSE_MS = 3000;
let pauseStdinListener: ((chunk: Buffer) => void) | null = null;

function attachPauseStdinListener() {
  if (pauseStdinListener) return;
  // Stdin may not be a TTY (e.g., when piped). In that case skip — no
  // realistic way for the user to send input anyway.
  if (!process.stdin.isTTY) return;
  pauseStdinListener = () => {
    // Any byte at all during the pause = confirm exit. Don't try to parse
    // 'y' vs 'n' — by the time we're listening, the user has already
    // expressed intent by pressing Ctrl+C.
    console.log(chalk.red('\nInput received during pause — exiting.'));
    process.exit(130);
  };
  try {
    if (process.stdin.setRawMode) process.stdin.setRawMode(false);
  } catch {
    /* not all TTYs support it */
  }
  process.stdin.resume();
  process.stdin.once('data', pauseStdinListener);
}

function detachPauseStdinListener() {
  if (!pauseStdinListener) return;
  process.stdin.off('data', pauseStdinListener);
  pauseStdinListener = null;
  // Don't pause stdin here — prompts() callers may attach their own
  // listeners shortly. The once('data') registration above already cleans
  // itself up after firing, so we only need to detach in the auto-resume
  // path (no fire happened, listener still attached).
}

process.on('SIGINT', () => {
  if (isPaused()) {
    console.log(chalk.red('\n\nCtrl+C again during pause — exiting.'));
    process.exit(130);
  }
  requestPause(SIGINT_PAUSE_MS);
  attachPauseStdinListener();
  // Auto-detach when pause window closes — workers' checkPause() loop
  // resumes them; we should also clean up our stdin listener so the next
  // interactive prompts() call isn't shadowed by our 'data' listener.
  setTimeout(detachPauseStdinListener, SIGINT_PAUSE_MS + 50);
  console.log(
    chalk.yellow(
      `\n⚠ Ctrl+C received — pausing for ${SIGINT_PAUSE_MS / 1000}s.\n` +
        `   Exit options:\n` +
        `     • press Ctrl+C again within the window, OR\n` +
        `     • press Enter / any key in this terminal.\n` +
        `   (On Windows, cmd.exe's "Terminate batch job (Y/N)?" prompt is a\n` +
        `    SEPARATE thing — answering Y there kills only the npm.cmd batch\n` +
        `    wrapper, not this Node process. Use one of the options above.)\n` +
        `   In-flight RPC calls continue; pause kicks in at the next safe checkpoint.`,
    ),
  );
});

// Ctrl+Break (Windows) — bypass the pause UX entirely.
process.on('SIGBREAK', () => {
  console.log(chalk.red('\nSIGBREAK received — exiting immediately.'));
  process.exit(130);
});

runWizard().catch((e) => {
  log.err(`fatal: ${e?.stack || e?.message || e}`);
  process.exit(1);
});
