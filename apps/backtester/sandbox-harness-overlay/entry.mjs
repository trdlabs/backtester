// 019 — in-container entrypoint harness (исполняется ВНУТРИ контейнера; US2; contracts/sandbox-ipc-protocol;
// FR-009/010). Host-authored, trusted, монтируется :ro. Запускается как
// `node --disallow-code-generation-from-strings /sandbox/harness/entry.mjs`.
//
// Поток: {t:init} → import(entryPoint) + инстанцирование (ошибка → bundle_load_failed) → NDJSON-цикл
// {t:hook} → rehydrate(snapshot) → module.<hook>(ctx) → {t:ok,decisions} | {t:err,code}. Instance
// модуля и аккумулированный буфер свечей живут в памяти harness между хуками (FR-011). САМОДОСТАТОЧЕН:
// никаких host/dist/npm-импортов в рантайме (только ./rehydrate.mjs из того же :ro-каталога harness).

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createSeededRng, rehydrateContext } from './rehydrate.mjs';
import { installDenyShims, classifyError } from './deny-shims.mjs';
import { runHookBatch } from './hook-batch.mjs';
import { makeInstanceStore, symbolOf, resolveInstance } from './universe-instances.mjs';

// Defense-in-depth: запрет спавна/shell + секрет-env (FR-006/019). Ставится ДО загрузки bundle —
// patched singleton'ы видны коду модуля (общие node-core). Основная гарантия — флаги контейнера.
installDenyShims();

// --- session state (в памяти контейнера) ---
// Universe session: один контейнер хостит N символов, поэтому instance/rng/buffer*
// живут per-symbol в `store` (universe-instances.mjs), а не как module-level singletons.
// Bundle-модуль (loadedModule) кэшируется ОДИН раз — новый instance создаётся per symbol.
const store = makeInstanceStore();
let loadedModule; // импортированный bundle-модуль, кэш между символами

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function ok(seq, decisions) {
  writeLine({ t: 'ok', seq, decisions });
}
function err(seq, hook, code, detail) {
  writeLine({ t: 'err', seq, hook, code, detail: String(detail ?? '').slice(0, 4096) });
}
// 17b — batch protocol line builders (see runHookBatch / handleHookBatch below).
const okBatch = (seq, stoppedAt, decisions) =>
  process.stdout.write(`${JSON.stringify({ t: 'okBatch', seq, stoppedAt, decisions })}\n`);
const errBatch = (seq, hook, code, detail, barOffset) =>
  process.stdout.write(`${JSON.stringify({ t: 'err', seq, hook, code, detail: String(detail ?? '').slice(0, 4096), barOffset })}\n`);

/** Нормализовать вывод хука `decision | decision[] | null` → массив. */
function normalize(out) {
  if (out === null || out === undefined) return [];
  return Array.isArray(out) ? out : [out];
}

/** Выбрать функцию-хук на переданном инстансе по имени (per-symbol instance — не singleton). */
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

/**
 * Импортировать bundle-модуль (кэш ОДИН раз) и разрешить instance (per symbol) через
 * resolveInstance — в universe-режиме non-function default export fail-closed (см.
 * universe-instances.mjs), вне universe-режима — прежнее поведение (shared object допустим).
 */
async function loadFactory(entryPoint, universe) {
  if (loadedModule === undefined) {
    const url = pathToFileURL(`/sandbox/bundle/${entryPoint}`).href;
    loadedModule = await import(url);
  }
  return resolveInstance(loadedModule, { universe });
}

async function handleInit(msg) {
  const symbol = symbolOf(msg);
  try {
    const resolved = await loadFactory(msg.entryPoint, msg.universe === true);
    if (resolved.ok === false) {
      err(undefined, 'init', resolved.code, resolved.reason);
      return; // fail-closed: no slot created
    }
    const built = {
      instance: resolved.instance,
      rng: createSeededRng(typeof msg.seed === 'number' ? msg.seed : 0),
    };
    if (built.instance === undefined || built.instance === null) {
      err(undefined, 'init', 'bundle_load_failed', 'entry produced no module instance');
      return;
    }
    store.ensure(symbol, () => built);
    ok(undefined, []);
  } catch (e) {
    // Загрузка bundle: forbidden static import → classify; иначе синтаксис/инстанцирование → bundle_load_failed.
    const code = classifyError(e);
    err(undefined, 'init', code === 'sandbox_crashed' ? 'bundle_load_failed' : code, e && e.message ? e.message : e);
  }
}

async function handleHook(msg) {
  const { seq, hook, snapshot, newBar, newOi, newLiq } = msg;
  const slot = store.get(symbolOf(msg));
  if (slot === undefined) {
    err(seq, hook, 'sandbox_output_malformed', `hook before init for symbol ${String(symbolOf(msg))}`);
    return;
  }
  try {
    if (newBar !== null && newBar !== undefined) slot.buffer.push(newBar);
    // 023: инкрементальная подача OI/liq (зеркало newBar). undefined = не подаётся (kind'а нет / не
    // новый бар); null = gap минуты t (явный слот, без carry-forward); объект = покрытый снимок.
    if (newOi !== undefined) slot.oiBuffer.push(newOi);
    if (newLiq !== undefined) slot.liqBuffer.push(newLiq);
    const ctx = rehydrateContext(snapshot, slot.buffer, slot.rng, slot.oiBuffer, slot.liqBuffer);
    const fn = pickHookFor(slot.instance, hook);
    if (fn === undefined) {
      ok(seq, []); // отсутствующий хук → пустой результат (как 018)
      return;
    }
    // await: sync-хук вернёт значение как есть; async-попытки (сеть/import/спавн) ловятся в catch.
    const out = await fn.call(slot.instance, ctx);
    if (hook === 'init' || hook === 'dispose') {
      ok(seq, []); // void-хуки
      return;
    }
    ok(seq, normalize(out));
  } catch (e) {
    // Запрещённая попытка (сеть/host-write/env/спавн/forbidden-import) → стабильный код (deny-shims).
    // Per-symbol soft error: контейнер остаётся живым (хост сохраняет сессию — см. Task 6).
    err(seq, hook, classifyError(e), e && e.message ? e.message : e);
  }
}

// 17b — thin wrapper: delegates the actual per-bar iteration to the sibling pure helper
// (hook-batch.mjs) so the logic is importable/testable from the host (this file cannot run there —
// it imports the untrusted bundle from a container-absolute path). Still INERT: nothing on the host
// sends {t:'hookBatch'} yet.
async function handleHookBatch(msg) {
  const slot = store.get(symbolOf(msg));
  if (slot === undefined) {
    errBatch(msg.seq, msg.hook, 'sandbox_output_malformed', `hookBatch before init for symbol ${String(symbolOf(msg))}`, 0);
    return;
  }
  try {
    const r = await runHookBatch(msg.bars, msg.hook, {
      buffer: slot.buffer,
      oiBuffer: slot.oiBuffer,
      liqBuffer: slot.liqBuffer,
      rng: slot.rng,
      instance: slot.instance,
      rehydrateContext,
      pickHook: (h) => pickHookFor(slot.instance, h),
      normalize,
    });
    if (r.kind === 'ok') {
      okBatch(msg.seq, r.stoppedAt, r.decisions);
    } else {
      errBatch(msg.seq, msg.hook, classifyError(r.cause), r.cause && r.cause.message ? r.cause.message : r.cause, r.barOffset);
    }
  } catch (e) {
    // Mirror handleHook's catch: an escape from runHookBatch itself (e.g. rehydrateContext throwing
    // outside its own per-bar try/catch) must still yield a coded error, not harness death.
    errBatch(msg.seq, msg.hook, classifyError(e), e && e.message ? e.message : e, 0);
  }
}

async function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    const s = line.trim();
    if (s === '') continue;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      err(undefined, undefined, 'sandbox_output_malformed', 'request is not valid JSON');
      continue;
    }
    if (msg.t === 'init') {
      await handleInit(msg);
    } else if (msg.t === 'hook') {
      await handleHook(msg);
    } else if (msg.t === 'hookBatch') {
      await handleHookBatch(msg);
    } else {
      err(msg.seq, undefined, 'sandbox_output_malformed', `unknown request t=${String(msg.t)}`);
    }
  }
}

main().catch((e) => {
  err(undefined, undefined, 'sandbox_crashed', e && e.message ? e.message : e);
  process.exit(1);
});
