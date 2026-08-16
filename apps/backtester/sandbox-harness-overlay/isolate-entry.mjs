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
import { createActorSlot, deliverActorEvent, makeActorStore } from './actor-harness.mjs';

const store = makeInstanceStore();
// 083 S3 — акторы живут в СВОЕЙ таблице, а не в per-symbol слотах legacy-хуков. Слот там несёт
// свечной буфер, rng сессии и один экземпляр на символ; у актора нет ни буфера (ему доставляют
// событие целиком), ни привязки «один на символ» (их создаёт и освобождает хост поимённо).
// Общая таблица заставила бы каждую из двух форм жизни таскать поля другой.
const actors = makeActorStore();
// Диагностические счётчики протокола (batch-однозаходность наблюдаема тестами через stats()).
const stats = { hookCalls: 0, batchCalls: 0, batchBarsReceived: 0 };

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

globalThis.__isolateHarness = {
  /**
   * Инициализировать per-symbol slot: resolveInstance(__bundleModule) + session-seeded rng.
   * Возвращает JSON {ok:true} | {ok:false, code:'bundle_load_failed', detail}.
   */
  initSymbol(symbol, seed) {
    try {
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
      store.ensure(symbol, () => ({
        instance: resolved.instance,
        rng: createSeededRng(typeof seed === 'number' ? seed : 0),
      }));
      return JSON.stringify({ ok: true });
    } catch (e) {
      return fail('bundle_load_failed', e && e.message ? e.message : e);
    }
  },

  // ── 083 S3: lifecycle актора ────────────────────────────────────────────────
  //
  // Тройка по обе стороны границы. Ответы — ВСЕГДА JSON-строка: `evalHarness` на хосте считает
  // не-строку вмешательством в харнесс и гасит сессию, поэтому «бросить наружу» здесь означает
  // «сказать хосту, что харнесс подменён», а это другой факт.

  /** Создать актора под выданным хостом дескриптором. */
  createActor(handleId, initJson) {
    let initWire;
    try {
      initWire = JSON.parse(initJson);
    } catch {
      return fail('sandbox_output_malformed', 'createActor: init не валидный JSON');
    }
    const r = createActorSlot(actors, globalThis.__bundleModule, handleId, initWire);
    if (!r.ok) return fail('bundle_load_failed', r.detail);
    return JSON.stringify({ ok: true });
  },

  /** Доставить событие; вернуть команды автора и состояние генератора после его розыгрышей. */
  actorEvent(msgJson) {
    let msg;
    try {
      msg = JSON.parse(msgJson);
    } catch {
      return fail('sandbox_output_malformed', 'actorEvent: сообщение не валидный JSON');
    }
    const r = deliverActorEvent(actors, msg);
    if (!r.ok) return fail('sandbox_crashed', r.detail);
    return JSON.stringify({ ok: true, commands: r.commands, rng: r.rng });
  },

  /** Освободить актора. Идемпотентно: повторный вызов на освобождённом — не отказ. */
  disposeActor(handleId) {
    actors.delete(handleId);
    return JSON.stringify({ ok: true });
  },

  /**
   * Сколько акторов живо ВНУТРИ изолята.
   *
   * Существует ради гейта атомарности: счётчик хоста доказывает только то, что хост о себе думает.
   * Утечка за границей — слот, который хост уже не адресует, — видна лишь отсюда.
   */
  actorSessions() {
    return JSON.stringify({ ok: true, count: actors.size });
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
