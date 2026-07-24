// TQ-1 — CLI аудита skip-поверхности тестов (control-center `test-quality-hardening`).
//
//   pnpm test:skips                 # markdown-отчёт в stdout
//   pnpm test:skips -- --json       # машинный вывод
//   pnpm test:skips -- --check      # exit 1, если есть `.only` или безусловный `.skip` без прагмы
//
// Тот же гейт живёт внутри `pnpm test` (`test/skip-audit.test.ts`), поэтому отдельный шаг в
// CI-workflow не нужен; CLI — для локального прогона и генерации отчёта в `docs/reports/`.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditTree, formatMarkdown, isViolation } from './lib/skip-audit.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = new Set(process.argv.slice(2));

const sites = auditTree(REPO_ROOT);
const violations = sites.filter(isViolation);

if (args.has('--json')) {
  console.log(JSON.stringify({ repoRoot: REPO_ROOT, sites, violations }, null, 2));
} else {
  console.log(formatMarkdown(sites));
}

if (args.has('--check')) {
  if (violations.length > 0) {
    // В stderr, вместе со списком: stdout может быть перенаправлен в файл отчёта, и тогда
    // «см. таблицу выше» осталось бы без таблицы.
    console.error(`skip-audit: ${violations.length} нарушение(й):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line} ${v.block}.${v.modifier} (${v.cls})`);
    process.exit(1);
  }
  console.error('skip-audit: нарушений нет');
}
