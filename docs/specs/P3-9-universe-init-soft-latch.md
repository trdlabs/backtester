# P3-9 — init-сбой универс-сессии: soft-latch одного символа

## Проблема

В universe-режиме ОДИН контейнер обслуживает N символов. Per-hook сбой уже различает два класса
(sandbox-session.ts `callHook`):
- harness `err` (стратегия бросила, harness поймал, **контейнер жив**) → soft-latch: `failedSymbols.set`,
  только этот символ fail-closed на остаток баров, остальные работают;
- channel death (`eof`/`timeout`/`overflow`/`malformed`) → `fail()` session-fatal (контейнер убит).

Но `ensureSymbolInit` (L210) эскалирует **любой** non-ok init-исход в `fail()`:

```ts
if (outcome.kind !== 'ok') return this.fail(this.mapFailure(outcome, 'init', 'bundle_load_failed'));
```

Значит harness `err` на per-symbol init одного символа (напр. его per-symbol setup бросил, контейнер жив)
**рушит общий контейнер и все остальные символы** — асимметрия с per-hook путём. (Non-universe init,
`openInner` L176, остаётся `fail()` — там один символ = один контейнер, эскалация корректна.)

## Инварианты (закреплены заказчиком)

1. **Изоляция одного символа** — init-сбой (harness `err`) латчит только проблемный символ, общий
   контейнер жив, остальные символы исполняются.
2. **Не повторяется на каждом баре** — латч в `failedSymbols` перехватывается на входе (`callHook` L288,
   `callHookBarMajor` L508) → повторный init/hook для латченного символа не отправляется.
3. **Не сдвигает bar-major alignment** — init-латченный символ выпадает из `bars` (как pre-latched в
   `callHookBarMajor`), его результат резолвится локально из латча по исходному idx; здоровые символы
   идут в том же относительном порядке, маппинг `out[h.idx]` сохраняет позиции.
4. **Channel death в init остаётся session-fatal** — `eof`/`timeout`/`overflow`/`malformed` на init
   означают смерть общего контейнера → `fail()`, все символы fail-closed (без изменений).

## Изменения

### 1. `ensureSymbolInit` — split по классу сбоя (зеркало `callHook`)

```ts
if (outcome.kind !== 'ok') {
  const error = this.mapFailure(outcome, 'init', 'bundle_load_failed');
  if (outcome.kind === 'err') {
    // per-symbol init soft failure: harness caught an exception in THIS symbol's init; container alive.
    this.failedSymbols.set(ctx.symbol, error);
    return { ok: false, decisions: [], error };
  }
  return this.fail(error); // channel death → session-fatal
}
```

(`ensureSymbolInit` вызывается только в universe — guard L190 — так что доп. проверки режима не нужно.)

Это автоматически чинит `callHook` (L296-297: возвращает per-symbol fail, сессия жива) и `callHookBatch`
(L406-407: батч single-symbol, soft-latch этого символа, сессия жива) — оба уже интерпретируют возврат
`ensureSymbolInit` как per-symbol результат.

### 2. `callHookBarMajor` — выронить init-латченный символ из батча

Текущий цикл (L522-526) валит весь батч при любом init-сбое. Новый: init-латченный символ дропается
(как pre-latched), channel death → session-fatal.

```ts
const sendable: { ctx: StrategyContext; idx: number }[] = [];
for (const h of healthy) {
  const f = await this.ensureSymbolInit(h.ctx);
  if (f === undefined) { sendable.push(h); continue; }
  if (this.failed) return failHealthy(this.lastError); // channel death in init → session-fatal
  out[h.idx] = { ok: false, decisions: [], error: f.error }; // soft-latched on init → drop from batch
}
if (sendable.length === 0) return out; // every remaining symbol latched on init → no IPC send
```

Далее `bars`/results/`profHookCalls` итерируют `sendable` вместо `healthy`.

## Таксономия / байт-идентичность

- Init-латч даёт тот же `HookResult { ok:false, decisions:[], error }`, что и per-hook латч — executor
  aggregation (equal-weight) обрабатывает его идентично (латченный символ = fail-closed запись).
- Ни один success-путь не меняется → все goldens byte-identical. Изменение затрагивает только ветку
  init-`err` (ранее падавшую в session-fatal).

## Тесты (TDD)

Unit (`sandbox-session-universe.test.ts`, ScriptedDriver + `writeErr` для init без seq):
1. **init `err` для AAA латчит только AAA** — `callHook`(AAA)→init `err`; контейнер жив (`disposeCount 0`),
   BBB init+hook → ok. (RED: pre-fix `fail()` → dispose, BBB падает.)
2. **init-латч не повторяет init** — после init `err`(AAA) следующий `callHook`(AAA, bar1) fail-closed
   немедленно, ни одного нового envelope (`sent` стабилен).
3. **channel death в init session-fatal** — `stdout.end()` на init(AAA) → `disposeCount 1`, BBB fail-closed.

Unit (`sandbox-session-bar-major.test.ts`):
4. **bar-major alignment** — `callHookBarMajor([AAA, BBB])`, init(AAA)→`err`, init(BBB)→ok, затем ОДИН
   `hookBarMajor` только с BBB (`bars` length 1); `results[0]` (AAA) fail-closed из латча, `results[1]`
   (BBB) ok; контейнер жив.

Integration (Docker):
5. **N=2/3/64 byte-identical** — существующие equivalence/universe Docker-прогоны зелёные.
6. **один неисправный символ** — Docker universe-прогон с одним bundle-символом, чей init бросает →
   этот символ fail-closed, остальные N-1 завершаются нормально (если покрываемо существующим harness'ем;
   иначе unit №1/№4 закрывают семантику, а Docker подтверждает byte-identical здорового пути).

## Побочно (неблокирующее замечание по #127)

`async-ipc-channel.ts` stderr удерживает **первые** `maxStderrBytes` (prefix/head), но комментарии
называют его «tail». Терминологический тидап (комментарии → «head»/«prefix»), поведение не меняется.
