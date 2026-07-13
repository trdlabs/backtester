// 019 — deny-shims (defense-in-depth; исполняется ВНУТРИ контейнера; US4; research R8,
// contracts/sandbox-ipc-protocol; FR-006/019).
//
// НЕ основная гарантия безопасности — ею являются флаги контейнера (network none, read-only rootfs,
// cap-drop ALL, no env, pids-limit). Shims делают две вещи:
//  (1) installDenyShims(): патчат singleton'ы, которые ядро не закрывает полностью — child_process
//      (спавн/shell) и process.env (секрет-паттерны) → бросают tagged-ошибку;
//  (2) classifyError(): маппят РЕЗУЛЬТАТ запрещённой попытки (ошибку ядра/модуля) в СТАБИЛЬНЫЙ код
//      (sandbox_forbidden_access / sandbox_forbidden_import). node-core singleton'ы общие с ESM-импортом
//      bundle, поэтому патч виден и коду модуля.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Пометить ошибку стабильным sandbox-кодом (для classifyError). */
function deny(code, message) {
  const e = new Error(message);
  e.__sandboxCode = code;
  return e;
}

const SECRET_KEY_RE = /key|secret|token|password|passwd|credential|bearer|api[_-]?key/i;

/**
 * P1-4 — stdio isolation. The untrusted bundle shares this process (imported via `import()`), hence it
 * shares process.stdin / process.stdout / console. Capture a PRIVATE write handle for the NDJSON
 * protocol, neuter the public stdout write + console.* so the bundle can neither inject a forged
 * response line nor corrupt the stream with logs, and (when `opts.deadStdin` is given) hand the bundle
 * a dead stdin so it can't peek the request wire — a batch/bar-major envelope carries FUTURE bars, so a
 * `process.stdin.on('data')` listener would be a structural look-ahead. The harness's readline is
 * created from the REAL stdin BEFORE this call and keeps its own reference, so request reading is
 * unaffected. Container flags remain the real security boundary; this is defense-in-depth for RESULT
 * integrity. Returns `{ realWrite }` — the harness routes every protocol line through it.
 */
export function isolateStdio(proc, con, opts = {}) {
  // The ONLY surviving reference to the real fd-1 stream is this closure-captured bound write. The
  // public process.stdout is then replaced WHOLESALE + LOCKED, so a neuter-bypass — `delete
  // process.stdout.write` (falls back to the prototype method) or
  // `Object.getPrototypeOf(...).write.call(process.stdout, ...)` — can only reach the discard sink,
  // never fd 1. (A raw fd write via fs.writeSync(1) remains a residual; the container flags and the
  // host seq check are the backstops.)
  const realWrite = proc.stdout.write.bind(proc.stdout);
  // Throws if the property can't be locked → the caller (entry.mjs) fails CLOSED rather than running
  // untrusted code with real stdio exposed.
  Object.defineProperty(proc, 'stdout', {
    value: opts.sink,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  // console.* → no-op: Node's console keeps its OWN reference to the original stdout, so swapping the
  // stream object is not enough — a bundle `console.log` would otherwise inject into fd 1.
  const noop = () => {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'group', 'groupEnd']) {
    if (con && typeof con[m] === 'function') con[m] = noop;
  }
  // Hand the bundle a dead, LOCKED process.stdin so it can't peek the request wire (batch/bar-major
  // look-ahead). The harness's readline captured the REAL stdin before this call.
  Object.defineProperty(proc, 'stdin', {
    value: opts.deadStdin,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  return { realWrite };
}

/** Установить shims: блокировать спавн процессов/shell и доступ к секрет-подобным env-переменным. */
export function installDenyShims() {
  // --- child_process: спавн/shell запрещён (FR-019; ядро + pids-limit это не гарантируют полностью) ---
  try {
    const cp = require('node:child_process');
    for (const m of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      if (typeof cp[m] === 'function') {
        cp[m] = () => {
          throw deny('sandbox_forbidden_access', `child_process.${m} blocked (no process spawn / shell)`);
        };
      }
    }
  } catch {
    /* модуль недоступен — ок */
  }

  // --- process.env: чтение секрет-подобных ключей запрещено (env не пробрасывается, но defense-in-depth) ---
  try {
    const snapshot = { ...process.env };
    const trap = new Proxy(snapshot, {
      get(target, key) {
        if (typeof key === 'string' && SECRET_KEY_RE.test(key)) {
          throw deny('sandbox_forbidden_access', `env access to secret-like key "${key}" blocked`);
        }
        return target[key];
      },
    });
    Object.defineProperty(process, 'env', { value: trap, configurable: true });
  } catch {
    /* не удалось — ядро всё равно не передаёт секреты */
  }
}

const NETWORK_ERRNO = new Set([
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETDOWN',
]);
const FS_WRITE_ERRNO = new Set(['EROFS', 'EACCES', 'EPERM']);
const MODULE_NOT_FOUND = new Set([
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'MODULE_NOT_FOUND',
]);

/**
 * Классифицировать ошибку запрещённой попытки в стабильный sandbox-код.
 * Приоритет: явный tag → forbidden-import (нет пакета в контейнере) → сеть/host-write → иначе crashed.
 */
export function classifyError(e) {
  if (e && typeof e === 'object') {
    if (typeof e.__sandboxCode === 'string') return e.__sandboxCode;
    const code = typeof e.code === 'string' ? e.code : '';
    if (MODULE_NOT_FOUND.has(code)) return 'sandbox_forbidden_import';
    if (NETWORK_ERRNO.has(code)) return 'sandbox_forbidden_access';
    if (FS_WRITE_ERRNO.has(code)) return 'sandbox_forbidden_access';
    const msg = typeof e.message === 'string' ? e.message : '';
    if (/Cannot find (package|module)/i.test(msg)) return 'sandbox_forbidden_import';
  }
  return 'sandbox_crashed';
}
