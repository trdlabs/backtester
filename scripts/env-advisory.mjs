#!/usr/bin/env node
// `npm run env:advisory` — advisory-отчёт о прямых чтениях process.env вне apps/backtester/src/env.ts
// (env-catalog item 3, гейт «Полнота схемы» — пока advisory: CI НЕ валит, exit code всегда 0).
// Известный хвост (см. docs/ROADMAP.md, item 26): тесты и sandbox-shim deny-shims.mjs.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Единственная санкционированная точка чтения process.env.
const ALLOWED = new Set(['apps/backtester/src/env.ts']);

// Явный хвост (задокументирован в docs/ROADMAP.md): прямые чтения допустимы, но перечисляются.
const KNOWN_TAIL_PREFIXES = [
  'apps/backtester/test/', // тесты мутируют/читают process.env напрямую (vitest-изоляция)
  'apps/backtester/scripts/', // dev/ops-инструменты (bench, evidence, фикстуры) — переменные объявлены в схеме, чтение прямое
  'apps/backtester/sandbox-harness-overlay/deny-shims.mjs', // defense-in-depth shim, не потребитель переменных
];

let out = '';
try {
  out = execFileSync(
    'git',
    ['grep', '-n', 'process\\.env', '--', '*.ts', '*.mts', '*.mjs', '*.js', ':!.claude', ':!node_modules'],
    { cwd: ROOT, encoding: 'utf8' },
  );
} catch (err) {
  // git grep выходит с кодом 1 при нуле совпадений — это не ошибка.
  if (err.status !== 1) throw err;
}

const hits = out
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [file, lineNo] = line.split(':', 2);
    return { file, lineNo, line };
  })
  .filter((h) => !ALLOWED.has(h.file));

const tail = hits.filter((h) => KNOWN_TAIL_PREFIXES.some((p) => h.file.startsWith(p)));
const unexpected = hits.filter((h) => !KNOWN_TAIL_PREFIXES.some((p) => h.file.startsWith(p)));

console.log('env-advisory: прямые чтения process.env вне apps/backtester/src/env.ts');
console.log(`  известный хвост (docs/ROADMAP.md item 26): ${tail.length} чтений в ${new Set(tail.map((h) => h.file)).size} файлах`);
for (const f of [...new Set(tail.map((h) => h.file))].sort()) {
  console.log(`    - ${f} (${tail.filter((h) => h.file === f).length})`);
}
if (unexpected.length > 0) {
  console.log(`  ВНЕ хвоста (кандидаты на перевод в env.ts): ${unexpected.length}`);
  for (const h of unexpected) console.log(`    ! ${h.line}`);
} else {
  console.log('  вне хвоста: 0 — связное ядро (src) читает env только через env.ts');
}
process.exit(0); // advisory: никогда не валит CI
