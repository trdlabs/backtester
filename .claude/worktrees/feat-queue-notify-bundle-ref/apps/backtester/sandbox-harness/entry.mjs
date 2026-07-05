// Trusted in-container harness. Runs INSIDE the locked-down container (no network, read-only rootfs,
// dropped caps, mem/cpu/pids limits, non-root, no env/secrets). It reads one JSON request from stdin,
// writes the untrusted module to tmpfs, imports it, computes signals, and writes one JSON response to
// stdout. The module shares this process, but the container — not this harness — is the security
// boundary (in-process isolation is explicitly NOT trusted; see trading-platform 019 research).
//
// Protocol:
//   stdin  : { bundleSource: string, seed: number, symbols: [{ symbol, candles: Row[] }] }
//   stdout : { signals: { [symbol]: boolean[] } }  on success
//            { error: string }                     on any failure (reported in-band)
//
// The bundle must export `signals(candles, seed): boolean[]` (named or default).

import { writeFileSync } from 'node:fs';

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
    });
    process.stdin.on('end', () => resolve(buf));
  });
}

async function main() {
  const raw = await readStdin();
  const req = JSON.parse(raw);

  writeFileSync('/tmp/module.mjs', String(req.bundleSource));
  const mod = await import('/tmp/module.mjs');
  const fn = typeof mod.signals === 'function' ? mod.signals : mod.default;
  if (typeof fn !== 'function') {
    throw new Error('bundle must export a `signals(candles, seed)` function');
  }

  const out = {};
  for (const { symbol, candles } of req.symbols) {
    const sig = fn(candles, req.seed);
    if (!Array.isArray(sig) || sig.some((x) => typeof x !== 'boolean')) {
      throw new Error(`signals(${symbol}) must return a boolean[]`);
    }
    out[symbol] = sig;
  }
  process.stdout.write(JSON.stringify({ signals: out }));
}

main().catch((err) => {
  const message = String((err && err.message) || err).slice(0, 1000);
  try {
    process.stdout.write(JSON.stringify({ error: message }));
  } catch {
    // stdout unusable; the host will see no valid output and map it to sandbox_module_error.
  }
});
