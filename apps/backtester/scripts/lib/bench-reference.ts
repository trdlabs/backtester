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

/**
 * С чем сверяется хэш каждого варианта.
 *
 * `bar_batching` — чистый транспорт: обязан повторить `off`.
 * `bar_major` — НЕ транспортный флаг: это смена модели исполнения (per-symbol portfolio +
 * equal-weight агрегация по union-таймлайну), результат отличается от symbol-major ПО ДИЗАЙНУ,
 * и golden-тесты репо сверяют его с собственным замороженным golden, а не с `off`. Поэтому его
 * референс — он сам: проверяется только стабильность между повторами.
 * `bar_major_batch` — Slice B, схлопывание транспорта ВНУТРИ bar-major: обязан повторить `bar_major`.
 */
export const IDENTITY_BASELINE: Record<VariantName, VariantName> = {
  off: 'off',
  bar_batching: 'off',
  bar_major: 'bar_major',
  bar_major_batch: 'bar_major',
};

export interface IdentityVerdict {
  pass: boolean;
  /** Хэш первого прогона каждого варианта-референса, встреченного в выборке. */
  baselineHashes: Record<string, string>;
  mismatches: { variant: VariantName; hash: string; baseline: VariantName; expected: string }[];
  /** Варианты, чей референс не попал в выборку — сверялись сами с собой. */
  unanchored: VariantName[];
}

/**
 * Byte-identity: КАЖДЫЙ сэмпл КАЖДОГО варианта обязан повторить хэш первого прогона своего
 * референса (см. `IDENTITY_BASELINE`). Вариант сверяется в том числе сам с собой — нестабильность
 * между повторами ломает основание для сравнения так же, как и расхождение флага.
 */
export function identityVerdict(results: VariantResult[]): IdentityVerdict {
  const firstHash = new Map<VariantName, string>();
  for (const r of results) {
    if (r.samples.length > 0) firstHash.set(r.variant, r.samples[0]!.resultHash);
  }
  if (firstHash.size === 0) throw new Error('нет ни одного прогона — сверять byte-identity не с чем');

  const mismatches: IdentityVerdict['mismatches'] = [];
  const unanchored: VariantName[] = [];
  const baselineHashes: Record<string, string> = {};

  for (const r of results) {
    const wanted = IDENTITY_BASELINE[r.variant];
    const anchor = firstHash.has(wanted) ? wanted : r.variant;
    if (anchor !== wanted) unanchored.push(r.variant);
    const expected = firstHash.get(anchor)!;
    baselineHashes[anchor] = expected;
    for (const s of r.samples) {
      if (s.resultHash !== expected) {
        mismatches.push({ variant: r.variant, hash: s.resultHash, baseline: anchor, expected });
      }
    }
  }
  return { pass: mismatches.length === 0, baselineHashes, mismatches, unanchored };
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
  const off = results.find((r) => r.variant === 'off');
  const baselineMedian = off === undefined ? Number.NaN : median(off.samples.map((s) => s.wallMs));

  const lines: string[] = [];
  lines.push(
    `Фикстура: \`${meta.request}\` + \`${meta.bundle}\` (${meta.symbols} символ(а/ов)), ` +
      `повторов: ${meta.repeats}, стенд: ${meta.host}`,
    '',
  );
  lines.push('| Вариант | min ms | median ms | speedup к `off` | референс | hash == референс | hookCalls | barMajorBatches | ipcWaitMs | openMs |');
  lines.push('| --- | ---: | ---: | ---: | --- | :---: | ---: | ---: | ---: | ---: |');
  for (const r of results) {
    const walls = r.samples.map((s) => s.wallMs);
    const med = median(walls);
    const ipc = sumIpcProfiles(r.samples.map((s) => s.ipc));
    const n = Math.max(1, r.samples.length);
    const bad = verdict.mismatches.some((m) => m.variant === r.variant);
    lines.push(
      `| \`${r.variant}\` | ${Math.min(...walls).toFixed(0)} | ${med.toFixed(0)} | ` +
        `${(baselineMedian / med).toFixed(2)}× | \`${IDENTITY_BASELINE[r.variant]}\` | ${bad ? '❌' : '✅'} | ` +
        `${Math.round(ipc.hookCalls / n)} | ${Math.round(ipc.barMajorBatches / n)} | ` +
        `${Math.round(ipc.ipcWaitMs / n)} | ${Math.round(ipc.openMs / n)} |`,
    );
  }
  lines.push('');
  lines.push(`byte-identity: ${verdict.pass ? 'PASS' : 'FAIL'}`);
  if (!verdict.pass) {
    lines.push('');
    lines.push('Расхождения:');
    for (const m of verdict.mismatches) {
      lines.push(`- \`${m.variant}\` → \`${m.hash}\` (референс \`${m.baseline}\` → \`${m.expected}\`)`);
    }
  }
  if (verdict.unanchored.length > 0) {
    lines.push('');
    lines.push(`Без своего референса в выборке (сверялись сами с собой): ${verdict.unanchored.map((v) => `\`${v}\``).join(', ')}.`);
  }

  // Отдельной строкой — факт, который таблица с per-variant референсами иначе прячет.
  const offHash = results.find((r) => r.variant === 'off')?.samples[0]?.resultHash;
  const bmHash = results.find((r) => r.variant === 'bar_major')?.samples[0]?.resultHash;
  if (offHash !== undefined && bmHash !== undefined) {
    lines.push('');
    lines.push(
      bmHash === offHash
        ? '`bar_major` совпал с `off` побайтово.'
        : '`bar_major` ОТЛИЧАЕТСЯ от `off` побайтово — это смена модели исполнения (per-symbol portfolio + equal-weight агрегация), а не транспорт; включение флага меняет результат.',
    );
  }
  lines.push('');
  lines.push('IPC-колонки — сумма по всем sandbox-сессиям прогона, усреднённая по повторам.');
  return lines.join('\n');
}
