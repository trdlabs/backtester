# Test-skip audit (TQ-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Машинно классифицировать всю skip-поверхность тестов backtester (условные гейты против молча выключенных тестов) и удержать её от дрейфа гейтом внутри `pnpm test`.

**Architecture:** Чистый классификатор (`scripts/lib/skip-audit.ts`) сканирует исходники тестов, возвращает список сайтов модификаторов vitest с классом и видом гейта. Тонкий CLI (`scripts/audit-test-skips.mts`) обходит дерево, печатает markdown/JSON и в режиме `--check` падает на нарушениях. Тест `test/skip-audit.test.ts` покрывает классификатор юнитами и прогоняет аудит по реальному репо как гейт.

**Tech Stack:** TypeScript, tsx, vitest, node:fs.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-07-24-test-skip-audit-design.md`.
- Классы ровно четыре: `gated` / `allowed` / `unconditional` / `focused`.
- Виды гейта: `docker` / `postgres` / `store-factory` / `fixture-file` / `env-opt-in` / `other`.
- Прагма аллоулиста: `// skip-audit:allow — <причина>` на строке НЕПОСРЕДСТВЕННО выше сайта.
- Нарушение = `focused` или `unconditional`; в `--check` это exit 1.
- Поведение продакшн-кода не меняется: правки только в тестах, скриптах, доках.

---

### Task 1: Чистый классификатор skip-сайтов

**Files:**
- Create: `apps/backtester/scripts/lib/skip-audit.ts`
- Test: `apps/backtester/test/skip-audit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SkipClass = 'gated' | 'allowed' | 'unconditional' | 'focused';
  export type GateKind = 'docker' | 'postgres' | 'store-factory' | 'fixture-file' | 'env-opt-in' | 'other';
  export interface SkipSite {
    file: string; line: number;
    block: 'describe' | 'it' | 'test';
    modifier: 'skip' | 'skipIf' | 'runIf' | 'only' | 'todo';
    gate?: string; gateKind?: GateKind;
    cls: SkipClass; reason?: string;
  }
  export function classifyGate(expr: string): GateKind;
  export function scanSource(source: string, file: string): SkipSite[];
  export function isViolation(site: SkipSite): boolean;
  ```

- [ ] **Step 1: Написать падающие юнит-тесты**

```ts
import { describe, expect, it } from 'vitest';
import { classifyGate, scanSource, isViolation } from '../scripts/lib/skip-audit.js';

describe('classifyGate', () => {
  it('распознаёт канонические гейты', () => {
    expect(classifyGate('!DOCKER_AVAILABLE')).toBe('docker');
    expect(classifyGate('!PG_AVAILABLE')).toBe('postgres');
    expect(classifyGate('!factory.available')).toBe('store-factory');
    expect(classifyGate("!existsSync(VERIFIER_PATH)")).toBe('fixture-file');
    expect(classifyGate("process.env.RUN_BENCH !== '1'")).toBe('env-opt-in');
    expect(classifyGate('!enabled')).toBe('other');
  });
  it('составной гейт классифицируется по первому известному признаку', () => {
    expect(classifyGate('!DOCKER_AVAILABLE || !PG_AVAILABLE')).toBe('docker');
  });
});

describe('scanSource', () => {
  it('классифицирует skipIf как gated с выражением гейта', () => {
    const [site] = scanSource("describe.skipIf(!DOCKER_AVAILABLE)('x', () => {});", 'a.test.ts');
    expect(site).toMatchObject({ block: 'describe', modifier: 'skipIf', cls: 'gated', gateKind: 'docker', gate: '!DOCKER_AVAILABLE', line: 1 });
  });
  it('вложенные скобки в гейте не рвут разбор', () => {
    const [site] = scanSource("it.skipIf(!existsSync(join(a, 'b')))('x', () => {});", 'a.test.ts');
    expect(site.gate).toBe("!existsSync(join(a, 'b'))");
    expect(site.cls).toBe('gated');
  });
  it('безусловный skip без прагмы — unconditional', () => {
    const [site] = scanSource("it.skip('x', () => {});", 'a.test.ts');
    expect(site.cls).toBe('unconditional');
    expect(isViolation(site)).toBe(true);
  });
  it('прагма строкой выше делает skip allowed и сохраняет причину', () => {
    const [site] = scanSource("// skip-audit:allow — ждём фикса платформы\nit.skip('x', () => {});", 'a.test.ts');
    expect(site.cls).toBe('allowed');
    expect(site.reason).toBe('ждём фикса платформы');
    expect(isViolation(site)).toBe(false);
  });
  it('.only — нарушение даже с прагмой', () => {
    const [site] = scanSource("// skip-audit:allow — нет\nit.only('x', () => {});", 'a.test.ts');
    expect(site.cls).toBe('focused');
    expect(isViolation(site)).toBe(true);
  });
  it('ссылочная форма без вызова тоже сайт', () => {
    const [site] = scanSource('const t = ok ? it : it.skip;', 'a.test.ts');
    expect(site.cls).toBe('unconditional');
  });
  it('упоминания внутри комментариев и строк игнорируются', () => {
    expect(scanSource("// it.skip('x')\nconst s = \"describe.only(\";", 'a.test.ts')).toEqual([]);
  });
  it('номера строк считаются по исходнику, а не по очищенному тексту', () => {
    const src = "/* c\nc */\n\nit.skip('x', () => {});";
    expect(scanSource(src, 'a.test.ts')[0].line).toBe(4);
  });
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npx vitest run apps/backtester/test/skip-audit.test.ts`
Expected: FAIL — модуль `scripts/lib/skip-audit.js` не найден.

- [ ] **Step 3: Реализовать классификатор**

`blankNonCode(source)` заменяет содержимое комментариев и строковых литералов пробелами той же длины (переводы строк сохраняются) — номера строк и смещения остаются валидными. Прагмы собираются из СЫРОГО исходника до очистки: `Map<lineNumber, reason>` по регулярке `/^\s*\/\/\s*skip-audit:allow\s*[—:-]?\s*(.*)$/`.

Поиск сайтов по очищенному тексту: `/\b(describe|it|test)\.(skipIf|runIf|skip|only|todo)\b/g`. Если следующий непробельный символ — `(`, извлекаем аргумент балансировкой скобок (для `skipIf`/`runIf` это выражение гейта) из СЫРОГО исходника по тем же смещениям.

Классификация: `only` → `focused`; `skipIf`/`runIf` с извлечённым выражением → `gated` + `classifyGate`; `skip`/`todo` → `allowed` при прагме на предыдущей строке, иначе `unconditional`; `skipIf`/`runIf` без вызова → `gated` + `other`.

`classifyGate` проверяет по порядку: `DOCKER_AVAILABLE` → docker, `PG_AVAILABLE` → postgres, `.available` → store-factory, `existsSync` → fixture-file, `process.env` → env-opt-in, иначе other.

- [ ] **Step 4: Прогнать тесты**

Run: `npx vitest run apps/backtester/test/skip-audit.test.ts`
Expected: PASS (9 тестов).

- [ ] **Step 5: Коммит**

```bash
git add apps/backtester/scripts/lib/skip-audit.ts apps/backtester/test/skip-audit.test.ts
git commit -m "test(audit): классификатор skip-сайтов vitest (TQ-1)"
```

---

### Task 2: CLI аудита и репо-гейт

**Files:**
- Create: `apps/backtester/scripts/audit-test-skips.mts`
- Modify: `apps/backtester/test/skip-audit.test.ts` (добавить репо-гейт)
- Modify: `package.json` (скрипт `test:skips`)

**Interfaces:**
- Consumes: `scanSource`, `isViolation`, `SkipSite` из Task 1.
- Produces:
  ```ts
  export function collectTestFiles(roots: string[]): string[];       // scripts/lib/skip-audit.ts
  export function auditTree(repoRoot: string): SkipSite[];           // scripts/lib/skip-audit.ts
  export function formatMarkdown(sites: SkipSite[]): string;         // scripts/lib/skip-audit.ts
  ```

- [ ] **Step 1: Написать падающий тест репо-гейта**

```ts
import { resolve } from 'node:path';
import { auditTree, isViolation } from '../scripts/lib/skip-audit.js';

describe('репо-гейт: skip-поверхность backtester', () => {
  const REPO_ROOT = resolve(import.meta.dirname, '../../..');
  it('не содержит .only и безусловных .skip без прагмы', () => {
    const violations = auditTree(REPO_ROOT).filter(isViolation);
    expect(violations.map((v) => `${v.file}:${v.line} ${v.block}.${v.modifier}`)).toEqual([]);
  });
  it('находит непустую условную поверхность (сканер реально дошёл до файлов)', () => {
    expect(auditTree(REPO_ROOT).filter((s) => s.cls === 'gated').length).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: Прогнать — падает на реальных нарушениях**

Run: `npx vitest run apps/backtester/test/skip-audit.test.ts`
Expected: FAIL — в списке `test/long-oi-parity/signal-parity.test.ts` (безусловный `it.skip`) и `test/golden-sync.test.ts` (`it.skip` в тернарнике).

- [ ] **Step 3: Реализовать обход дерева и markdown-вывод**

`collectTestFiles` рекурсивно обходит `apps` и `packages` от корня репо, берёт `*.test.ts`, пропускает `node_modules`, `dist`, `.git`, `.worktrees`. `auditTree` читает каждый файл и зовёт `scanSource` с путём относительно корня. `formatMarkdown` печатает: сводку по классам, разбивку `gated` по видам гейта, таблицу нарушений (пустую — строкой «нарушений нет»), таблицу `allowed` с причинами.

CLI `audit-test-skips.mts`: аргументы `--json`, `--check`; корень репо — `resolve(dirname(fileURLToPath(import.meta.url)), '../../..')`; при `--check` и непустом списке нарушений печатает их и `process.exit(1)`.

- [ ] **Step 4: Привести существующую поверхность к канону**

В `apps/backtester/test/golden-sync.test.ts` заменить
`const crossRepo = platformReachable ? it : it.skip;` + `crossRepo('…')`
на `it.skipIf(!platformReachable)('…')` (тело теста не трогать).

В `apps/backtester/test/long-oi-parity/signal-parity.test.ts` строкой выше `it.skip(...)` добавить
`// skip-audit:allow — DEFERRED: ждёт фикса ctx.market на платформе; инфраструктура matchTrades сохраняется намеренно`.

- [ ] **Step 5: Прогнать тесты и CLI**

Run: `npx vitest run apps/backtester/test/skip-audit.test.ts && npx tsx apps/backtester/scripts/audit-test-skips.mts --check`
Expected: тесты PASS; CLI печатает таблицу и завершается кодом 0.

- [ ] **Step 6: Добавить npm-скрипт и закоммитить**

В `package.json` в `scripts`: `"test:skips": "tsx apps/backtester/scripts/audit-test-skips.mts"`.

```bash
git add -A && git commit -m "test(audit): CLI аудита skip-поверхности + репо-гейт (TQ-1)"
```

---

### Task 3: Отчёт и двойное отражение

**Files:**
- Create: `docs/reports/2026-07-24-test-skip-audit.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Сгенерировать отчёт**

Run: `npx tsx apps/backtester/scripts/audit-test-skips.mts > docs/reports/2026-07-24-test-skip-audit.md`
Затем дописать шапку: дата, команда воспроизведения, ссылка на карточку `test-quality-hardening`, вывод по TQ-1 (какая доля skip — условная, где ad-hoc-гейты, что зафиксировано гейтом).

- [ ] **Step 2: Внести запись в `docs/ROADMAP.md`**

В раздел «Code Health & Audits» — абзац с датой, числами аудита, командой `pnpm test:skips` и ссылкой на отчёт и карточку.

- [ ] **Step 3: Полный прогон и коммит**

Run: `pnpm typecheck && pnpm test`
Expected: зелёно.

```bash
git add -A && git commit -m "docs: отчёт skip-аудита + ROADMAP (TQ-1)"
```

---

## Self-Review

- Спека §1 (скрипт) → Task 1 + Task 2; §2 (прагма) → Task 1 Step 3; §3 (гейт в `pnpm test`) → Task 2 Step 1; §4 (приведение поверхности) → Task 2 Step 4; критерии готовности 1–3 → Task 2 Step 5 / Task 3 Step 3; критерий 4 (карточка) → отдельный PR в control-center, вне этого плана.
- Плейсхолдеров нет: все имена функций, пути и команды указаны буквально.
- Имена согласованы: `scanSource`/`classifyGate`/`isViolation`/`auditTree`/`collectTestFiles`/`formatMarkdown` используются одинаково во всех задачах.
