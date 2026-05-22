export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: {
    attempts?: number;
    baseMs?: number;
    label?: string;
    // Per-attempt timeout in ms. Default 30s — covers normal-slow RPC calls
    // but ensures a stuck RPC (connection open, response never arrives) can't
    // freeze the script forever. Callers wrapping `tx.wait()` or other
    // legitimately long operations should pass a larger value (e.g. 180_000).
    // Pass 0 to disable timeouts entirely (not recommended).
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const label = opts.label ?? 'retry';
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return timeoutMs > 0 ? await withTimeout(fn(), timeoutMs, label) : await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      const wait = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 200);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** Reject the inner promise if it doesn't settle within `ms` milliseconds. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label = 'op'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  // Suppress "unhandled rejection" noise if `p` rejects AFTER the timeout has
  // already fired. The race resolves/rejects on the first settled promise,
  // but the other one keeps running — and an ethers JsonRpcProvider fetch
  // against a flaky public RPC can come back minutes later with a 503 or
  // "request timeout". Without this guard the stack dump leaks to stderr
  // even though the script logic has already moved on (retry rotated to
  // the next URL, or the wallet flow finished). Attaching a no-op catch is
  // the standard race-loser cleanup pattern.
  p.catch(() => undefined);
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pickRandom<T>(arr: T[]): T {
  if (arr.length === 0) throw new Error('pickRandom on empty array');
  return arr[Math.floor(Math.random() * arr.length)];
}
