// POC (analysis/18 вариант A) — in-isolate харнесс для isolated-vm бэкенда sandbox.
//
// Зеркало entry.mjs handleHook МИНУС stdio/deny-shims: в V8-изоляте нет ambient authority
// (process/require/сеть отсутствуют по построению), NDJSON-канал заменён прямым вызовом
// evalClosure → __isolateHarness.hook(json). Контракт сообщений тот же, что у docker-харнесса
// ({hook, snapshot, newBar, newOi, newLiq} → {ok, decisions} | {ok:false, code, detail}),
// поэтому host-side bookkeeping (newBar на переходе бара) переносится без изменений.
//
// КАНОН ПАРНОСТИ: rehydrateContext + createSeededRng + _engine — ТОТ ЖЕ код, что в docker-харнессе
// (rehydrate.mjs импортирует './_engine/engine.js'); esbuild собирает всё это в один IIFE
// (scripts/build-isolate-harness.mjs) → индикаторы/rng/deep-freeze байт-в-байт с docker-путём.
//
// Бандл грузится host-side через isolate.compileModule (V8 ESM) и кладётся в
// globalThis.__bundleModule (namespace) — resolveInstance() здесь разрешает factory/object
// default-export по тому же канону, что docker entry.mjs.

import { createSeededRng, rehydrateContext } from './rehydrate.mjs';
import { makeInstanceStore, resolveInstance } from './universe-instances.mjs';
import { runHookBatchSync } from './hook-batch.mjs';
import { createPersistentContext } from './persistent-context.mjs';

const store = makeInstanceStore();
// Диагностические счётчики протокола (batch-однозаходность наблюдаема тестами через stats()).
const stats = { hookCalls: 0, batchCalls: 0, batchBarsReceived: 0 };

/**
 * СПАЙК S0 — режим протокола, объявленный хостом при `initSymbol`. НЕ МЕРЖИТСЯ.
 *
 * `undefined` — ещё не объявлен; `false` — снимок на событие (легаси); `true` — дельта поверх
 * персистентной поверхности (`PROFILE_SNAPSHOT_FREE=true` на хосте).
 *
 * Флаг ОДИН на обе половины: рассогласование хоста и харнесса обязано падать явно, а не считаться —
 * иначе замер выглядел бы исправным, меряя не ту конструкцию. Поэтому смена режима внутри сессии и
 * форма сообщения, не совпавшая с объявленной, роняют вызов (`sandbox_output_malformed`).
 */
let deltaMode;

/** Верно зеркалит entry.mjs normalize: null/undefined → [], скаляр → [x]. */
function normalize(out) {
  if (out === null || out === undefined) return [];
  return Array.isArray(out) ? out : [out];
}

/** Зеркало entry.mjs pickHookFor (те же имена lifecycle-хуков). */
function pickHookFor(instance, hook) {
  if (instance === undefined || instance === null) return undefined;
  switch (hook) {
    case 'init':
      return typeof instance.init === 'function' ? instance.init : undefined;
    case 'onBarClose':
      return typeof instance.onBarClose === 'function' ? instance.onBarClose : undefined;
    case 'onPositionBar':
      return typeof instance.onPositionBar === 'function' ? instance.onPositionBar : undefined;
    case 'onPendingIntentBar':
      return typeof instance.onPendingIntentBar === 'function' ? instance.onPendingIntentBar : undefined;
    case 'dispose':
      return typeof instance.dispose === 'function' ? instance.dispose : undefined;
    case 'apply':
      return typeof instance.apply === 'function' ? instance.apply : undefined;
    default:
      return undefined;
  }
}

/** Обернуть хук sync-гардом: thenable-результат → throw (fail-closed вместо зависания await). */
function syncOnly(fn) {
  if (fn === undefined) return undefined;
  return function wrapped(ctx) {
    const out = fn.call(this, ctx);
    if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
      throw new Error('async hooks are not supported by the isolate backend (POC)');
    }
    return out;
  };
}

function fail(code, detail) {
  return JSON.stringify({ ok: false, code, detail: String(detail ?? '').slice(0, 4096) });
}

// ── СПАЙК S0: дельта-протокол (`PROFILE_SNAPSHOT_FREE=true`). НЕ МЕРЖИТСЯ. ────────────────────────
//
// Форма события (всё, кроме `h`, опционально; отсутствие ключа = «не менялось»):
//   h  — имя lifecycle-хука
//   c  — clockNow (sim-clock)
//   s  — символ; едет ТОЛЬКО при смене активного слота (POC non-universe: один раз)
//   b  — [ts, open, high, low, close, volume] закрытой свечи t; есть ⇔ переход бара
//   o  — [ts, oiTotalUsd] | null(gap); ключ есть ⇔ лента несёт OI (только вместе с `b`)
//   l  — [ts, longUsd, shortUsd] | null(gap); то же для ликвидаций
//   p  — [side, size, entryPrice, stop|null, take|null] | null — позиция, когда ИЗМЕНИЛАСЬ
//   i  — [kind, side|null, createdTs] | null — pendingIntent, когда ИЗМЕНИЛСЯ
//   f  — [equity, openPositions] — портфель, когда ИЗМЕНИЛСЯ
//
// `run`/`params`/`symbol` не едут вовсе — они приехали один раз при `initSymbol`.
let activeSymbol;
let activeSlot;

function hookDelta(msg) {
  if (msg.s !== undefined) {
    activeSymbol = msg.s;
    activeSlot = store.get(activeSymbol);
  }
  const slot = activeSlot;
  if (slot === undefined || slot.surface === undefined) {
    return fail('sandbox_output_malformed', `hook before init for symbol ${String(activeSymbol)}`);
  }
  const sf = slot.surface;
  try {
    if (msg.b !== undefined) {
      const a = msg.b;
      const bar = Object.freeze({ ts: a[0], open: a[1], high: a[2], low: a[3], close: a[4], volume: a[5] });
      slot.buffer.push(bar);
      // Индекс-выравнивание с буфером свечей — как в легаси: oi/liq пушатся ТОЛЬКО на переходе бара.
      if (msg.o !== undefined) slot.oiBuffer.push(msg.o === null ? null : { ts: msg.o[0], oiTotalUsd: msg.o[1] });
      if (msg.l !== undefined) slot.liqBuffer.push(msg.l === null ? null : { ts: msg.l[0], longUsd: msg.l[1], shortUsd: msg.l[2] });
      sf.onNewBar(bar);
    }
    sf.setClock(msg.c);
    if (msg.p !== undefined) sf.setPosition(msg.p);
    if (msg.i !== undefined) sf.setPendingIntent(msg.i);
    if (msg.f !== undefined) sf.setPortfolio(msg.f);
    const fn = pickHookFor(slot.instance, msg.h);
    if (fn === undefined) return JSON.stringify({ ok: true, decisions: [] });
    const out = fn.call(slot.instance, sf.ctx);
    if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
      return fail('sandbox_crashed', 'async hooks are not supported by the isolate backend (POC)');
    }
    if (msg.h === 'init' || msg.h === 'dispose') return JSON.stringify({ ok: true, decisions: [] });
    return JSON.stringify({ ok: true, decisions: normalize(out) });
  } catch (e) {
    return fail('sandbox_crashed', e && e.message ? e.message : e);
  }
}

globalThis.__isolateHarness = {
  /**
   * Инициализировать per-symbol slot: resolveInstance(__bundleModule) + session-seeded rng.
   * Возвращает JSON {ok:true} | {ok:false, code:'bundle_load_failed', detail}.
   */
  initSymbol(symbol, seed, initJson) {
    try {
      // СПАЙК S0: третий аргумент = хост объявил дельта-протокол и прислал инварианты сессии
      // (`run`/`params`/`symbol`), которые раньше ехали в КАЖДОМ снимке.
      const wantDelta = typeof initJson === 'string';
      if (deltaMode !== undefined && deltaMode !== wantDelta) {
        return fail(
          'sandbox_output_malformed',
          `PROFILE_SNAPSHOT_FREE mismatch: харнесс уже инициализирован в режиме ${deltaMode ? 'дельты' : 'снимка'}`,
        );
      }
      deltaMode = wantDelta;
      const loaded = globalThis.__bundleModule;
      if (loaded === undefined || loaded === null) {
        return fail('bundle_load_failed', 'bundle module is not loaded into the isolate');
      }
      // Ревью I1: non-function default export = ОБЩИЙ объект. На per-symbol docker-контейнерах
      // каждый символ получает СВОЮ копию; в одном изоляте общий объект тёк бы this-state'ом
      // между символами (тот же хазард, из-за которого universe-режим fail-closed). Поэтому
      // второй символ при не-фабричном default — fail-fast.
      if (typeof (loaded && loaded.default) !== 'function' && store.get(symbol) === undefined) {
        let occupied = false;
        for (const _ of store.all()) { occupied = true; break; }
        if (occupied) {
          return fail(
            'bundle_load_failed',
            'non-factory default export cannot serve a second symbol in one isolate (shared-instance hazard)',
          );
        }
      }
      const resolved = resolveInstance(loaded, { universe: false });
      if (resolved.ok === false) return fail(resolved.code, resolved.reason);
      if (resolved.instance === undefined || resolved.instance === null) {
        return fail('bundle_load_failed', 'entry produced no module instance');
      }
      const slot = store.ensure(symbol, () => ({
        instance: resolved.instance,
        rng: createSeededRng(typeof seed === 'number' ? seed : 0),
      }));
      if (wantDelta && slot.surface === undefined) {
        const init = JSON.parse(initJson);
        if (init === null || typeof init !== 'object' || init.run === null || typeof init.run !== 'object') {
          return fail('sandbox_output_malformed', 'delta init payload must carry {run, params}');
        }
        slot.surface = createPersistentContext({ run: init.run, params: init.params, symbol }, slot);
      }
      return JSON.stringify({ ok: true });
    } catch (e) {
      return fail('bundle_load_failed', e && e.message ? e.message : e);
    }
  },

  /** Диагностика протокола: счётчики вызовов + длина свечного буфера (единственного slot'а POC). */
  stats() {
    let bufferLen = 0;
    for (const slot of store.all()) bufferLen = Math.max(bufferLen, slot.buffer.length);
    return JSON.stringify({ hookCalls: stats.hookCalls, batchCalls: stats.batchCalls, batchBarsReceived: stats.batchBarsReceived, bufferLen });
  },

  /**
   * 17b-батч ОДНИМ заходом: {hook, bars:[{snapshot,newBar,newOi,newLiq}]} → runHookBatchSync
   * (sync-двойник docker-хелпера; отличие — канонические idle не рвут батч) → {ok:true, stoppedAt, decisions} | {ok:false, barOffset,
   * code, detail}. СИНХРОННО (runHookBatchSync): await внутри изолята гонял бы promise-машинерию
   * isolated-vm через host event loop (~мс/бар, замерено); thenable-результат хука отвергается
   * syncOnly-гардом.
   */
  hookBatch(msgJson) {
    stats.batchCalls += 1;
    // СПАЙК S0: батч 17b работает по снимкам (`runHookBatchSync` зовёт `rehydrateContext`) и в
    // объём спайка не входит. Молча посчитать его дельта-режимом нельзя — это дало бы число не той
    // конструкции; поэтому явный отказ.
    if (deltaMode === true) {
      return fail('sandbox_output_malformed', 'hookBatch не поддержан под PROFILE_SNAPSHOT_FREE (спайк): гоняйте с PROFILE_BATCH_BARS=0');
    }
    let msg;
    try {
      msg = JSON.parse(msgJson);
    } catch {
      return fail('sandbox_output_malformed', 'batch request is not valid JSON');
    }
    if (Array.isArray(msg.bars)) stats.batchBarsReceived += msg.bars.length;
    const first = Array.isArray(msg.bars) ? msg.bars[0] : undefined;
    const symbol = first && first.snapshot ? first.snapshot.symbol : undefined;
    const slot = typeof symbol === 'string' ? store.get(symbol) : undefined;
    if (slot === undefined) {
      return fail('sandbox_output_malformed', `hookBatch before init for symbol ${String(symbol)}`);
    }
    const r = runHookBatchSync(msg.bars, msg.hook, {
      buffer: slot.buffer,
      oiBuffer: slot.oiBuffer,
      liqBuffer: slot.liqBuffer,
      rng: slot.rng,
      instance: slot.instance,
      rehydrateContext,
      pickHook: (h) => syncOnly(pickHookFor(slot.instance, h)),
      normalize,
    });
    if (r.kind === 'ok') return JSON.stringify({ ok: true, stoppedAt: r.stoppedAt, decisions: r.decisions });
    const cause = r.cause;
    return JSON.stringify({
      ok: false,
      barOffset: r.barOffset,
      code: 'sandbox_crashed',
      detail: String(cause && cause.message ? cause.message : cause).slice(0, 4096),
    });
  },

  /**
   * Исполнить lifecycle-хук: {hook, snapshot, newBar, newOi, newLiq} (JSON) →
   * {ok:true, decisions} | {ok:false, code, detail} (JSON). Семантика буферов — точное зеркало
   * entry.mjs handleHook: push ДО rehydrate, void-хуки (init/dispose) → [].
   */
  hook(msgJson) {
    stats.hookCalls += 1;
    let msg;
    try {
      msg = JSON.parse(msgJson);
    } catch {
      return fail('sandbox_output_malformed', 'request is not valid JSON');
    }
    // СПАЙК S0: форма сообщения обязана совпасть с объявленной при `initSymbol`. Дельта несёт `h`
    // и НЕ несёт `snapshot`; легаси — наоборот. Несовпадение = флаг доехал только до одной половины.
    if (deltaMode === true) {
      if (msg.snapshot !== undefined || typeof msg.h !== 'string') {
        return fail('sandbox_output_malformed', 'дельта-харнесс получил сообщение формы снимка (PROFILE_SNAPSHOT_FREE только на одной половине)');
      }
      return hookDelta(msg);
    }
    if (msg.h !== undefined) {
      return fail('sandbox_output_malformed', 'снимочный харнесс получил сообщение формы дельты (PROFILE_SNAPSHOT_FREE только на одной половине)');
    }
    const { hook, snapshot, newBar, newOi, newLiq } = msg;
    const symbol = snapshot === undefined || snapshot === null ? undefined : snapshot.symbol;
    const slot = typeof symbol === 'string' ? store.get(symbol) : undefined;
    if (slot === undefined) {
      return fail('sandbox_output_malformed', `hook before init for symbol ${String(symbol)}`);
    }
    try {
      if (newBar !== null && newBar !== undefined) slot.buffer.push(newBar);
      if (newOi !== undefined) slot.oiBuffer.push(newOi);
      if (newLiq !== undefined) slot.liqBuffer.push(newLiq);
      const ctx = rehydrateContext(snapshot, slot.buffer, slot.rng, slot.oiBuffer, slot.liqBuffer);
      const fn = pickHookFor(slot.instance, hook);
      if (fn === undefined) return JSON.stringify({ ok: true, decisions: [] });
      const out = fn.call(slot.instance, ctx);
      // Изолят исполняет хуки СИНХРОННО (evalClosure + нативный timeout); промис не может быть
      // дождан внутри одного sync-вызова → fail-closed с внятной диагностикой (POC-ограничение).
      if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
        return fail('sandbox_crashed', 'async hooks are not supported by the isolate backend (POC)');
      }
      if (hook === 'init' || hook === 'dispose') return JSON.stringify({ ok: true, decisions: [] });
      return JSON.stringify({ ok: true, decisions: normalize(out) });
    } catch (e) {
      return fail('sandbox_crashed', e && e.message ? e.message : e);
    }
  },
};
