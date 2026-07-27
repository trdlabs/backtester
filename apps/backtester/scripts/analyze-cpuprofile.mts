// PERF — разбор `.cpuprofile`, снятого с `profile-runner.mts`, в таблицу self-time.
//
//   node --cpu-prof --cpu-prof-dir=.artifacts/prof --import tsx apps/backtester/scripts/profile-runner.mts
//   pnpm exec tsx apps/backtester/scripts/analyze-cpuprofile.mts .artifacts/prof/<файл>.cpuprofile [--bars N]
//
// Без аргумента-пути берётся самый свежий `.cpuprofile` из `.artifacts/prof`.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { formatSummary, summarizeCpuProfile } from './lib/cpuprofile-report.js';

const argv = process.argv.slice(2);
const flagAt = (name: string): number => argv.indexOf(name);
const readFlag = (name: string): string | undefined => {
  const at = flagAt(name);
  return at === -1 ? undefined : argv[at + 1];
};

const positional = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1]!.startsWith('--')));
const DEFAULT_DIR = resolve(process.cwd(), '.artifacts/prof');

function newestProfile(dir: string): string {
  const found = readdirSync(dir)
    .filter((f) => f.endsWith('.cpuprofile'))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (found.length === 0) throw new Error(`нет .cpuprofile в ${dir}`);
  return found[0]!.path;
}

const profilePath = positional[0] ?? newestProfile(DEFAULT_DIR);
const bars = Number(readFlag('--bars') ?? process.env.PROFILE_BARS ?? 60_000);
const top = Number(readFlag('--top') ?? 30);
const outPath = readFlag('--out');

const summary = summarizeCpuProfile(JSON.parse(readFileSync(profilePath, 'utf8')), { top });
const report = `Профиль: \`${profilePath}\`\n\n` + formatSummary(summary, { bars });

console.log(report);
if (outPath !== undefined) {
  writeFileSync(outPath, report + '\n');
  console.log(`\n[analyze-cpuprofile] отчёт → ${outPath}`);
}
