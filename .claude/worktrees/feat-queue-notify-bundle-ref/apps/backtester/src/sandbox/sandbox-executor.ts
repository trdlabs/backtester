// SandboxModuleExecutor — runs an untrusted bundle in a locked-down container and returns its signals.
// Limit/▶failure mapping is fail-closed: every abnormal outcome becomes a RunnerError with a precise
// code and terminal status (timed_out for wall-time, failed otherwise) — never a thrown service crash.

import type { ModuleBundle } from '@trading/research-contracts';
import { RunnerError } from '../runner/errors';
import type { ModuleExecutor, SymbolSeries } from '../runner/module-executor';
import { runHarnessContainer, type SandboxLimits } from './docker';

export interface SandboxConfig {
  readonly harnessDir: string;
  readonly limits: SandboxLimits;
}

interface HarnessResponse {
  signals?: Record<string, unknown>;
  error?: string;
}

export class SandboxModuleExecutor implements ModuleExecutor {
  constructor(
    private readonly bundle: ModuleBundle,
    private readonly config: SandboxConfig,
  ) {}

  async computeSignals(series: readonly SymbolSeries[], seed: number): Promise<Map<string, boolean[]>> {
    const source = this.bundle.files[this.bundle.entry];
    if (typeof source !== 'string') {
      throw new RunnerError('sandbox_module_error', `bundle entry "${this.bundle.entry}" has no source`);
    }

    const input = JSON.stringify({
      bundleSource: source,
      seed,
      symbols: series.map((s) => ({ symbol: s.symbol, candles: s.candles })),
    });

    const res = await runHarnessContainer(input, this.config.harnessDir, this.config.limits);

    if (res.spawnError) {
      throw new RunnerError('sandbox_unavailable', `failed to launch sandbox: ${res.spawnError}`);
    }
    if (res.timedOut) {
      throw new RunnerError('sandbox_timeout', 'module exceeded the sandbox wall-time limit', 'timed_out');
    }
    if (res.oomKilled) {
      throw new RunnerError('sandbox_memory_exceeded', 'module exceeded the sandbox memory limit');
    }

    let parsed: HarnessResponse;
    try {
      parsed = JSON.parse(res.stdout) as HarnessResponse;
    } catch {
      throw new RunnerError(
        'sandbox_module_error',
        `sandbox produced no valid output (exit ${res.exitCode})`,
      );
    }
    if (parsed.error) {
      throw new RunnerError('sandbox_module_error', parsed.error);
    }

    const out = new Map<string, boolean[]>();
    for (const { symbol, candles } of series) {
      const sig = parsed.signals?.[symbol];
      if (
        !Array.isArray(sig) ||
        sig.length !== candles.length ||
        sig.some((x) => typeof x !== 'boolean')
      ) {
        throw new RunnerError('sandbox_module_error', `module returned invalid signals for ${symbol}`);
      }
      out.set(symbol, sig as boolean[]);
    }
    return out;
  }
}
