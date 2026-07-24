// Чистая часть бенчмарк-станка референс-бэктеста (control-center `dark-flag-validation`, item 3).
//
// Здесь нет ни Docker, ни движка: матрица вариантов, агрегация повторов, разбор строк IPC-профиля
// (`SandboxSession` печатает их при `BACKTESTER_IPC_PROFILE=true`), проверка «флаг вообще
// задействовался», вердикт byte-identity и markdown. Тяжёлый прогон — `../bench-reference-backtest.mts`.
//
// ГЛАВНЫЙ УРОК ЭТОГО ФАЙЛА (ревью PR #160): первая редакция передавала `barBatching: true`, тогда как
// движок ждёт `{ maxBars }`, и гоняла Slice B без universe-сессии, без которой коллапс транспорта
// невозможен. Оба варианта молча исполняли baseline, а таблица показывала уверенный PASS. Поэтому
// теперь: (1) оверрайды типизированы как реальный кусок `RunDeps`, (2) у каждого варианта есть
// предикат `engaged`, и прогон, в котором флаг не оставил следа в IPC-профиле, объявляется
// недействительным, а не «без ускорения».

export type VariantName = 'off' | 'bar_batching' | 'bar_major' | 'bar_major_universe' | 'bar_major_batch';

/** Оверрайд deps для `runBacktest` — подмножество `RunDeps` (см. `src/engine/runner.ts`). */
export interface RunFlags {
  readonly barBatching?: { readonly maxBars: number };
  readonly barMajor?: boolean;
  readonly barMajorBatch?: boolean;
  readonly universe?: { readonly enabled: boolean; readonly maxN: number; readonly memBaseMb: number; readonly memPerSymbolMb: number };
}

/** Universe-деки для СБОРКИ роутера (`buildSandboxStrategyBaselineDeps`) — другая форма, чем в RunDeps. */
export interface RouterUniverse {
  readonly enabled: boolean;
  readonly n: number;
  readonly memBaseMb: number;
  readonly memPerSymbolMb: number;
}

export interface VariantSpec {
  readonly run: RunFlags;
  /** Без universe-сессии Slice B вырождается в per-symbol lockstep — коллапса не будет. */
  readonly routerUniverse: boolean;
  /** Человекочитаемое описание, что именно меряет вариант. */
  readonly what: string;
}

/** 17b `maxBars` — то же значение, что дефолт продакшн-воркера (`jobs/worker.ts`). */
export const BATCH_MAX_BARS = 64;

const UNIVERSE_RUN = { enabled: true, maxN: 64, memBaseMb: 128, memPerSymbolMb: 8 } as const;

/**
 * `barBatching` (17b) и `barMajor` (17d) взаимоисключимы — `config.ts` падает fail-fast, если
 * включены оба, поэтому смешанных вариантов нет. `bar_major_universe` существует, чтобы отделить
 * эффект universe-сессии (17c) от эффекта batch-транспорта (Slice B): без него они смешаны.
 */
export const VARIANTS: Record<VariantName, VariantSpec> = {
  off: { run: {}, routerUniverse: false, what: 'baseline: symbol-major, per-symbol сессии, lockstep IPC' },
  bar_batching: {
    run: { barBatching: { maxBars: BATCH_MAX_BARS } },
    routerUniverse: false,
    what: '17b: flat-stretch onBarClose схлопывается в одно сообщение',
  },
  bar_major: { run: { barMajor: true }, routerUniverse: false, what: '17d Slice A: bar-major, per-symbol портфели' },
  bar_major_universe: {
    run: { barMajor: true, universe: UNIVERSE_RUN },
    routerUniverse: true,
    what: '17d + 17c: bar-major в ОДНОЙ universe-сессии (N инстансов в одном контейнере)',
  },
  bar_major_batch: {
    run: { barMajor: true, barMajorBatch: true, universe: UNIVERSE_RUN },
    routerUniverse: true,
    what: 'Slice B: bar-major + universe + схлопнутый 3-фазный транспорт (одно сообщение на бар)',
  },
};

const ORDER: VariantName[] = ['off', 'bar_batching', 'bar_major', 'bar_major_universe', 'bar_major_batch'];

export interface IpcProfile {
  hookCalls: number;
  symbolInits: number;
  barMajorBatches: number;
  hookBatches: number;
  ipcWaitMs: number;
  openMs: number;
}

const EMPTY_IPC: IpcProfile = { hookCalls: 0, symbolInits: 0, barMajorBatches: 0, hookBatches: 0, ipcWaitMs: 0, openMs: 0 };

/**
 * С чем сверяется хэш каждого варианта.
 *
 * `bar_batching` — чистый транспорт: обязан повторить `off`.
 * `bar_major` — НЕ транспортный флаг: смена модели исполнения (per-symbol portfolio + equal-weight
 * агрегация по union-таймлайну), результат отличается от symbol-major ПО ДИЗАЙНУ, и golden-тесты
 * репо сверяют его с собственным замороженным golden. Референс — он сам (стабильность повторов).
 * `bar_major_universe` — 17c byte-identical по своему golden-гейту ⇒ обязан повторить `bar_major`.
 * `bar_major_batch` — Slice B поверх universe ⇒ обязан повторить `bar_major_universe`.
 */
export const IDENTITY_BASELINE: Record<VariantName, VariantName> = {
  off: 'off',
  bar_batching: 'off',
  bar_major: 'bar_major',
  bar_major_universe: 'bar_major',
  bar_major_batch: 'bar_major_universe',
};

/**
 * Разбор `BENCH_VARIANTS`. Дотягивает ТРАНЗИТИВНОЕ замыкание референсов: без этого
 * `BENCH_VARIANTS=bar_major_batch` дал бы вариант без якоря, тот сверился бы сам с собой и
 * отрапортовал PASS, даже если Slice B ломает результат.
 */
export function parseVariants(spec: string | undefined): VariantName[] {
  if (spec === undefined || spec.trim() === '') return [...ORDER];
  const picked = new Set<VariantName>();
  for (const raw of spec.split(',')) {
    const name = raw.trim();
    if (name === '') continue;
    if (!(name in VARIANTS)) {
      throw new Error(`неизвестный вариант: ${name} (допустимы: ${ORDER.join(', ')})`);
    }
    let cur = name as VariantName;
    picked.add(cur);
    for (let guard = 0; guard < ORDER.length; guard += 1) {
      const anchor = IDENTITY_BASELINE[cur];
      if (anchor === cur || picked.has(anchor)) break;
      picked.add(anchor);
      cur = anchor;
    }
  }
  return ORDER.filter((v) => picked.has(v));
}

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
    hookBatches: num(rec.hookBatches),
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
      hookBatches: acc.hookBatches + p.hookBatches,
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
  /** Сколько sandbox-сессий закрылось за прогон — прямой признак universe-коллапса (N → 1). */
  sessions: number;
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
 * Оставил ли флаг след в наблюдаемом поведении. Прогон, где след отсутствует, — НЕ «без
 * ускорения», а недействительный замер: именно так первая редакция станка отрапортовала PASS по
 * двум невключённым флагам.
 *
 * `baselineHash` нужен для `bar_major`: у него нет своего счётчика, но он ОБЯЗАН изменить
 * `result_hash` относительно symbol-major — это и есть доказательство, что флаг сработал.
 */
export function engagementProblem(
  variant: VariantName,
  sample: RepeatSample,
  offHash: string | undefined,
): string | undefined {
  const { ipc } = sample;
  switch (variant) {
    case 'off':
      return undefined;
    case 'bar_batching':
      return ipc.hookBatches > 0 ? undefined : 'hookBatches=0 — батч 17b ни разу не отправлен';
    case 'bar_major':
      if (offHash !== undefined && sample.resultHash === offHash) {
        return 'result_hash совпал с symbol-major — bar-major не сработал (при N>1 он обязан отличаться)';
      }
      return undefined;
    case 'bar_major_universe':
      return sample.sessions <= 1 || ipc.symbolInits > 1
        ? undefined
        : `sessions=${sample.sessions}, symbolInits=${ipc.symbolInits} — universe-сессия не собралась`;
    case 'bar_major_batch':
      return ipc.barMajorBatches > 0 ? undefined : 'barMajorBatches=0 — 3-фазный батч Slice B не отправлен';
  }
}

export interface IdentityVerdict {
  pass: boolean;
  baselineHashes: Record<string, string>;
  mismatches: { variant: VariantName; hash: string; baseline: VariantName; expected: string }[];
  /** Варианты, чей референс не попал в выборку — сверялись сами с собой (вердикт неполный). */
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
  const offMedian = off === undefined ? Number.NaN : median(off.samples.map((s) => s.wallMs));
  const offHash = off?.samples[0]?.resultHash;

  const lines: string[] = [];
  lines.push(
    `Фикстура: \`${meta.request}\` + \`${meta.bundle}\` (${meta.symbols} символ(а/ов)), ` +
      `повторов: ${meta.repeats}, стенд: ${meta.host}`,
    '',
  );
  lines.push('| Вариант | min ms | median ms | ×`off` | референс | hash == реф. | флаг задействован | сессий | hookCalls | hookBatches | barMajorBatches | ipcWaitMs | openMs |');
  lines.push('| --- | ---: | ---: | ---: | --- | :---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of results) {
    if (r.samples.length === 0) {
      lines.push(`| \`${r.variant}\` | — | — | — | — | — | — | — | — | — | — | — | — |`);
      continue;
    }
    const walls = r.samples.map((s) => s.wallMs);
    const med = median(walls);
    const ipc = sumIpcProfiles(r.samples.map((s) => s.ipc));
    const n = r.samples.length;
    const bad = verdict.mismatches.some((m) => m.variant === r.variant);
    const notEngaged = r.samples.some((s) => engagementProblem(r.variant, s, offHash) !== undefined);
    const selfRef = IDENTITY_BASELINE[r.variant] === r.variant;
    lines.push(
      `| \`${r.variant}\` | ${Math.min(...walls).toFixed(0)} | ${med.toFixed(0)} | ` +
        `${(offMedian / med).toFixed(2)}× | \`${IDENTITY_BASELINE[r.variant]}\` | ` +
        `${bad ? '❌' : selfRef ? '— (сам с собой)' : '✅'} | ${notEngaged ? '❌' : '✅'} | ` +
        `${Math.round(r.samples.reduce((a, s) => a + s.sessions, 0) / n)} | ` +
        `${Math.round(ipc.hookCalls / n)} | ${Math.round(ipc.hookBatches / n)} | ` +
        `${Math.round(ipc.barMajorBatches / n)} | ${Math.round(ipc.ipcWaitMs / n)} | ${Math.round(ipc.openMs / n)} |`,
    );
  }
  lines.push('');
  lines.push(`byte-identity: ${verdict.pass ? 'PASS' : 'FAIL'}`);
  if (!verdict.pass) {
    lines.push('', 'Расхождения:');
    for (const m of verdict.mismatches) {
      lines.push(`- \`${m.variant}\` → \`${m.hash}\` (референс \`${m.baseline}\` → \`${m.expected}\`)`);
    }
  }
  if (verdict.unanchored.length > 0) {
    lines.push('', `⚠️ Без своего референса в выборке (вердикт неполный): ${verdict.unanchored.map((v) => `\`${v}\``).join(', ')}.`);
  }

  const bmHash = results.find((r) => r.variant === 'bar_major')?.samples[0]?.resultHash;
  if (offHash !== undefined && bmHash !== undefined) {
    lines.push(
      '',
      bmHash === offHash
        ? '⚠️ `bar_major` совпал с `off` побайтово — при N>1 он обязан отличаться, значит флаг НЕ сработал.'
        : '`bar_major` отличается от `off` побайтово — это смена модели исполнения (per-symbol portfolio + equal-weight агрегация), а не транспорт; включение флага меняет результат.',
    );
  }
  lines.push('', 'Колонка «×`off`» для bar-major-вариантов сравнивает время РАЗНЫХ моделей исполнения — читать как «сколько занимает», а не «во сколько раз лучше».');
  lines.push('IPC-колонки — сумма по всем sandbox-сессиям прогона, усреднённая по повторам.');
  return lines.join('\n');
}
