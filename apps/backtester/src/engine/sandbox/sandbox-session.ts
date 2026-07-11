// 019 — SandboxSession (US2; research R5, data-model §4; FR-011).
//
// Один долгоживущий контейнер на (модуль, символ): open → init → hook×N → dispose → close.
// Instance модуля и его состояние живут ВНУТРИ контейнера (harness) между хуками; host на каждый
// вызов инжектирует свежий read-only snapshot (state не пересекает границу). Любое нарушение →
// fail-closed: контейнер убивается, последующие вызовы немедленно возвращают пустой результат + код.

import type { StrategyContext } from '@trading/research-contracts/research';
import type { ModuleBundle } from './bundle.js';
import type { SandboxPolicy } from '../sandbox-policy.js';
import { DockerDriver, type SpawnedContainer, sessionContainerName, universeContainerName } from './docker-driver.js';
import { AsyncIpcChannel } from './async-ipc-channel.js';
import { serializeContext, plainBar } from './context-serializer.js';
import type { SandboxValidationCode } from './errors.js';
import { toMountSource, type MountConfig } from './mounts.js';
import type { HookBatchEntry } from './ipc.js';

/** Ошибка одного вызова (стабильный код + bounded detail + хук-контекст). */
export interface SessionError {
  readonly code: SandboxValidationCode;
  readonly detail: string;
  readonly hook?: string;
  readonly barIndex?: number;
}

/** Результат вызова хука: при ok — decisions (для ревалидации); иначе fail-closed + error. */
export interface HookResult {
  readonly ok: boolean;
  readonly decisions: readonly unknown[];
  readonly error?: SessionError;
}

/**
 * Результат callHookBatch (17b, INERT — движок пока не вызывает). Успех: батч выполнен целиком
 * ИЛИ остановлен раньше на непустом decision (stoppedAt = индекс последнего исполненного бара).
 * Неуспех: fail-closed (как callHook) — stoppedAt = индекс последнего УСПЕШНО завершённого бара
 * (barOffset-1 при err, -1 если сбой до/на первом баре батча).
 */
export type BatchHookResult =
  | { readonly ok: true; readonly stoppedAt: number; readonly decisions: readonly unknown[] }
  | { readonly ok: false; readonly stoppedAt: number; readonly error?: SessionError };

// Допуск на СТАРТ контейнера (docker run + node + import bundle) — инфраструктурная задержка,
// НЕ относится к compute-квоте хука (FR-020 ограничивает время ВЫЧИСЛЕНИЯ хука). Амортизируется
// одним стартом на сессию; per-hook deadline (wallTimeMsPerCall) применяется ПОСЛЕ старта.
const CONTAINER_STARTUP_GRACE_MS = 30_000;

/** Параметры открытия сессии. */
export interface SessionConfig {
  readonly runId: string;
  readonly symbol: string;
  readonly seed: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly kind: 'strategy' | 'overlay';
  // Опциональный disambiguator имени контейнера. Прод НЕ задаёт (имя детерминировано по FR-024 —
  // runId уникален по построению). Используется только тестами, где несколько параллельных файлов
  // переиспользуют один и тот же runId/символ и иначе создавали бы одноимённые контейнеры.
  readonly containerSuffix?: string;
  // Universe mode (Task 5): ONE container serves N symbols instead of one-container-per-symbol.
  // When true, the container name comes from `universeContainerName` (kind + bundleHash, no
  // symbol segment), `init` is sent lazily per-symbol on first hook (not inside open()), and bar
  // bookkeeping is keyed per-symbol instead of the scalar barIndex/lastBarTs. Absent/false ⇒
  // byte-identical to the pre-Task-5 one-container-per-symbol path.
  readonly universe?: boolean;
  // Bundle content hash — only consumed in universe mode (disambiguates the container name when a
  // strategy and an overlay bundle share a moduleId/version on the same runId).
  readonly bundleHash?: string;
}

/** Сессия sandbox-исполнения одного модуля на одном символе. */
export class SandboxSession {
  private container?: SpawnedContainer;
  private channel?: AsyncIpcChannel;
  private seq = 0;
  private barIndex = -1;                 // non-universe (single symbol) — unchanged
  private lastBarTs: number | undefined; // non-universe — unchanged
  private readonly perSymbol = new Map<string, { barIndex: number; lastBarTs?: number }>(); // universe
  private readonly initializedSymbols = new Set<string>(); // universe: symbols whose init was sent
  // Universe mode (Task 6): per-symbol fail-closed latch. A HARNESS-level `err` (strategy exception
  // caught by the harness, container alive) degrades only the offending symbol — this map records
  // it so every subsequent callHook/callHookBatch for that symbol returns fail-closed immediately,
  // without reaching the harness, while other symbols keep running on the shared container. A
  // channel-level death (eof/timeout/overflow/malformed) is session-fatal (`this.fail()`, unchanged).
  private readonly failedSymbols = new Map<string, SessionError>();
  private sessionDeadlineEpoch = Number.POSITIVE_INFINITY;
  private failed = false;
  private lastError?: SessionError;
  // BACKTESTER_IPC_PROFILE=true: accumulate per-session IPC-wait/open timings, dumped on close().
  private static readonly profileEnabled = process.env.BACKTESTER_IPC_PROFILE === 'true';
  private profOpenMs = 0;
  private profIpcWaitMs = 0;
  private profHookCalls = 0;
  // Universe mode only: per-symbol `init` handshakes (ensureSymbolInit). Their blocking receive is
  // credited to profOpenMs (an init/startup cost, symmetric with the non-universe init inside
  // openInner); this counts them so the profile surfaces them instead of dropping them silently.
  private profInitCalls = 0;
  private profClosed = false;

  constructor(
    private readonly bundle: ModuleBundle,
    private readonly policy: SandboxPolicy,
    private readonly cfg: SessionConfig,
    private readonly driver: DockerDriver,
    private readonly harnessDir: string,
    private readonly mount: MountConfig = { mode: 'bind' },
  ) {}

  /** Был ли зафиксирован сбой (для агрегации в executor). */
  get error(): SessionError | undefined {
    return this.lastError;
  }

  private fail(error: SessionError): HookResult {
    this.failed = true;
    this.lastError = error;
    this.close();
    return { ok: false, decisions: [], error };
  }

  /** Открыть контейнер и проинициализировать harness (загрузка bundle + инстанцирование). */
  async open(): Promise<HookResult> {
    const profT0 = SandboxSession.profileEnabled ? performance.now() : 0;
    const res = await this.openInner();
    if (SandboxSession.profileEnabled) this.profOpenMs += performance.now() - profT0;
    return res;
  }

  private async openInner(): Promise<HookResult> {
    if (this.container !== undefined) return { ok: true, decisions: [] }; // universe: container already up
    const { manifest, descriptor, bundleDir } = this.bundle;
    const name = this.cfg.universe === true
      ? universeContainerName(this.cfg.runId, this.cfg.kind, this.cfg.bundleHash ?? '', this.cfg.containerSuffix)
      : sessionContainerName(this.cfg.runId, manifest.id, manifest.version, this.cfg.symbol, this.cfg.containerSuffix);
    try {
      const bundleMount = toMountSource(this.mount, bundleDir);
      const harnessMount = toMountSource(this.mount, this.harnessDir);
      this.container = this.driver.spawnSession(this.policy, {
        name,
        bundle: bundleMount,
        harness: harnessMount,
      });
    } catch (e) {
      return this.fail({ code: 'sandbox_crashed', detail: `docker spawn failed: ${(e as Error).message}` });
    }
    this.channel = new AsyncIpcChannel(
      this.container.child.stdin,
      this.container.child.stdout,
      this.container.child.stderr,
      this.policy.limits,
    );

    // Universe mode: init is per-symbol (ensureSymbolInit, on each symbol's first hook), NOT sent
    // here — the container just spawns and the session becomes ready to accept per-symbol inits.
    if (this.cfg.universe !== true) {
      this.channel.send({
        t: 'init',
        runId: this.cfg.runId,
        moduleRef: { id: manifest.id, version: manifest.version },
        symbol: this.cfg.symbol,
        kind: this.cfg.kind,
        seed: this.cfg.seed,
        params: this.cfg.params,
        manifestHooks: manifest.hooks,
        entryPoint: descriptor.entryPoint,
      });
      // Старт контейнера + загрузка bundle: startup-grace (не compute-квота). Compute-бюджет сессии
      // (wallTimeMsPerSession) стартует ПОСЛЕ успешного init.
      const outcome = await this.channel.receive(Date.now() + CONTAINER_STARTUP_GRACE_MS);
      if (outcome.kind === 'ok') {
        this.sessionDeadlineEpoch = Date.now() + this.policy.limits.wallTimeMsPerSession;
        return { ok: true, decisions: [] };
      }
      return this.fail(this.mapFailure(outcome, 'init', 'bundle_load_failed'));
    }

    this.sessionDeadlineEpoch = Date.now() + this.policy.limits.wallTimeMsPerSession;
    return { ok: true, decisions: [] };
  }

  /**
   * Universe mode only: send this symbol's `init` envelope over the (already-open, shared)
   * container channel on its first hook call, and await the ok before any hook for it proceeds.
   * No-op (returns undefined immediately) once the symbol is initialized, and always a no-op in
   * non-universe mode (init there is sent once, inside openInner, for cfg.symbol).
   */
  private async ensureSymbolInit(ctx: StrategyContext): Promise<HookResult | undefined> {
    if (this.cfg.universe !== true || this.initializedSymbols.has(ctx.symbol)) return undefined;
    const { manifest, descriptor } = this.bundle;
    this.channel!.send({
      t: 'init',
      runId: this.cfg.runId,
      moduleRef: { id: manifest.id, version: manifest.version },
      symbol: ctx.symbol,
      kind: this.cfg.kind,
      seed: this.cfg.seed,
      params: this.cfg.params,
      manifestHooks: manifest.hooks,
      entryPoint: descriptor.entryPoint,
      universe: true,
    });
    const profT0 = SandboxSession.profileEnabled ? performance.now() : 0;
    const outcome = await this.channel!.receive(Date.now() + CONTAINER_STARTUP_GRACE_MS);
    if (SandboxSession.profileEnabled) {
      this.profOpenMs += performance.now() - profT0;
      this.profInitCalls += 1;
    }
    if (outcome.kind !== 'ok') return this.fail(this.mapFailure(outcome, 'init', 'bundle_load_failed'));
    this.initializedSymbols.add(ctx.symbol);
    return undefined;
  }

  /**
   * Per-entry newBar/newOi/newLiq computation + host-side bar bookkeeping (barIndex/lastBarTs)
   * advance — factored out of callHook so callHook and callHookBatch (17b) share ONE implementation
   * and cannot drift. Side-effecting (mutates barIndex/lastBarTs) BY DESIGN — see callHookBatch's
   * doc comment for how the batch path accounts for (and rewinds) those side effects on early stop.
   */
  private buildHookPayload(ctx: StrategyContext): HookBatchEntry {
    // Universe mode reads/writes the counter from the per-symbol map; non-universe reads/writes the
    // scalars (byte-identical to pre-Task-5: same reads, same increments, same write-back).
    const useMap = this.cfg.universe === true;
    let st: { barIndex: number; lastBarTs?: number };
    if (useMap) {
      st = this.perSymbol.get(ctx.symbol) ?? { barIndex: -1 };
      this.perSymbol.set(ctx.symbol, st);
    } else {
      st = { barIndex: this.barIndex, lastBarTs: this.lastBarTs };
    }

    // newBar: при переходе на новый бар (ts) — закрытая свеча t; повторный хук того же бара → null.
    let newBar = null as ReturnType<typeof plainBar> | null;
    // 023: инкрементальная подача OI/liq минуты t (зеркало newBar), ТОЛЬКО на переходе бара и ТОЛЬКО
    // если лента несёт kind (composition-following). null = gap(t); undefined (опущено) = kind'а нет.
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
    if (!useMap) { this.barIndex = st.barIndex; this.lastBarTs = st.lastBarTs; } // write scalars back (non-universe)

    return {
      snapshot: serializeContext(ctx, st.barIndex),
      newBar,
      ...(newOi !== undefined ? { newOi } : {}),
      ...(newLiq !== undefined ? { newLiq } : {}),
    };
  }

  /** Вызвать lifecycle-хук модуля внутри сессии; вернуть сырые decisions (ревалидация — в executor). */
  async callHook(hook: string, ctx: StrategyContext): Promise<HookResult> {
    if (this.failed) {
      return { ok: false, decisions: [], error: this.lastError };
    }
    if (this.cfg.universe === true) {
      const prior = this.failedSymbols.get(ctx.symbol);
      if (prior !== undefined) return { ok: false, decisions: [], error: prior }; // symbol latched → fail-closed
    }
    if (this.channel === undefined) {
      const opened = await this.open();
      if (!opened.ok) return opened;
    }
    if (this.cfg.universe === true) {
      const f = await this.ensureSymbolInit(ctx);
      if (f !== undefined) return f;
    }
    const channel = this.channel;
    if (channel === undefined) return { ok: false, decisions: [], error: this.lastError };

    const payload = this.buildHookPayload(ctx);
    this.seq += 1;
    channel.send({
      t: 'hook',
      seq: this.seq,
      hook,
      snapshot: payload.snapshot,
      newBar: payload.newBar,
      ...(payload.newOi !== undefined ? { newOi: payload.newOi } : {}),
      ...(payload.newLiq !== undefined ? { newLiq: payload.newLiq } : {}),
    });

    const profT0 = SandboxSession.profileEnabled ? performance.now() : 0;
    const outcome = await channel.receive(this.callDeadline());
    if (SandboxSession.profileEnabled) {
      this.profIpcWaitMs += performance.now() - profT0;
      this.profHookCalls += 1;
    }
    if (outcome.kind === 'ok') return { ok: true, decisions: outcome.decisions };
    const error = this.mapFailure(outcome, hook, 'sandbox_crashed');
    if (this.cfg.universe === true && outcome.kind === 'err') {
      // per-symbol soft failure: the harness caught a strategy exception; the container is alive.
      // Latch THIS symbol (remaining bars fail-closed) but keep the session — other symbols run on.
      this.failedSymbols.set(ctx.symbol, error);
      return { ok: false, decisions: [], error };
    }
    return this.fail(error); // container death (eof/timeout/overflow/malformed) or non-universe: session-fatal
  }

  /**
   * Read the current barIndex/lastBarTs bookkeeping slot that callHookBatch is tracking for
   * `symbol` — the per-symbol map slot in universe mode, or the scalars otherwise. Mirrors
   * buildHookPayload's own useMap branch so callHookBatch's snapshot/restore always agrees with
   * where buildHookPayload actually wrote the advanced counter.
   */
  private readBookkeeping(symbol: string): { barIndex: number; lastBarTs: number | undefined } {
    if (this.cfg.universe === true) {
      const st = this.perSymbol.get(symbol);
      return { barIndex: st?.barIndex ?? -1, lastBarTs: st?.lastBarTs };
    }
    return { barIndex: this.barIndex, lastBarTs: this.lastBarTs };
  }

  /**
   * Write back a rewound barIndex/lastBarTs snapshot for `symbol` — into the per-symbol map slot
   * in universe mode, or the scalars otherwise. Counterpart to readBookkeeping; used by
   * callHookBatch's partial-stop rewind so the REAL counter (map slot, in universe mode) is what
   * gets rolled back, not a frozen scalar.
   */
  private writeBookkeeping(symbol: string, state: { barIndex: number; lastBarTs: number | undefined }): void {
    if (this.cfg.universe === true) {
      this.perSymbol.set(symbol, { barIndex: state.barIndex, lastBarTs: state.lastBarTs });
    } else {
      this.barIndex = state.barIndex;
      this.lastBarTs = state.lastBarTs;
    }
  }

  /**
   * Batch variant of callHook (17b) — sends N pre-built `onBarClose` payloads in ONE envelope; the
   * harness may stop early (first non-empty decision) or fail partway through (see hook-batch.mjs's
   * `runHookBatch`). INERT: no production caller yet (the engine still drives callHook one bar at a
   * time) — this method exists so the protocol + host bookkeeping can be pinned by tests ahead of
   * the engine wiring task.
   *
   * TAIL-BOUNDARY MECHANISM — chosen: EAGER BUILD + REWIND (not lazy per-bar build).
   * `buildHookPayload` is the same impure, shared method callHook uses (it advances
   * `barIndex`/`lastBarTs` as a side effect) — reusing it verbatim (rather than adding a
   * "count-only"/lazy variant) is what makes drift between callHook and callHookBatch impossible.
   * The cost is that ALL N payloads are built (and their bookkeeping advanced) up front, even though
   * the harness may only execute a prefix. To pay that back, bookkeeping is snapshotted after every
   * entry; once the outcome tells us how many entries the harness actually ran, `barIndex`/
   * `lastBarTs` are rolled back to the snapshot taken right after entry `stoppedAt`.
   *
   * This rewind boundary is NOT arbitrary — it must agree exactly with the harness's own resend
   * boundary, which `hook-batch.mjs`'s `runHookBatch` pins (and `harness-hook-batch.test.ts` case c
   * asserts): the harness pushes an entry's `newBar` into its buffer BEFORE invoking the hook on
   * that entry, so entry `stoppedAt` (whether it produced the stopping decision or the batch simply
   * ran to completion) is fully consumed harness-side, and every entry AFTER `stoppedAt` was never
   * touched. Rewinding host bookkeeping to "the state right after entry stoppedAt" means the NEXT
   * call's `buildHookPayload` sees `ctx.bar.ts` for the first discarded entry differ from the
   * rewound `lastBarTs`, so it naturally re-emits a fresh `newBar` for exactly the bars the harness
   * never received — host and harness agree on the resend boundary by construction, not by
   * recomputation. `sandbox-session-batch.test.ts` pins this by inspecting the NEXT call's payload.
   *
   * On an `err` outcome we deliberately do NOT rewind: `this.fail()` below closes the channel and
   * latches `this.failed`, so no subsequent call can observe (or act on) stale bookkeeping — the
   * session is dead from this point on.
   */
  async callHookBatch(ctxs: readonly StrategyContext[]): Promise<BatchHookResult> {
    if (this.failed) return { ok: false, stoppedAt: -1, error: this.lastError };
    if (this.cfg.universe === true && ctxs.length > 0) {
      const prior = this.failedSymbols.get(ctxs[0]!.symbol);
      // symbol latched → fail-closed immediately, without sending. stoppedAt: -1 (not 0) matches this
      // file's own convention for "failure before/at the first bar of the batch" (see the `this.failed`
      // early-return above and both generic-error returns below) — sandbox-executor.ts's error
      // attribution reads `ctxs[stoppedAt + 1]`, so -1 correctly points back at ctxs[0].
      if (prior !== undefined) return { ok: false, stoppedAt: -1, error: prior };
    }
    if (this.channel === undefined) {
      const opened = await this.open();
      if (!opened.ok) return { ok: false, stoppedAt: -1, error: this.lastError };
    }
    if (this.cfg.universe === true && ctxs.length > 0) {
      const f = await this.ensureSymbolInit(ctxs[0]!);
      if (f !== undefined) return { ok: false, stoppedAt: -1, error: f.error };
    }
    const channel = this.channel;
    if (channel === undefined) return { ok: false, stoppedAt: -1, error: this.lastError };

    // Batch is single-symbol (the executor keys a batch by ctxs[0].symbol) — read/restore below
    // target THAT symbol's bookkeeping slot (map, in universe mode). Falls back to cfg.symbol only
    // for an empty batch, where it's never actually consulted (bars stays empty).
    const batchSymbol = ctxs[0]?.symbol ?? this.cfg.symbol;
    const bars: HookBatchEntry[] = [];
    const bookkeepingAfter: Array<{ barIndex: number; lastBarTs: number | undefined }> = [];
    for (const ctx of ctxs) {
      bars.push(this.buildHookPayload(ctx)); // advances barIndex/lastBarTs per entry (shared with callHook)
      bookkeepingAfter.push(this.readBookkeeping(batchSymbol));
    }

    this.seq += 1;
    channel.send({ t: 'hookBatch', seq: this.seq, hook: 'onBarClose', bars });
    const profT0 = SandboxSession.profileEnabled ? performance.now() : 0;
    const outcome = await channel.receive(this.callDeadline());
    if (SandboxSession.profileEnabled) {
      this.profIpcWaitMs += performance.now() - profT0;
    }
    // 17b review item (a): credit stoppedAt + 1 hook calls (parity with callHook's per-call +1 —
    // same profileEnabled gate), wrapping every return below so profHookCalls reflects the actual
    // number of bars the harness executed regardless of which branch produced the result.
    const finish = (result: BatchHookResult): BatchHookResult => {
      if (SandboxSession.profileEnabled) this.profHookCalls += result.stoppedAt + 1;
      return result;
    };

    if (outcome.kind === 'okBatch') {
      // 17b — stoppedAt MUST address a real per-entry snapshot. parseLine only checks
      // `typeof === 'number'`, so a hostile/broken harness line can still smuggle through an
      // out-of-range integer, a fraction, or Infinity (`JSON.parse("1e999")` passes the number
      // check). The harness can never legitimately return anything else — fully-empty is N-1,
      // earliest stop is 0 — so anything outside [0, bars.length) fails closed like a malformed line
      // instead of indexing bookkeepingAfter with a bogus value and throwing.
      if (!Number.isInteger(outcome.stoppedAt) || outcome.stoppedAt < 0 || outcome.stoppedAt >= bars.length) {
        const error: SessionError = this.mapFailure(
          {
            kind: 'malformed',
            detail: `okBatch stoppedAt out of range: ${outcome.stoppedAt} (batch size ${bars.length})`,
          },
          'onBarClose',
          'sandbox_crashed',
        );
        this.fail(error);
        return finish({ ok: false, stoppedAt: -1, error });
      }
      // Harness executed 0..stoppedAt; roll host-side bar bookkeeping back for the discarded tail
      // so the next lockstep/batch call re-sends those bars' newBar increments (see doc above).
      const restore = bookkeepingAfter[outcome.stoppedAt];
      this.writeBookkeeping(batchSymbol, restore);
      return finish({ ok: true, stoppedAt: outcome.stoppedAt, decisions: outcome.decisions });
    }
    if (outcome.kind === 'err' && outcome.barOffset !== undefined) {
      const { barOffset } = outcome;
      if (Number.isInteger(barOffset) && barOffset >= 0 && barOffset < bars.length) {
        // mapFailure returns a SessionError directly; re-point barIndex at the failing bar using the
        // per-entry snapshot captured while building the batch — bookkeepingAfter[i] holds the exact
        // absolute barIndex after processing entry i, so this doesn't assume every entry advanced it.
        const mapped: SessionError = this.mapFailure(outcome, 'onBarClose', 'sandbox_crashed');
        const error: SessionError = { ...mapped, barIndex: bookkeepingAfter[barOffset].barIndex };
        if (this.cfg.universe === true) {
          // per-symbol soft failure: the harness caught a strategy exception mid-batch; container
          // alive. Latch batchSymbol (its remaining bars fail-closed) but keep the session running.
          this.failedSymbols.set(batchSymbol, error);
        } else {
          this.fail(error); // non-universe: session-fatal (unchanged)
        }
        return finish({ ok: false, stoppedAt: barOffset - 1, error });
      }
      // barOffset out of range for this batch — cannot trust it to index bookkeepingAfter; fall
      // through to the generic (non-barOffset) error mapping below instead of indexing blindly.
    }
    const error: SessionError = this.mapFailure(outcome, 'onBarClose', 'sandbox_crashed');
    if (this.cfg.universe === true && outcome.kind === 'err') {
      // harness-level err without a usable barOffset — container still alive; soft-latch the symbol
      // rather than tearing down the shared session (mirrors the barOffset branch above).
      this.failedSymbols.set(batchSymbol, error);
      return finish({ ok: false, stoppedAt: -1, error });
    }
    this.fail(error); // channel death (eof/timeout/overflow/malformed) or non-universe: session-fatal
    return finish({ ok: false, stoppedAt: -1, error });
  }

  /** Закрыть контейнер: EOF на stdin + принудительная детерминированная очистка (idempotent). */
  close(): void {
    if (SandboxSession.profileEnabled && !this.profClosed && this.profHookCalls > 0) {
      this.profClosed = true;
      console.error(JSON.stringify({
        evt: 'ipc_profile',
        kind: this.cfg.kind,
        symbol: this.cfg.symbol,
        hookCalls: this.profHookCalls,
        symbolInits: this.profInitCalls,
        ipcWaitMs: Math.round(this.profIpcWaitMs),
        openMs: Math.round(this.profOpenMs),
        avgIpcWaitMsPerHook: Number((this.profIpcWaitMs / this.profHookCalls).toFixed(3)),
      }));
    }
    const c = this.container;
    if (c === undefined) return;
    this.container = undefined;
    this.channel = undefined;
    // Close stdin THROUGH the stream (not closeSync on a raw fd): the AsyncIpcChannel holds a
    // live Writable over child.stdin, so closing the bare fd underneath it left a dangling
    // socket on a reused fd → EBADF cross-talk into the next session's container.
    try {
      c.child.stdin.destroy();
    } catch {
      /* already torn down */
    }
    this.driver.dispose(c.name);
  }

  private callDeadline(): number {
    return Math.min(Date.now() + this.policy.limits.wallTimeMsPerCall, this.sessionDeadlineEpoch);
  }

  /**
   * Преобразовать неуспешный receive в SessionError со стабильным кодом. Parameter widened to the
   * FULL ReceiveOutcome (17b): callHookBatch's fallback path (after excluding okBatch and
   * err-with-barOffset via early returns) statically still carries 'ok'/'okBatch' as possible
   * members — both are unreachable in practice (a 'hook' request never yields okBatch, a
   * 'hookBatch' request's ok-shaped success is always tagged okBatch, never ok) but are handled
   * explicitly below so the exhaustiveness check stays sound.
   */
  private mapFailure(
    outcome: Awaited<ReturnType<AsyncIpcChannel['receive']>>,
    hook: string,
    eofCode: SandboxValidationCode,
  ): SessionError {
    const stderr = this.channel?.stderrText() ?? '';
    const barIndex = this.barIndex >= 0 ? this.barIndex : undefined;
    const e = (code: SandboxValidationCode, detail: string, h: string = hook): SessionError => ({
      code,
      detail,
      hook: h,
      barIndex,
    });
    switch (outcome.kind) {
      case 'timeout':
        return e('sandbox_timeout', `hook "${hook}" exceeded wall-time; ${stderr}`);
      case 'overflow':
        return e('sandbox_output_overflow', `output quota exceeded; ${stderr}`);
      case 'malformed':
        return e('sandbox_output_malformed', `${outcome.detail}; ${stderr}`);
      case 'eof': {
        // Контейнер вышел: различаем OOM (cgroup) от прочего краша через docker inspect (T031).
        const state = this.container !== undefined ? this.driver.inspectState(this.container.name) : undefined;
        if (state !== undefined && (state.oomKilled || state.exitCode === 137)) {
          return e('sandbox_memory_exceeded', `OOM-killed (exit ${state.exitCode}); ${stderr}`);
        }
        return e(eofCode, `container exited unexpectedly; ${stderr}`);
      }
      case 'err':
        return e(outcome.code as SandboxValidationCode, outcome.detail || stderr, outcome.hook ?? hook);
      // Unreachable in practice (see doc comment) — handled for exhaustiveness, not real dispatch.
      case 'ok':
      case 'okBatch':
        return e('sandbox_crashed', `unexpected ${outcome.kind} outcome mapped as failure for hook "${hook}"`);
      default: {
        const exhaustive: never = outcome;
        return e('sandbox_crashed', `unknown outcome ${String(exhaustive)}`);
      }
    }
  }
}
