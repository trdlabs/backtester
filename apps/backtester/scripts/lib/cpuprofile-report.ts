// Разбор `.cpuprofile` (V8 CPU profile, формат `node --cpu-prof`) в таблицу self-time.
//
// Зачем свой разборщик, а не speedscope: вопрос, на который отвечает станок, — «какая ДОЛЯ
// 0.5 мс/бар приходится на каждую часть раннера», а это агрегат self-time по функциям и по файлам,
// который надо приложить к отчёту текстом и сравнить с будущим Rust-портом. Флеймграф хорош для
// глаз, таблица — для решения и для диффа между замерами.

/** Узел дерева V8-профиля (`profile.nodes[]`). */
interface ProfileNode {
  readonly id: number;
  readonly callFrame: {
    readonly functionName: string;
    readonly url: string;
    readonly lineNumber: number;
  };
  readonly children?: readonly number[];
  readonly hitCount?: number;
}

interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly startTime: number;
  readonly endTime: number;
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

export interface SelfTimeRow {
  readonly key: string;
  readonly functionName: string;
  readonly location: string;
  readonly selfMs: number;
  readonly share: number;
}

export interface ProfileSummary {
  readonly totalMs: number;
  /** Учтённое семплами время (сумма дельт) — может быть меньше wall из-за пропусков. */
  readonly sampledMs: number;
  readonly byFunction: readonly SelfTimeRow[];
  readonly byFile: readonly SelfTimeRow[];
}

/** Короткое имя файла: срезает абсолютный префикс, оставляя путь от корня приложения. */
export function shortenUrl(url: string): string {
  if (url === '') return '(native)';
  const cleaned = url.replace(/^file:\/\//, '');
  const marker = '/apps/backtester/';
  const at = cleaned.indexOf(marker);
  if (at !== -1) return cleaned.slice(at + marker.length);
  const nm = cleaned.lastIndexOf('/node_modules/');
  if (nm !== -1) return 'node_modules/' + cleaned.slice(nm + '/node_modules/'.length);
  if (cleaned.startsWith('node:')) return cleaned;
  return cleaned;
}

/**
 * Self-time по семплам. V8 пишет `samples[i]` — id узла, «пойманного» на i-м семпле, и
 * `timeDeltas[i]` — микросекунды, ПРОШЕДШИЕ ДО этого семпла. Время i-го семпла относим к его узлу:
 * это стандартная интерпретация (та же, что в DevTools), и она даёт self-time, а не total.
 */
export function summarizeCpuProfile(raw: unknown, opts: { readonly top: number }): ProfileSummary {
  const profile = raw as CpuProfile;
  if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples)) {
    throw new Error('cpuprofile-report: not a V8 CPU profile (missing nodes/samples)');
  }

  const byId = new Map<number, ProfileNode>();
  for (const n of profile.nodes) byId.set(n.id, n);

  const selfUs = new Map<number, number>();
  let sampledUs = 0;
  for (let i = 0; i < profile.samples.length; i += 1) {
    const delta = profile.timeDeltas[i] ?? 0;
    if (delta <= 0) continue;
    sampledUs += delta;
    const id = profile.samples[i]!;
    selfUs.set(id, (selfUs.get(id) ?? 0) + delta);
  }

  const fnUs = new Map<string, { fn: string; loc: string; us: number }>();
  const fileUs = new Map<string, number>();
  for (const [id, us] of selfUs) {
    const node = byId.get(id);
    if (node === undefined) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    const file = shortenUrl(url);
    const fn = functionName === '' ? '(anonymous)' : functionName;
    const loc = `${file}:${lineNumber + 1}`;
    const key = `${fn}@${loc}`;
    const prev = fnUs.get(key);
    if (prev === undefined) fnUs.set(key, { fn, loc, us });
    else prev.us += us;
    fileUs.set(file, (fileUs.get(file) ?? 0) + us);
  }

  const totalMs = sampledUs / 1000;
  const toRows = (entries: { key: string; fn: string; loc: string; us: number }[]): SelfTimeRow[] =>
    entries
      .sort((a, b) => b.us - a.us)
      .slice(0, opts.top)
      .map((e) => ({
        key: e.key,
        functionName: e.fn,
        location: e.loc,
        selfMs: e.us / 1000,
        share: sampledUs === 0 ? 0 : e.us / sampledUs,
      }));

  const byFunction = toRows([...fnUs].map(([key, v]) => ({ key, fn: v.fn, loc: v.loc, us: v.us })));
  const byFile = toRows([...fileUs].map(([file, us]) => ({ key: file, fn: file, loc: file, us })));

  return {
    totalMs: (profile.endTime - profile.startTime) / 1000,
    sampledMs: totalMs,
    byFunction,
    byFile,
  };
}

export function formatSummary(summary: ProfileSummary, meta: { readonly bars: number }): string {
  const lines: string[] = [];
  const perBarUs = (ms: number): string => ((ms * 1000) / meta.bars).toFixed(1);

  lines.push(`Профиль: wall ${summary.totalMs.toFixed(0)} мс, учтено семплами ${summary.sampledMs.toFixed(0)} мс, баров ${meta.bars}`);
  lines.push('');
  lines.push('## Self-time по функциям');
  lines.push('');
  lines.push('| % | self, мс | мкс/бар | функция | где |');
  lines.push('| ---: | ---: | ---: | --- | --- |');
  for (const r of summary.byFunction) {
    lines.push(`| ${(r.share * 100).toFixed(1)} | ${r.selfMs.toFixed(0)} | ${perBarUs(r.selfMs)} | \`${r.functionName}\` | ${r.location} |`);
  }
  lines.push('');
  lines.push('## Self-time по файлам');
  lines.push('');
  lines.push('| % | self, мс | мкс/бар | файл |');
  lines.push('| ---: | ---: | ---: | --- |');
  for (const r of summary.byFile) {
    lines.push(`| ${(r.share * 100).toFixed(1)} | ${r.selfMs.toFixed(0)} | ${perBarUs(r.selfMs)} | ${r.key} |`);
  }
  return lines.join('\n');
}
