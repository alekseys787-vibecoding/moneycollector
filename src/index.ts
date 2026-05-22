import 'dotenv/config';
import { log } from './utils/logger';
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

runWizard().catch((e) => {
  log.err(`fatal: ${e?.stack || e?.message || e}`);
  process.exit(1);
});
