// POC (analysis/18 вариант A) — IsolateModuleExecutor: strategy/overlay-бандл в isolated-vm
// В ПРОЦЕССЕ воркера вместо docker-контейнера на сессию.
//
// Мотивация (замеры analysis/18): пербарный docker-attach round-trip стоит ~11 мс (94% времени
// прогона); вызов в V8-изолят — микросекунды. Модель изоляции — та же, которой платформа исполняет
// эти же бандлы на live-пути (isolated_vm_adapter, byte-identity 065): память изолята отделена от
// heap хоста (integrity), хост подаёт snapshot только закрытых баров (структурный no-lookahead
// сохраняется), ambient authority в изоляте отсутствует по построению (нет process/require/сети).
//
// Канон парности: внутри изолята исполняется СОБРАННЫЙ isolate-харнесс (_isolate/harness.js) —
// тот же rehydrate.mjs + `_engine/**`, что у docker-харнесса → индикаторы/rng/deep-freeze
// байт-в-байт. Протокол сообщений {hook, snapshot, newBar, newOi, newLiq} и newBar-бухгалтерия
// зеркалят SandboxSession.buildHookPayload.
//
// `isolated-vm` импортится ДИНАМИЧЕСКИ (widened specifier — паттерн платформы): файл компилируется
// без нативного аддона; реально работает, когда аддон собран (прямой dependency сервиса).
//
// POC-границы (задокументированы в analysis/18): sync-хуки only (async → fail-closed), universe
// НЕ поддержан (per-symbol slots внутри одного изолята закрывают этот кейс позже), session-бюджет
// отсутствует намеренно — per-call wallTimeMsPerCall остаётся единственным (и достаточным) гардом.

import { createHash } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StrategyContext } from '@trading/research-contracts/research';
import type { OverlayDecision, StrategyDecision } from '@trading/research-contracts/research';
import type {
  HypothesisOverlayModule,
  LifecycleHook,
  StrategyModule,
} from '@trading/research-contracts/research';
import { type ModuleExecutor, firstDecision } from '../module-executor.js';
import type { ModuleBundle } from './bundle.js';
import type { SandboxPolicy } from '../sandbox-policy.js';
import { DecisionRevalidator } from './decision-revalidator.js';
import { type SandboxErrorArtifact, boundedRedactedDetail } from './errors.js';
import { serializeContext, plainBar } from './context-serializer.js';

// widened specifier → tsc не резолвит модуль в build-графе (паттерн платформенного адаптера).
const IVM_SPECIFIER: string = 'isolated-vm';

/** Собранный isolate-харнесс (esbuild IIFE поверх rehydrate + universe-instances + _engine). */
export function defaultIsolateHarnessScriptPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'sandbox-harness-overlay',
    '_isolate',
    'harness.js',
  );
}

interface SessionErrorLike {
  readonly code: string;
  readonly detail: string;
  readonly hook?: string;
  readonly barIndex?: number;
}

type HookOutcome =
  | { readonly ok: true; readonly decisions: readonly unknown[] }
  | { readonly ok: false; readonly error: SessionErrorLike };

/** isolated-vm бросает на превышении RunOptions.timeout ошибку с 'Script execution timed out.'. */
function isIsolateTimeout(err: unknown): boolean {
  return err instanceof Error && /timed out/i.test(err.message);
}

/** Зависимости исполнителя (инъекция пути к собранному харнессу — для тестов). */
export interface IsolateExecutorDeps {
  readonly harnessScriptPath?: string;
  /**
   * Звать изолят СИНХРОННО (`evalClosureSync`) вместо асинхронного `evalClosure`.
   *
   * Отсутствие ⇒ `!isMainThread`, то есть режим включается сам, когда исполнитель работает не на
   * главном потоке. Правило простое и не допускает случайной регрессии: блокировать разрешено
   * только свой поток, общий — никогда. Явное значение нужно тестам, которые обязаны сравнить оба
   * пути в одном процессе.
   */
  readonly syncCalls?: boolean;
}

/** Исполнитель хуков bundle в V8-изоляте; реализует 018 ModuleExecutor seam (зеркало SandboxModuleExecutor). */
export class IsolateModuleExecutor implements ModuleExecutor {
  private readonly revalidator = new DecisionRevalidator();
  private readonly harnessScriptPath: string;
  /**
   * Синхронные заходы в изолят. Включены по умолчанию ВНЕ главного потока: там блокировка на время
   * хука никого не задевает, а выигрыш измерен (bt#191/196). На главном потоке остаётся
   * асинхронный путь — иначе зациклившийся бандл вешал бы event loop процесса до таймаута.
   */
  private readonly syncCalls: boolean;
  private readonly collectedErrors: SandboxErrorArtifact[] = [];
  // Пербарная бухгалтерия newBar/newOi/newLiq per symbol — зеркало SandboxSession (universe=false).
  private readonly perSymbol = new Map<string, { barIndex: number; lastBarTs?: number }>();
  private readonly initedSymbols = new Set<string>();
  // AIMD-окно батча: стартуем узко, ×2 на полном потреблении, сброс на раннем стопе — защита от
  // eager-build амплификации (annotate-плотная стратегия стопает батч через 1-7 баров, и без окна
  // хост маршалил бы ВСЕ maxBars payload'ов ради 1-2 потреблённых).
  private batchWindow = 8;
  private static readonly BATCH_WINDOW_MIN = 8;
  private static readonly BATCH_WINDOW_MAX = 256;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private isolate: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private context: any;
  private openPromise?: Promise<{ ok: true } | { ok: false; error: SessionErrorLike }>;
  /** Fail-closed защёлка: после session-fatal сбоя все последующие вызовы отвечают той же ошибкой. */
  private failed?: SessionErrorLike;

  constructor(
    private readonly bundle: ModuleBundle,
    private readonly policy: SandboxPolicy,
    deps?: IsolateExecutorDeps,
  ) {
    this.harnessScriptPath = deps?.harnessScriptPath ?? defaultIsolateHarnessScriptPath();
    this.syncCalls = deps?.syncCalls ?? !isMainThread;
  }

  /** Накопленные ошибки исполнения (диагностика US6; зеркало SandboxModuleExecutor.errors). */
  get errors(): readonly SandboxErrorArtifact[] {
    return this.collectedErrors;
  }

  private record(err: SessionErrorLike, ctx: StrategyContext): void {
    const moduleRef = { id: this.bundle.manifest.id, version: this.bundle.manifest.version };
    const detail = boundedRedactedDetail(err.detail, this.policy.limits.maxStderrBytes);
    this.collectedErrors.push({
      code: err.code as SandboxErrorArtifact['code'],
      severity: 'error',
      moduleRef,
      runId: ctx.run.runId,
      hook: err.hook as LifecycleHook | undefined,
      symbol: ctx.symbol,
      barIndex: err.barIndex,
      detail,
    });
    console.warn(
      `[sandbox-isolate] fail-closed module=${moduleRef.id}@${moduleRef.version} hook=${err.hook ?? '?'}` +
        ` symbol=${ctx.symbol} run=${ctx.run.runId} code=${err.code} detail=${detail}`,
    );
  }

  /** Открыть изолят один раз: харнесс-скрипт + ESM-граф бандла (compileModule, self-contained). */
  private ensureOpen(): Promise<{ ok: true } | { ok: false; error: SessionErrorLike }> {
    this.openPromise ??= this.openIsolate().catch((e: unknown) => {
      const error: SessionErrorLike = {
        code: 'bundle_load_failed',
        detail: e instanceof Error ? e.message : String(e),
        hook: 'init',
      };
      this.failed = error;
      return { ok: false as const, error };
    });
    return this.openPromise;
  }

  private async openIsolate(): Promise<{ ok: true }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ivmMod: any = await import(IVM_SPECIFIER);
    const ivm = ivmMod.default ?? ivmMod;
    const memoryLimit = Math.max(8, Math.floor(this.policy.limits.memoryBytes / (1024 * 1024)));
    this.isolate = new ivm.Isolate({ memoryLimit });
    this.context = await this.isolate.createContext();
    const jail = this.context.global;
    await jail.set('global', jail.derefInto());
    // Нет host-объектов: process/require/сеть в изоляте отсутствуют по умолчанию.
    let harnessSrc: string;
    try {
      harnessSrc = readFileSync(this.harnessScriptPath, 'utf8');
    } catch {
      throw new Error(
        `isolate harness script is missing at ${this.harnessScriptPath} — run ` +
          '`pnpm run build:isolate-harness` (after build:sandbox-harness-overlay) or include it in the deploy',
      );
    }
    await (await this.isolate.compileScript(harnessSrc)).run(this.context);

    // ESM-граф бандла: только файлы из descriptor.files (whitelist), только относительные
    // импорты внутри bundleDir — self-contained канон (зеркало docker-пути, FR-003/FR-010:
    // хост читает байты, но НЕ исполняет их — исполнение только в изоляте).
    const shaByPath = new Map(this.bundle.descriptor.files.map((f) => [f.path, f.sha256]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byRel = new Map<string, any>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relOfModule = new Map<any, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const compileOnly = async (rel: string): Promise<any> => {
      const cached = byRel.get(rel);
      if (cached !== undefined) return cached;
      const wantSha = shaByPath.get(rel);
      if (wantSha === undefined) throw new Error(`bundle import outside descriptor.files: ${rel}`);
      const src = readFileSync(join(this.bundle.bundleDir, rel), 'utf8');
      // Integrity (ревью): байты на диске обязаны совпадать с заявленным sha256 ДО компиляции.
      const gotSha = createHash('sha256').update(src).digest('hex');
      if (gotSha !== wantSha) {
        throw new Error(`bundle file sha256 mismatch for ${rel}: descriptor ${wantSha}, on-disk ${gotSha}`);
      }
      const mod = await this.isolate.compileModule(src);
      byRel.set(rel, mod);
      relOfModule.set(mod, rel);
      return mod;
    };
    const entryRel = this.bundle.descriptor.entryPoint;
    const entryMod = await compileOnly(entryRel);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await entryMod.instantiate(this.context, async (specifier: string, referrer: any) => {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        throw new Error(`bundle imports forbidden (self-contained ESM): ${specifier}`);
      }
      const fromRel = relOfModule.get(referrer) ?? entryRel;
      const resolved = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
      if (resolved.startsWith('..')) throw new Error(`bundle import escapes bundleDir: ${specifier}`);
      return compileOnly(resolved);
    });
    // Ревью C1: top-level код бандла недоверен — evaluate обязан жить под тем же per-call
    // wall-квантом, что и хуки (иначе `for(;;)` на верхнем уровне вешает event loop воркера).
    await entryMod.evaluate({ timeout: this.policy.limits.wallTimeMsPerCall });
    await jail.set('__bundleModule', entryMod.namespace.derefInto());
    return { ok: true };
  }

  /** Зеркало SandboxSession.buildHookPayload (non-universe): newBar/newOi/newLiq на переходе бара. */
  private buildHookPayload(ctx: StrategyContext): {
    snapshot: ReturnType<typeof serializeContext>;
    newBar: ReturnType<typeof plainBar> | null;
    newOi?: { ts: number; oiTotalUsd: number } | null;
    newLiq?: { ts: number; longUsd: number; shortUsd: number } | null;
  } {
    let st = this.perSymbol.get(ctx.symbol);
    if (st === undefined) {
      st = { barIndex: -1 };
      this.perSymbol.set(ctx.symbol, st);
    }
    let newBar: ReturnType<typeof plainBar> | null = null;
    let newOi: { ts: number; oiTotalUsd: number } | null | undefined;
    let newLiq: { ts: number; longUsd: number; shortUsd: number } | null | undefined;
    if (ctx.bar.ts !== st.lastBarTs) {
      st.barIndex += 1;
      st.lastBarTs = ctx.bar.ts;
      newBar = plainBar(ctx.bar);
      const m = ctx.market;
      if (m !== undefined) {
        if (m.oiWindow(1).length > 0) newOi = m.oiAsOf() ?? null;
        if (m.liqWindow(1).length > 0) newLiq = m.liqAsOf() ?? null;
      }
    }
    return {
      snapshot: serializeContext(ctx, st.barIndex),
      newBar,
      ...(newOi !== undefined ? { newOi } : {}),
      ...(newLiq !== undefined ? { newLiq } : {}),
    };
  }

  /** Вызвать JS в изоляте с per-call wall-таймаутом; ошибки → SessionErrorLike (fail-closed). */
  private async evalHarness(
    expression: string,
    args: readonly unknown[],
    hook: string,
    barIndex?: number,
    opts?: { promise?: boolean; timeoutMs?: number },
  ): Promise<{ ok: true; json: string } | { ok: false; error: SessionErrorLike }> {
    try {
      const budgetMs = opts?.timeoutMs ?? this.policy.limits.wallTimeMsPerCall;
      let raw: unknown;
      if (this.syncCalls && opts?.promise !== true) {
        // СИНХРОННЫЙ заход. Измерено (bt#191/196): асинхронный `evalClosure` стоит +116…+217 мкс на
        // вызов против синхронного — не потому, что делает больше работы, а потому что ответ идёт
        // через event loop. Для пербарного хука это верхняя часть шкалы, на каждом баре.
        //
        // Хостовая гонка здесь НЕ нужна, и это не ослабление гарда, а исчезновение его повода: она
        // ставилась против повисшего ПРОМИСА в изоляте (патологический thenable), а синхронный
        // вызов промиса не возвращает вовсе. Стоп-кран остаётся нативный — `timeout` прерывает
        // исполнение из сторожевого потока isolated-vm, и он же покрывает `for(;;)` в бандле.
        //
        // Плата — вызов блокирует ТЕКУЩИЙ поток на время хука. Поэтому режим по умолчанию включён
        // только вне главного потока (см. `syncCalls`).
        raw = this.context.evalClosureSync(expression, args as unknown[], {
          result: { copy: true },
          timeout: budgetMs,
        });
      } else {
        const evalP: Promise<unknown> = this.context.evalClosure(expression, args as unknown[], {
          result: { copy: true, promise: opts?.promise === true },
          timeout: budgetMs,
        });
        // Host-side race: нативный timeout покрывает sync-исполнение; повисший промис в изоляте
        // (патологический thenable) добиваем гонкой с запасом поверх бюджета.
        let raceTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          raw = await Promise.race([
            evalP,
            new Promise((_res, rej) => {
              raceTimer = setTimeout(() => rej(new Error('isolate call timed out (host race)')), budgetMs + 500);
              raceTimer.unref?.();
            }),
          ]);
        } finally {
          clearTimeout(raceTimer);
        }
      }
      // Ревью C2: харнесс живёт в ОДНОМ контексте с бандлом — top-level код мог подменить
      // __isolateHarness. Не-строка/не-JSON = вмешательство → session-fatal malformed (fail-closed),
      // как docker-хост поступает с мусором в NDJSON-стриме.
      if (typeof raw !== 'string') {
        const error: SessionErrorLike = {
          code: 'sandbox_output_malformed',
          detail: `harness response is not a string (${typeof raw}) — harness tampered?`,
          hook,
          barIndex,
        };
        this.failed = error;
        return { ok: false, error };
      }
      return { ok: true, json: raw };
    } catch (err) {
      const error: SessionErrorLike = isIsolateTimeout(err)
        ? { code: 'sandbox_timeout', detail: `hook "${hook}" exceeded wall-time (isolate)`, hook, barIndex }
        : {
            code: 'sandbox_crashed',
            detail: err instanceof Error ? err.message : String(err),
            hook,
            barIndex,
          };
      // Session-fatal защёлка — зеркало docker-пути (timeout/crash гасит сессию fail-closed).
      this.failed = error;
      return { ok: false, error };
    }
  }

  private async ensureSymbol(ctx: StrategyContext): Promise<HookOutcome | undefined> {
    if (this.initedSymbols.has(ctx.symbol)) return undefined;
    const r = await this.evalHarness(
      'return globalThis.__isolateHarness.initSymbol($0, $1)',
      [ctx.symbol, ctx.run.seed],
      'init',
    );
    if (!r.ok) return { ok: false, error: r.error };
    let parsed: { ok: boolean; code?: string; detail?: string };
    try {
      parsed = JSON.parse(r.json) as { ok: boolean; code?: string; detail?: string };
    } catch {
      const error: SessionErrorLike = { code: 'sandbox_output_malformed', detail: 'harness init response is not valid JSON', hook: 'init' };
      this.failed = error;
      return { ok: false, error };
    }
    if (!parsed.ok) {
      const error: SessionErrorLike = {
        code: parsed.code ?? 'bundle_load_failed',
        detail: parsed.detail ?? 'symbol init failed',
        hook: 'init',
      };
      this.failed = error;
      return { ok: false, error };
    }
    this.initedSymbols.add(ctx.symbol);
    return undefined;
  }

  private async callHook(hook: string, ctx: StrategyContext): Promise<HookOutcome> {
    if (this.failed !== undefined) return { ok: false, error: this.failed };
    const opened = await this.ensureOpen();
    if (!opened.ok) return { ok: false, error: opened.error };
    const notInited = await this.ensureSymbol(ctx);
    if (notInited !== undefined) return notInited;

    const payload = this.buildHookPayload(ctx);
    const barIndex = payload.snapshot.barIndex;
    const msg = {
      hook,
      snapshot: payload.snapshot,
      newBar: payload.newBar,
      ...(payload.newOi !== undefined ? { newOi: payload.newOi } : {}),
      ...(payload.newLiq !== undefined ? { newLiq: payload.newLiq } : {}),
    };
    const r = await this.evalHarness(
      'return globalThis.__isolateHarness.hook($0)',
      [JSON.stringify(msg)],
      hook,
      barIndex,
    );
    if (!r.ok) return { ok: false, error: r.error };
    // Кап размера решения (SBX-5-класс): проверка host-side по длине JSON-ответа харнесса.
    const maxBytes = this.policy.limits.maxDecisionBytes;
    if (maxBytes > 0 && Buffer.byteLength(r.json, 'utf8') > maxBytes) {
      return {
        ok: false,
        error: { code: 'sandbox_output_overflow', detail: `decision JSON exceeds ${maxBytes} bytes`, hook, barIndex },
      };
    }
    let parsed: { ok: true; decisions: readonly unknown[] } | { ok: false; code: string; detail: string };
    try {
      parsed = JSON.parse(r.json) as typeof parsed;
    } catch {
      const error: SessionErrorLike = { code: 'sandbox_output_malformed', detail: 'harness hook response is not valid JSON', hook, barIndex };
      this.failed = error;
      return { ok: false, error };
    }
    if (parsed.ok) {
      // Ревью follow-up: array-like объект с length-индексами проскочил бы общий ревалидатор
      // (он итерирует по индексам) — принимаем ТОЛЬКО настоящий массив.
      if (!Array.isArray(parsed.decisions)) {
        const error: SessionErrorLike = {
          code: 'sandbox_output_malformed',
          detail: 'harness decisions is not an array — harness tampered?',
          hook,
          barIndex,
        };
        this.failed = error;
        return { ok: false, error };
      }
      return { ok: true, decisions: parsed.decisions };
    }
    return { ok: false, error: { code: parsed.code, detail: parsed.detail, hook, barIndex } };
  }

  async initStrategy(_module: StrategyModule, ctx: StrategyContext): Promise<void> {
    const opened = await this.ensureOpen();
    if (!opened.ok) {
      this.record(opened.error, ctx);
      return;
    }
    const notInited = await this.ensureSymbol(ctx);
    if (notInited !== undefined) {
      if (!notInited.ok) this.record(notInited.error, ctx);
      return;
    }
    if (this.bundle.manifest.hooks.includes('init')) {
      const r = await this.callHook('init', ctx);
      if (!r.ok) this.record(r.error, ctx);
    }
  }

  async executeStrategyHook(
    _module: StrategyModule,
    hook: LifecycleHook,
    ctx: StrategyContext,
  ): Promise<readonly StrategyDecision[]> {
    const r = await this.callHook(hook, ctx);
    if (!r.ok) {
      this.record(r.error, ctx);
      return [];
    }
    const rv = this.revalidator.revalidateStrategy(r.decisions);
    if (!rv.ok) {
      this.record({ code: 'decision_schema_invalid', detail: rv.message, hook }, ctx);
      return [];
    }
    return rv.decisions;
  }

  /**
   * 17b-контракт ОДНИМ заходом в изолят (loop-in-isolate): eager-build всех payload'ов
   * (bookkeeping-снапшот после каждого) → один evalClosure __isolateHarness.hookBatch →
   * rewind бухгалтерии к stoppedAt (канон SandboxSession.callHookBatch: границы отмотки
   * совпадают с resend-границей runHookBatch по построению). Err → session-fatal защёлка
   * БЕЗ отмотки (сессия мертва) + clamped forward-progress (зеркало docker-исполнителя).
   */
  async executeStrategyHookBatch(
    _module: StrategyModule,
    ctxs: readonly StrategyContext[],
  ): Promise<{ stoppedAt: number; decisions: readonly StrategyDecision[] }> {
    if (ctxs.length === 0) return { stoppedAt: -1, decisions: [] };
    const first = ctxs[0]!;
    const failFast = (error: SessionErrorLike, stop: number): { stoppedAt: number; decisions: [] } => {
      this.record(error, first);
      return { stoppedAt: Math.max(0, Math.min(stop, ctxs.length - 1)), decisions: [] };
    };
    if (this.failed !== undefined) return failFast(this.failed, 0);
    const opened = await this.ensureOpen();
    if (!opened.ok) return failFast(opened.error, 0);
    const notInited = await this.ensureSymbol(first);
    if (notInited !== undefined && !notInited.ok) return failFast(notInited.error, 0);

    // AIMD: маршалим только префикс-окно; stoppedAt = window-1 с пустыми решениями легален по
    // контракту (раннер продолжит со следующего бара) — хвост ctxs не строится и не сериализуется.
    const sendCount = Math.min(this.batchWindow, ctxs.length);
    const sent = ctxs.slice(0, sendCount);
    const bars: ReturnType<IsolateModuleExecutor['buildHookPayload']>[] = [];
    const bookkeepingAfter: { barIndex: number; lastBarTs?: number }[] = [];
    for (const ctx of sent) {
      bars.push(this.buildHookPayload(ctx)); // advances perSymbol bookkeeping (shared with callHook)
      const st = this.perSymbol.get(first.symbol)!;
      bookkeepingAfter.push({ barIndex: st.barIndex, lastBarTs: st.lastBarTs });
    }

    // БЛОКЕР-3 ревью: per-call квант — бюджет НА ХУК; конверт из N баров получает N×квант
    // (кап 60с — потолок разового стойла враждебного бандла до защёлки).
    const batchBudgetMs = Math.min(60_000, this.policy.limits.wallTimeMsPerCall * bars.length);
    const r = await this.evalHarness(
      'return globalThis.__isolateHarness.hookBatch($0)',
      [JSON.stringify({ hook: 'onBarClose', bars })],
      'onBarClose',
      bookkeepingAfter[0]!.barIndex,
      { timeoutMs: batchBudgetMs },
    );
    if (!r.ok) return failFast(r.error, 0); // timeout/crash — защёлка уже стоит, отмотки нет
    // БЛОКЕР-2 ревью: SBX-5-кап действует и на батч-ответ (регрессия к lockstep-петле недопустима).
    const maxBytes = this.policy.limits.maxDecisionBytes;
    if (maxBytes > 0 && Buffer.byteLength(r.json, 'utf8') > maxBytes) {
      const error: SessionErrorLike = {
        code: 'sandbox_output_overflow',
        detail: `batch decision JSON exceeds ${maxBytes} bytes`,
        hook: 'onBarClose',
      };
      this.failed = error;
      return failFast(error, 0);
    }
    let parsed:
      | { ok: true; stoppedAt: number; decisions: readonly unknown[] }
      | { ok: false; barOffset?: number; code: string; detail: string };
    try {
      parsed = JSON.parse(r.json) as typeof parsed;
    } catch {
      const error: SessionErrorLike = { code: 'sandbox_output_malformed', detail: 'harness batch response is not valid JSON', hook: 'onBarClose' };
      this.failed = error;
      return failFast(error, 0);
    }
    if (!parsed.ok) {
      const j = typeof parsed.barOffset === 'number' ? parsed.barOffset : 0;
      const error: SessionErrorLike = {
        code: parsed.code,
        detail: parsed.detail,
        hook: 'onBarClose',
        barIndex: bookkeepingAfter[Math.max(0, Math.min(j, sent.length - 1))]!.barIndex,
      };
      this.failed = error; // err = session-fatal (зеркало docker fail())
      return failFast(error, j);
    }
    // stoppedAt обязан адресовать реальный снапшот (защита от out-of-range из подменённого харнесса).
    if (!Number.isInteger(parsed.stoppedAt) || parsed.stoppedAt < 0 || parsed.stoppedAt >= bars.length) {
      const error: SessionErrorLike = {
        code: 'sandbox_output_malformed',
        detail: `okBatch stoppedAt out of range: ${String(parsed.stoppedAt)} (batch size ${bars.length})`,
        hook: 'onBarClose',
      };
      this.failed = error;
      return failFast(error, 0);
    }
    if (!Array.isArray(parsed.decisions)) {
      const error: SessionErrorLike = { code: 'sandbox_output_malformed', detail: 'harness batch decisions is not an array', hook: 'onBarClose' };
      this.failed = error;
      return failFast(error, parsed.stoppedAt);
    }
    // Rewind: бары после stoppedAt харнесс не видел — вернуть бухгалтерию к состоянию сразу после
    // stoppedAt, чтобы следующий buildHookPayload переиздал newBar ровно для неотправленных баров.
    const st = this.perSymbol.get(first.symbol)!;
    st.barIndex = bookkeepingAfter[parsed.stoppedAt]!.barIndex;
    st.lastBarTs = bookkeepingAfter[parsed.stoppedAt]!.lastBarTs;

    // AIMD-обновление окна: полный проход без решений → ×2; ранний стоп/решение → сброс.
    const fullyConsumedEmpty = parsed.stoppedAt === sent.length - 1 && parsed.decisions.length === 0;
    this.batchWindow = fullyConsumedEmpty
      ? Math.min(this.batchWindow * 2, IsolateModuleExecutor.BATCH_WINDOW_MAX)
      : IsolateModuleExecutor.BATCH_WINDOW_MIN;

    const rv = this.revalidator.revalidateStrategy(parsed.decisions);
    if (!rv.ok) {
      this.record({ code: 'decision_schema_invalid', detail: rv.message, hook: 'onBarClose' }, sent[parsed.stoppedAt]!);
      return { stoppedAt: parsed.stoppedAt, decisions: [] };
    }
    return { stoppedAt: parsed.stoppedAt, decisions: rv.decisions };
  }

  /** Hint раннеру: сколько ctx строить под следующий батч (= текущее AIMD-окно). */
  preferredBatchBars(): number {
    return this.batchWindow;
  }

  /** Диагностика протокола (тесты/бенч): счётчики hook/batch-заходов + длина буфера. */
  async harnessStats(): Promise<{ hookCalls: number; batchCalls: number; batchBarsReceived: number; bufferLen: number }> {
    const r = await this.evalHarness('return globalThis.__isolateHarness.stats()', [], 'stats');
    if (!r.ok) throw new Error(`harnessStats failed: ${r.error.detail}`);
    return JSON.parse(r.json) as { hookCalls: number; batchCalls: number; batchBarsReceived: number; bufferLen: number };
  }

  /** Slice-B-контракт: bar-major по items — lockstep (зеркало non-universe docker-ветки). */
  async executeStrategyHookBarMajor(
    items: readonly { module: StrategyModule; ctx: StrategyContext }[],
  ): Promise<readonly StrategyDecision[]> {
    const out: StrategyDecision[] = [];
    for (const it of items) {
      out.push(firstDecision(await this.executeStrategyHook(it.module, 'onBarClose', it.ctx)));
    }
    return out;
  }

  async executeOverlayApply(
    _overlay: HypothesisOverlayModule,
    ctx: StrategyContext,
  ): Promise<readonly OverlayDecision[]> {
    const r = await this.callHook('apply', ctx);
    if (!r.ok) {
      this.record(r.error, ctx);
      return [];
    }
    const rv = this.revalidator.revalidateOverlay(r.decisions);
    if (!rv.ok) {
      this.record({ code: 'decision_schema_invalid', detail: rv.message, hook: 'apply' }, ctx);
      return [];
    }
    return rv.decisions;
  }

  async disposeStrategy(_module: StrategyModule, ctx: StrategyContext): Promise<void> {
    if (this.failed !== undefined || !this.initedSymbols.has(ctx.symbol)) return;
    if (this.bundle.manifest.hooks.includes('dispose')) {
      const r = await this.callHook('dispose', ctx);
      if (!r.ok) this.record(r.error, ctx);
    }
  }

  /** Teardown изолята — детерминированная очистка (зеркало docker close()). */
  close(): void {
    try {
      this.isolate?.dispose();
    } catch {
      /* уже disposed */
    }
    this.isolate = undefined;
    this.context = undefined;
  }
}
