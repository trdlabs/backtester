// TQ-1 — классификатор skip-поверхности vitest-тестов (control-center `test-quality-hardening`).
//
// `grep '.skip'` не различает честный средовой гейт (`describe.skipIf(!DOCKER_AVAILABLE)`) и молча
// выключенный тест (`it.skip`). Здесь — разбор, который различает, плюс прагма-аллоулист для
// сознательно отложенных тестов:
//
//   // skip-audit:allow — <причина>
//   it.skip('…', …)
//
// Чистый модуль: без I/O в разборе (`scanSource`), файловый обход вынесен в `collectTestFiles`/
// `auditTree`. CLI-обёртка — `../audit-test-skips.mts`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type SkipClass = 'gated' | 'allowed' | 'unconditional' | 'focused';
export type GateKind = 'docker' | 'postgres' | 'store-factory' | 'fixture-file' | 'env-opt-in' | 'other';
export type BlockKind = 'describe' | 'it' | 'test';
export type Modifier = 'skip' | 'skipIf' | 'runIf' | 'only' | 'todo';

export interface SkipSite {
  /** Путь файла ровно в том виде, в каком его передали в `scanSource` (относительный от корня репо). */
  file: string;
  /** 1-based номер строки сайта в исходнике. */
  line: number;
  block: BlockKind;
  modifier: Modifier;
  /** Текст выражения гейта для `skipIf`/`runIf`; для остальных модификаторов отсутствует. */
  gate?: string;
  gateKind?: GateKind;
  cls: SkipClass;
  /** Причина из прагмы `skip-audit:allow` — только для класса `allowed`. */
  reason?: string;
}

const PRAGMA = /^\s*\/\/\s*skip-audit:allow\s*(?:[—:-]\s*)?(.*)$/;
const SITE = /\b(describe|it|test)\.(skipIf|runIf|skip|only|todo)\b/g;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.worktrees', '.claude', 'coverage', '.data', '.artifacts']);

/**
 * Заменяет содержимое комментариев, строковых литералов и regex-литералов пробелами той же длины,
 * сохраняя переводы строк. Смещения и номера строк остаются валидными для исходного текста.
 */
export function blankNonCode(source: string): string {
  const out = source.split('');
  const isRegexPosition = (i: number): boolean => {
    for (let k = i - 1; k >= 0; k -= 1) {
      const c = source[k]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      return '(,=:[!&|?{};+-*%~^<>'.includes(c);
    }
    return true;
  };
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const j = end === -1 ? source.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && isRegexPosition(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const d = source[j]!;
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break; // незакрытый regex — значит это было деление, не трогаем
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j += 1; break; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length) {
        const d = source[j]!;
        if (d === '\\') { j += 2; continue; }
        if (d === c) { j += 1; break; }
        if (d === '\n' && c !== '`') { break; } // незакрытая строка — не съедаем остаток файла
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Вид средового гейта по тексту выражения `skipIf`/`runIf`. */
export function classifyGate(expr: string): GateKind {
  if (expr.includes('DOCKER_AVAILABLE')) return 'docker';
  if (expr.includes('PG_AVAILABLE')) return 'postgres';
  if (/\.available\b/.test(expr)) return 'store-factory';
  if (expr.includes('existsSync')) return 'fixture-file';
  if (expr.includes('process.env')) return 'env-opt-in';
  return 'other';
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function collectPragmas(source: string): Map<number, string> {
  const found = new Map<number, string>();
  source.split('\n').forEach((text, idx) => {
    const m = PRAGMA.exec(text);
    if (m) found.set(idx + 1, m[1]!.trim());
  });
  return found;
}

/** Разбор одного файла. Ввод — исходник целиком; вывод — все сайты модификаторов vitest. */
export function scanSource(source: string, file: string): SkipSite[] {
  const code = blankNonCode(source);
  const starts = lineStarts(source);
  const pragmas = collectPragmas(source);
  const sites: SkipSite[] = [];

  SITE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SITE.exec(code)) !== null) {
    const block = m[1] as BlockKind;
    const modifier = m[2] as Modifier;
    const line = lineOf(starts, m.index);

    let gate: string | undefined;
    let cursor = m.index + m[0].length;
    while (cursor < code.length && /\s/.test(code[cursor]!)) cursor += 1;
    if (code[cursor] === '(') {
      let depth = 0;
      let end = cursor;
      for (; end < code.length; end += 1) {
        if (code[end] === '(') depth += 1;
        else if (code[end] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (modifier === 'skipIf' || modifier === 'runIf') gate = source.slice(cursor + 1, end).trim();
    }

    const site: SkipSite = { file, line, block, modifier, cls: 'unconditional' };
    if (modifier === 'only') {
      site.cls = 'focused';
    } else if (modifier === 'skipIf' || modifier === 'runIf') {
      site.cls = 'gated';
      site.gate = gate;
      site.gateKind = classifyGate(gate ?? '');
    } else {
      const reason = pragmas.get(line - 1) ?? pragmas.get(line);
      if (reason !== undefined) {
        site.cls = 'allowed';
        site.reason = reason;
      }
    }
    sites.push(site);
  }
  return sites;
}

/** Нарушение = сфокусированный (`.only`) или молча выключенный (`.skip`/`.todo` без прагмы) тест. */
export function isViolation(site: SkipSite): boolean {
  return site.cls === 'focused' || site.cls === 'unconditional';
}

/** Рекурсивный обход: все `*.test.ts` под указанными корнями, минус служебные каталоги. */
export function collectTestFiles(roots: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // корня может не быть (например, `packages` в урезанном чекауте)
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue; // битый симлинк
      }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.test.ts')) files.push(full);
    }
  };
  for (const root of roots) walk(root);
  return files.sort();
}

/** Аудит всего репозитория: `apps/` + `packages/`. Пути в результате — относительные от корня. */
export function auditTree(repoRoot: string): SkipSite[] {
  const roots = [join(repoRoot, 'apps'), join(repoRoot, 'packages')];
  const sites: SkipSite[] = [];
  for (const abs of collectTestFiles(roots)) {
    const rel = relative(repoRoot, abs).split(sep).join('/');
    sites.push(...scanSource(readFileSync(abs, 'utf8'), rel));
  }
  return sites;
}

function countBy<K extends string>(items: K[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const k of items) acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}

/** Markdown-отчёт: сводка по классам, разбивка гейтов, нарушения, аллоулист. */
export function formatMarkdown(sites: SkipSite[]): string {
  const byClass = countBy(sites.map((s) => s.cls));
  const gated = sites.filter((s) => s.cls === 'gated');
  const byGate = countBy(gated.map((s) => s.gateKind ?? 'other'));
  const violations = sites.filter(isViolation);
  const allowed = sites.filter((s) => s.cls === 'allowed');
  const files = new Set(sites.map((s) => s.file));

  const lines: string[] = [];
  lines.push('## Сводка', '');
  lines.push(`Сайтов модификаторов: **${sites.length}** в ${files.size} файлах.`, '');
  lines.push('| Класс | Сайтов | Что это |', '| --- | --- | --- |');
  lines.push(`| \`gated\` | ${byClass.gated ?? 0} | условный пропуск по среде (\`skipIf\`/\`runIf\`) |`);
  lines.push(`| \`allowed\` | ${byClass.allowed ?? 0} | безусловный пропуск с прагмой-обоснованием |`);
  lines.push(`| \`unconditional\` | ${byClass.unconditional ?? 0} | молча выключенный тест — нарушение |`);
  lines.push(`| \`focused\` | ${byClass.focused ?? 0} | \`.only\` — нарушение |`);
  lines.push('');

  lines.push('## Условные гейты по видам', '');
  lines.push('| Вид гейта | Сайтов |', '| --- | --- |');
  for (const [kind, n] of Object.entries(byGate).sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${kind}\` | ${n} |`);
  }
  lines.push('');

  lines.push('## Нарушения', '');
  if (violations.length === 0) {
    lines.push('Нарушений нет: ни `.only`, ни безусловных `.skip`/`.todo` без прагмы.', '');
  } else {
    lines.push('| Файл:строка | Сайт | Класс |', '| --- | --- | --- |');
    for (const v of violations) lines.push(`| \`${v.file}:${v.line}\` | \`${v.block}.${v.modifier}\` | \`${v.cls}\` |`);
    lines.push('');
  }

  lines.push('## Аллоулист (осознанно отложенные тесты)', '');
  if (allowed.length === 0) {
    lines.push('Пусто.', '');
  } else {
    lines.push('| Файл:строка | Сайт | Причина |', '| --- | --- | --- |');
    for (const a of allowed) lines.push(`| \`${a.file}:${a.line}\` | \`${a.block}.${a.modifier}\` | ${a.reason ?? ''} |`);
    lines.push('');
  }

  lines.push('## Разбивка по файлам', '');
  lines.push('| Файл | gated | allowed | unconditional | focused |', '| --- | --- | --- | --- | --- |');
  for (const file of [...files].sort()) {
    const own = sites.filter((s) => s.file === file);
    const c = countBy(own.map((s) => s.cls));
    lines.push(`| \`${file}\` | ${c.gated ?? 0} | ${c.allowed ?? 0} | ${c.unconditional ?? 0} | ${c.focused ?? 0} |`);
  }
  lines.push('');
  return lines.join('\n');
}
