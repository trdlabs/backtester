// Чистая часть бенчмарк-станка референс-бэктеста (control-center `dark-flag-validation`, item 3).
//
// Здесь нет ни Docker, ни движка: только матрица вариантов, агрегация повторов, разбор строк
// IPC-профиля (`SandboxSession` печатает их при `BACKTESTER_IPC_PROFILE=true`), вердикт
// byte-identity и markdown. Всё это тестируется юнитами; тяжёлый прогон живёт в
// `../bench-reference-backtest.mts`.

export type VariantName = 'off' | 'bar_batching' | 'bar_major' | 'bar_major_batch';

export interface VariantFlags {
  barBatching: boolean;
  barMajor: boolean;
  barMajorBatch: boolean;
}

/**
 * `barBatching` (17b) и `barMajor` (17d) взаимоисключимы — `config.ts` падает fail-fast, если
 * включены оба. Поэтому вариантов ровно четыре, а не восемь.
 */
export const VARIANTS: Record<VariantName, VariantFlags> = {
  off: { barBatching: false, barMajor: false, barMajorBatch: false },
  bar_batching: { barBatching: true, barMajor: false, barMajorBatch: false },
  bar_major: { barBatching: false, barMajor: true, barMajorBatch: false },
  bar_major_batch: { barBatching: false, barMajor: true, barMajorBatch: true },
};

const ORDER: VariantName[] = ['off', 'bar_batching', 'bar_major', 'bar_major_batch'];

/** Разбор `BENCH_VARIANTS`. Baseline (`off`) всегда присутствует и идёт первым — с ним сверяются хэши. */
export function parseVariants(spec: string | undefined): VariantName[] {
  if (spec === undefined || spec.trim() === '') return [...ORDER];
  const picked = new Set<VariantName>(['off']);
  for (const raw of spec.split(',')) {
    const name = raw.trim();
    if (name === '') continue;
    if (!(name in VARIANTS)) {
      throw new Error(`неизвестный вариант: ${name} (допустимы: ${ORDER.join(', ')})`);
    }
    picked.add(name as VariantName);
  }
  return ORDER.filter((v) => picked.has(v));
}

export interface IpcProfile {
  hookCalls: number;
  symbolInits: number;
  barMajorBatches: number;
  ipcWaitMs: number;
  openMs: number;
}

const EMPTY_IPC: IpcProfile = { hookCalls: 0, symbolInits: 0, barMajorBatches: 0, ipcWaitMs: 0, openMs: 0 };

/** Одна строка `{evt:'ipc_profile', …}` из stderr сессии; всё остальное — `undefined`. */
export function parseIpcProfileLine(line: string): IpcProfile | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  if (rec.evt !== 'ipc_profile') return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    hookCalls: num(rec.hookCalls),
    symbolInits: num(rec.symbolInits),
    barMajorBatches: num(rec.barMajorBatches),
    ipcWaitMs: num(rec.ipcWaitMs),
    openMs: num(rec.openMs),
  };
}

/** Сумма по всем sandbox-сессиям одного прогона. */
export function sumIpcProfiles(profiles: IpcProfile[]): IpcProfile {
  return profiles.reduce<IpcProfile>(
    (acc, p) => ({
      hookCalls: acc.hookCalls + p.hookCalls,
      symbolInits: acc.symbolInits + p.symbolInits,
      barMajorBatches: acc.barMajorBatches + p.barMajorBatches,
      ipcWaitMs: acc.ipcWaitMs + p.ipcWaitMs,
      openMs: acc.openMs + p.openMs,
    }),
    { ...EMPTY_IPC },
  );
}

export interface RepeatSample {
  wallMs: number;
  resultHash: string;
  ipc: IpcProfile;
}

export interface VariantResult {
  variant: VariantName;
  samples: RepeatSample[];
}

export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface IdentityVerdict {
  pass: boolean;
  baselineHash: string;
  mismatches: { variant: VariantName; hash: string }[];
}

/**
 * Byte-identity: КАЖДЫЙ сэмпл КАЖДОГО варианта обязан повторить хэш первого baseline-прогона.
 * Baseline сверяется сам с собой намеренно — нестабильность между повторами так же ломает
 * основание для сравнения, как и расхождение флага.
 */
export function identityVerdict(results: VariantResult[]): IdentityVerdict {
  const baseline = results.find((r) => r.variant === 'off');
  if (baseline === undefined || baseline.samples.length === 0) {
    throw new Error('нет baseline-варианта `off` — сверять byte-identity не с чем');
  }
  const baselineHash = baseline.samples[0]!.resultHash;
  const mismatches: { variant: VariantName; hash: string }[] = [];
  for (const r of results) {
    for (const s of r.samples) {
      if (s.resultHash !== baselineHash) mismatches.push({ variant: r.variant, hash: s.resultHash });
    }
  }
  return { pass: mismatches.length === 0, baselineHash, mismatches };
}

export interface BenchMeta {
  request: string;
  bundle: string;
  symbols: number;
  repeats: number;
  host: string;
}

export function formatBenchMarkdown(results: VariantResult[], meta: BenchMeta): string {
  const verdict = identityVerdict(results);
  const baselineMedian = median(results.find((r) => r.variant === 'off')!.samples.map((s) => s.wallMs));

  const lines: string[] = [];
  lines.push(
    `Фикстура: \`${meta.request}\` + \`${meta.bundle}\` (${meta.symbols} символ(а/ов)), ` +
      `повторов: ${meta.repeats}, стенд: ${meta.host}`,
    '',
  );
  lines.push('| Вариант | min ms | median ms | speedup | hash == baseline | hookCalls | barMajorBatches | ipcWaitMs | openMs |');
  lines.push('| --- | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: |');
  for (const r of results) {
    const walls = r.samples.map((s) => s.wallMs);
    const med = median(walls);
    const ipc = sumIpcProfiles(r.samples.map((s) => s.ipc));
    const n = Math.max(1, r.samples.length);
    const same = r.samples.every((s) => s.resultHash === verdict.baselineHash);
    lines.push(
      `| \`${r.variant}\` | ${Math.min(...walls).toFixed(0)} | ${med.toFixed(0)} | ` +
        `${(baselineMedian / med).toFixed(2)}× | ${same ? '✅' : '❌'} | ` +
        `${Math.round(ipc.hookCalls / n)} | ${Math.round(ipc.barMajorBatches / n)} | ` +
        `${Math.round(ipc.ipcWaitMs / n)} | ${Math.round(ipc.openMs / n)} |`,
    );
  }
  lines.push('');
  lines.push(`byte-identity: ${verdict.pass ? 'PASS' : 'FAIL'} (baseline \`${verdict.baselineHash}\`)`);
  if (!verdict.pass) {
    lines.push('');
    lines.push('Расхождения:');
    for (const m of verdict.mismatches) lines.push(`- \`${m.variant}\` → \`${m.hash}\``);
  }
  lines.push('');
  lines.push('IPC-колонки — сумма по всем sandbox-сессиям прогона, усреднённая по повторам.');
  return lines.join('\n');
}
