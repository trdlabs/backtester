# Reference-backtest bench harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переиспользуемый станок, который прогоняет один референс-бэктест под матрицей флагов перф-трио и печатает таблицу «byte-identity + тайминги + IPC».

**Architecture:** Чистая часть (матрица вариантов, агрегация повторов, парсер `ipc_profile`, вердикт byte-identity, markdown) живёт в `scripts/lib/bench-reference.ts` и покрыта юнит-тестами. Тонкий `.mts`-скрипт выставляет `BACKTESTER_IPC_PROFILE=true` до динамического импорта движка, гоняет `runBacktest` с sandbox-деками на фикстуре Docker-golden-гейта и печатает отчёт.

**Tech Stack:** TypeScript, tsx, vitest, Docker (реальный sandbox-контейнер).

## Global Constraints

- Спека: `docs/superpowers/specs/2026-07-24-reference-bench-harness-design.md`.
- Варианты ровно четыре: `off`, `bar_batching`, `bar_major`, `bar_major_batch` (`barBatching` и `barMajor` взаимоисключимы — комбинации не существует).
- Флаги передаются как deps в `runBacktest`, а НЕ через env — как в `test/bar-major-batch-golden.test.ts`.
- Дефолты по умолчанию не меняются: харнесс ничего не включает в проде, только измеряет.
- Docker-прогон не ассертится в CI (как `bench-workers.mts`); в CI едут только юниты чистых частей.

---

### Task 1: Чистая часть харнесса

**Files:**
- Create: `apps/backtester/scripts/lib/bench-reference.ts`
- Test: `apps/backtester/test/bench-reference-harness.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type VariantName = 'off' | 'bar_batching' | 'bar_major' | 'bar_major_batch';
  export interface VariantFlags { barBatching: boolean; barMajor: boolean; barMajorBatch: boolean }
  export const VARIANTS: Record<VariantName, VariantFlags>;
  export function parseVariants(spec: string | undefined): VariantName[];
  export interface IpcProfile { hookCalls: number; symbolInits: number; barMajorBatches: number; ipcWaitMs: number; openMs: number }
  export function parseIpcProfileLine(line: string): IpcProfile | undefined;
  export function sumIpcProfiles(profiles: IpcProfile[]): IpcProfile;
  export interface RepeatSample { wallMs: number; resultHash: string; ipc: IpcProfile }
  export interface VariantResult { variant: VariantName; samples: RepeatSample[] }
  export function median(xs: number[]): number;
  export interface IdentityVerdict { pass: boolean; baselineHash: string; mismatches: { variant: VariantName; hash: string }[] }
  export function identityVerdict(results: VariantResult[]): IdentityVerdict;
  export function formatBenchMarkdown(results: VariantResult[], meta: BenchMeta): string;
  export interface BenchMeta { request: string; bundle: string; symbols: number; repeats: number; host: string }
  ```

- [ ] **Step 1: Написать падающие юнит-тесты**

```ts
import { describe, expect, it } from 'vitest';
import {
  VARIANTS, parseVariants, parseIpcProfileLine, sumIpcProfiles, median, identityVerdict, formatBenchMarkdown,
} from '../scripts/lib/bench-reference.js';

const ipc = (o = {}) => ({ hookCalls: 0, symbolInits: 0, barMajorBatches: 0, ipcWaitMs: 0, openMs: 0, ...o });
const sample = (wallMs: number, resultHash: string) => ({ wallMs, resultHash, ipc: ipc() });

describe('parseVariants', () => {
  it('по умолчанию — все четыре варианта, baseline первым', () => {
    expect(parseVariants(undefined)).toEqual(['off', 'bar_batching', 'bar_major', 'bar_major_batch']);
  });
  it('разбирает список через запятую и всегда ставит off первым', () => {
    expect(parseVariants('bar_major,off')).toEqual(['off', 'bar_major']);
  });
  it('падает на неизвестном имени с внятным сообщением', () => {
    expect(() => parseVariants('turbo')).toThrow(/неизвестный вариант: turbo/);
  });
});

describe('VARIANTS', () => {
  it('взаимоисключимость barBatching и barMajor соблюдена во всех вариантах', () => {
    for (const v of Object.values(VARIANTS)) expect(v.barBatching && v.barMajor).toBe(false);
    expect(VARIANTS.bar_major_batch).toEqual({ barBatching: false, barMajor: true, barMajorBatch: true });
  });
});

describe('parseIpcProfileLine', () => {
  it('разбирает строку профиля сессии', () => {
    const line = JSON.stringify({ evt: 'ipc_profile', kind: 'strategy', symbol: 'BTCUSDT', hookCalls: 10, symbolInits: 1, barMajorBatches: 4, ipcWaitMs: 250, openMs: 900 });
    expect(parseIpcProfileLine(line)).toEqual(ipc({ hookCalls: 10, symbolInits: 1, barMajorBatches: 4, ipcWaitMs: 250, openMs: 900 }));
  });
  it('игнорирует посторонние строки и не-JSON', () => {
    expect(parseIpcProfileLine('[config] что-то')).toBeUndefined();
    expect(parseIpcProfileLine(JSON.stringify({ evt: 'other' }))).toBeUndefined();
  });
});

describe('sumIpcProfiles / median', () => {
  it('складывает профили по всем сессиям', () => {
    expect(sumIpcProfiles([ipc({ hookCalls: 3, ipcWaitMs: 10 }), ipc({ hookCalls: 4, ipcWaitMs: 5 })]))
      .toEqual(ipc({ hookCalls: 7, ipcWaitMs: 15 }));
  });
  it('медиана нечётной и чётной выборки', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('identityVerdict', () => {
  it('PASS, когда все варианты повторили хэш baseline', () => {
    const v = identityVerdict([
      { variant: 'off', samples: [sample(100, 'h1'), sample(110, 'h1')] },
      { variant: 'bar_major', samples: [sample(80, 'h1')] },
    ]);
    expect(v).toEqual({ pass: true, baselineHash: 'h1', mismatches: [] });
  });
  it('FAIL с перечислением расхождений', () => {
    const v = identityVerdict([
      { variant: 'off', samples: [sample(100, 'h1')] },
      { variant: 'bar_major', samples: [sample(80, 'h2')] },
    ]);
    expect(v.pass).toBe(false);
    expect(v.mismatches).toEqual([{ variant: 'bar_major', hash: 'h2' }]);
  });
  it('нестабильный baseline между повторами — тоже FAIL', () => {
    const v = identityVerdict([{ variant: 'off', samples: [sample(100, 'h1'), sample(100, 'hX')] }]);
    expect(v.pass).toBe(false);
    expect(v.mismatches).toEqual([{ variant: 'off', hash: 'hX' }]);
  });
  it('требует наличия baseline-варианта', () => {
    expect(() => identityVerdict([{ variant: 'bar_major', samples: [sample(80, 'h1')] }]))
      .toThrow(/baseline/);
  });
});

describe('formatBenchMarkdown', () => {
  it('печатает speedup к baseline и вердикт', () => {
    const md = formatBenchMarkdown(
      [
        { variant: 'off', samples: [sample(200, 'h1')] },
        { variant: 'bar_major_batch', samples: [sample(100, 'h1')] },
      ],
      { request: 'universe-multi.json', bundle: 'short-after-pump.bundle.json', symbols: 3, repeats: 1, host: 'wsl2 4 cores' },
    );
    expect(md).toContain('2.00×');
    expect(md).toContain('byte-identity: PASS');
  });
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npx vitest run apps/backtester/test/bench-reference-harness.test.ts`
Expected: FAIL — модуль `scripts/lib/bench-reference.js` не найден.

- [ ] **Step 3: Реализовать чистую часть**

`VARIANTS` — литерал из четырёх записей. `parseVariants` разбирает CSV, валидирует имена, дедуплицирует, гарантирует `off` первым (baseline нужен для сравнения). `parseIpcProfileLine` — `JSON.parse` в try/catch, отбор по `evt === 'ipc_profile'`, приведение пяти числовых полей. `sumIpcProfiles` — поэлементная сумма. `median` — сортировка копии, среднее двух центральных для чётной длины. `identityVerdict` — берёт хэш первого сэмпла baseline, сверяет с ним КАЖДЫЙ сэмпл каждого варианта (включая сам baseline: нестабильность между повторами — тоже расхождение), бросает при отсутствии `off`. `formatBenchMarkdown` — таблица «вариант / повторов / min ms / median ms / speedup / hash == baseline / hookCalls / barMajorBatches / ipcWaitMs / openMs» плюс строка вердикта `byte-identity: PASS|FAIL` и блок метаданных прогона.

- [ ] **Step 4: Прогнать тесты**

Run: `npx vitest run apps/backtester/test/bench-reference-harness.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add apps/backtester/scripts/lib/bench-reference.ts apps/backtester/test/bench-reference-harness.test.ts
git commit -m "bench: чистая часть харнесса референс-бэктеста (dark-flag item 3)"
```

---

### Task 2: CLI-прогон референс-бэктеста

**Files:**
- Create: `apps/backtester/scripts/bench-reference-backtest.mts`
- Modify: `package.json` (скрипт `bench:reference`)

**Interfaces:**
- Consumes: всё из Task 1.
- Внешние точки (существующие, менять их нельзя): `runBacktest` из `src/engine/runner.js`; `buildOverlayDataset` из `src/engine/data-adapter.js`; `buildTrustedRegistry` / `createTrustedRouter`; `FixtureDataPort` из `src/data/reader.js`; `buildSandboxStrategyBaselineDeps` и `materializeReadableBundle` из `test/helpers-overlay-sandbox.js`; `FIXTURES_DIR` из `test/helpers.js`.

- [ ] **Step 1: Написать скрипт**

Порядок важен: `process.env.BACKTESTER_IPC_PROFILE = 'true'` выставляется ДО `await import(...)` движка — `SandboxSession.profileEnabled` читается в статическом поле при загрузке модуля.

Сбор профиля: на время прогона подменяется `console.error`, строки прогоняются через `parseIpcProfileLine`, распознанные копятся, остальные пробрасываются в оригинальный `console.error`. Подмена снимается в `finally`.

Один повтор варианта: материализовать бандл (`materializeReadableBundle`), построить `marketTape` один раз на весь прогон (данные не зависят от флагов), затем на каждый повтор — `buildSandboxStrategyBaselineDeps` → `runBacktest(request, { registry, router, marketTape, ...VARIANTS[variant] })` → проверить `router.errors()` пустым (иначе бросить: замер по сломанному прогону бессмыслен) → `resultHash(out)` → `router.closeAll()` (именно после close сессии печатают `ipc_profile`).

Env-параметры: `BENCH_VARIANTS`, `BENCH_REPEATS` (по умолчанию 3), `BENCH_REQUEST` (по умолчанию `test/fixtures/overlay/requests/universe-multi.json`), `BENCH_BUNDLE` (по умолчанию `test/fixtures/overlay/bundles/short-after-pump.bundle.json`). Аргумент `--json <path>` дополнительно пишет сырые сэмплы.

Хэш результата считается тем же способом, что в golden-тестах (`resultHash` из `test/helpers/bar-major-fixture.js`), чтобы цифра была сопоставима с зафиксированными golden.

- [ ] **Step 2: Прогнать матрицу с одним повтором (дым)**

Run: `BENCH_REPEATS=1 npx tsx apps/backtester/scripts/bench-reference-backtest.mts`
Expected: четыре строки таблицы, `byte-identity: PASS`, ненулевые `hookCalls`.

- [ ] **Step 3: Добавить npm-скрипт**

В `package.json`: `"bench:reference": "tsx apps/backtester/scripts/bench-reference-backtest.mts"`.

- [ ] **Step 4: Коммит**

```bash
git add -A && git commit -m "bench: CLI референс-бэктеста под матрицей флагов перф-трио"
```

---

### Task 3: Замер, отчёт, двойное отражение

**Files:**
- Create: `docs/reports/2026-07-24-bar-batching-bench.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Полный прогон**

Run: `BENCH_REPEATS=3 npx tsx apps/backtester/scripts/bench-reference-backtest.mts --json /tmp/bench.json`
Expected: таблица с четырьмя вариантами; вердикт byte-identity.

- [ ] **Step 2: Написать отчёт**

`docs/reports/2026-07-24-bar-batching-bench.md`: команда воспроизведения, стенд (WSL2, 4 ядра — цифры сравнимы между вариантами, не абсолютная capacity), фикстура, таблица, вердикт byte-identity, вывод по каждому флагу и явная пометка, что дефолты не менялись и решение о включении — за владельцем (шаг 4 rollout-таблицы карточки).

**Если byte-identity FAIL — остановиться и вынести блок «ВОПРОС ВЛАДЕЛЬЦУ»**: расхождение хэша означает, что «прозрачный транспортный флаг» меняет результат, и это не правится подгонкой ожидания.

- [ ] **Step 3: Внести запись в `docs/ROADMAP.md`**

В «Code Health & Audits» — абзац с датой, командой `pnpm bench:reference`, таблицей-выжимкой и ссылками на отчёт и карточку `dark-flag-validation`.

- [ ] **Step 4: Полный прогон тестов и коммит**

Run: `pnpm typecheck && pnpm test`
Expected: зелёно.

```bash
git add -A && git commit -m "docs: замер bar-batching трио + ROADMAP (dark-flag item 3)"
```

---

## Self-Review

- Спека §«Референс-прогон» → Task 2 Step 1; §«Матрица вариантов» → Task 1 (VARIANTS/parseVariants); §«Измеряется» → Task 1 (IpcProfile/median) + Task 2 Step 1 (сбор); §«Вывод» → Task 1 (`formatBenchMarkdown`) + Task 2 (`--json`); §«Вердикт byte-identity» → Task 1 (`identityVerdict`) + Task 3 Step 2 (эскалация); §«Тесты» → Task 1; критерии готовности 1–3 → Task 2 Step 2 / Task 3 Step 1 / Task 3 Step 4; критерий 4 (карточка) → PR в control-center, вне этого плана.
- Плейсхолдеров нет.
- Имена согласованы с Task 1 во всех последующих задачах (`VARIANTS`, `parseVariants`, `identityVerdict`, `formatBenchMarkdown`, `parseIpcProfileLine`, `sumIpcProfiles`, `median`).
