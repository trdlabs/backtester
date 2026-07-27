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
}

/** Исполнитель хуков bundle в V8-изоляте; реализует 018 ModuleExecutor seam (зеркало SandboxModuleExecutor). */
export class IsolateModuleExecutor implements ModuleExecutor {
  private readonly revalidator = new DecisionRevalidator();
  private readonly harnessScriptPath: string;
  private readonly collectedErrors: SandboxErrorArtifact[] = [];
  // Пербарная бухгалтерия newBar/newOi/newLiq per symbol — зеркало SandboxSession (universe=false).
  private readonly perSymbol = new Map<string, { barIndex: number; lastBarTs?: number }>();
  private readonly initedSymbols = new Set<string>();
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
  ): Promise<{ ok: true; json: string } | { ok: false; error: SessionErrorLike }> {
    try {
      const raw: unknown = await this.context.evalClosure(expression, args as unknown[], {
        result: { copy: true },
        timeout: this.policy.limits.wallTimeMsPerCall,
      });
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
        error: { code: 'decision_oversized', detail: `decision JSON exceeds ${maxBytes} bytes`, hook, barIndex },
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
    if (parsed.ok) return { ok: true, decisions: parsed.decisions };
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
   * 17b-контракт: батч по ровному участку. Изоляту батчинг не нужен (вызов — микросекунды),
   * поэтому честный lockstep-цикл с ранней остановкой на первом непустом решении — семантика
   * та же, что у docker-пути, транспортной экономии просто не требуется.
   */
  async executeStrategyHookBatch(
    module: StrategyModule,
    ctxs: readonly StrategyContext[],
  ): Promise<{ stoppedAt: number; decisions: readonly StrategyDecision[] }> {
    for (let i = 0; i < ctxs.length; i += 1) {
      const decisions = await this.executeStrategyHook(module, 'onBarClose', ctxs[i]!);
      if (decisions.length > 0) return { stoppedAt: i, decisions };
      // Защёлка сработала — не прокручивать остаток stretch'а (один err-артефакт, зеркало docker-батча).
      if (this.failed !== undefined) return { stoppedAt: i, decisions: [] };
    }
    return { stoppedAt: ctxs.length - 1, decisions: [] };
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
