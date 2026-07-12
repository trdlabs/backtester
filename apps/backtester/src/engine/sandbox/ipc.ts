// 019 — host-сторона NDJSON-IPC (US2; research R4, contracts/sandbox-ipc-protocol; FR-014).
//
// Конверты init/hook (request) и ok/err (response); сопоставление по `seq`. Async IPC реализован
// в AsyncIpcChannel (async-ipc-channel.ts) поверх child streams.

import type { ContextSnapshot } from './context-serializer.js';
import type { Bar } from '@trading/research-contracts/research';
import type { LiquidationSnapshot, OpenInterestSnapshot } from '@trading/research-contracts/research';

/** init-конверт (host → harness; открытие сессии). */
export interface InitRequest {
  readonly t: 'init';
  readonly runId: string;
  readonly moduleRef: { readonly id: string; readonly version: string };
  readonly symbol: string;
  readonly kind: 'strategy' | 'overlay';
  readonly seed: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly manifestHooks: readonly string[];
  readonly entryPoint: string; // относительный путь внутри /sandbox/bundle
  // Universe mode (Task 9 fix): when true, the harness fails closed at init if the bundle's default
  // export is not a function — a non-function default is a SHARED instance, safe only in its own
  // per-symbol container (non-universe), never across N symbols sharing one universe container.
  // Absent/false ⇒ byte-identical to pre-fix behavior (non-universe init never sets this).
  readonly universe?: boolean;
}

/** hook-конверт (host → harness). */
export interface HookRequest {
  readonly t: 'hook';
  readonly seq: number;
  readonly hook: string;
  readonly snapshot: ContextSnapshot;
  readonly newBar: Bar | null;
  // 023 (additive, US5/§9) — инкрементальная подача минуты t (зеркало newBar), если лента несёт kind.
  // Отсутствует (undefined) = kind'а нет / не новый бар; null = gap минуты t; объект = покрытый снимок.
  readonly newOi?: OpenInterestSnapshot | null;
  readonly newLiq?: LiquidationSnapshot | null;
}

/** Один элемент батча (17b) — то же тело, что и per-entry поля HookRequest, БЕЗ t/seq/hook. */
export interface HookBatchEntry {
  readonly snapshot: ContextSnapshot;
  readonly newBar: Bar | null;
  readonly newOi?: OpenInterestSnapshot | null;
  readonly newLiq?: LiquidationSnapshot | null;
}

/** hookBatch-конверт (host → harness; 17b, INERT — движок пока не отправляет). */
export interface HookBatchRequest {
  readonly t: 'hookBatch';
  readonly seq: number;
  readonly hook: 'onBarClose';
  readonly bars: readonly HookBatchEntry[];
}

/** hookBarMajor-конверт (host → harness; Slice B): один конверт на бар, по одному entry на КАЖДЫЙ
 *  символ того же бара (bars[i] = HookBatchEntry для символа i в порядке request.symbols). */
export interface HookBarMajorRequest {
  readonly t: 'hookBarMajor';
  readonly seq: number;
  readonly hook: 'onBarClose';
  readonly bars: readonly HookBatchEntry[];
}

export type Request = InitRequest | HookRequest | HookBatchRequest | HookBarMajorRequest;

/** Исход одного round-trip'а (harness → host) либо нарушение, детектированное host-стороной. */
export type ReceiveOutcome =
  | { readonly kind: 'ok'; readonly seq?: number; readonly decisions: readonly unknown[] }
  | {
      readonly kind: 'okBatch';
      readonly seq?: number;
      readonly stoppedAt: number;
      readonly decisions: readonly unknown[];
    }
  | {
      readonly kind: 'okBarMajor';
      readonly seq?: number;
      readonly results: readonly (
        | { readonly ok: true; readonly decisions: readonly unknown[] }
        | { readonly ok: false; readonly error: { readonly code: string; readonly detail: string } }
      )[];
    }
  | {
      readonly kind: 'err';
      readonly seq?: number;
      readonly hook?: string;
      readonly code: string;
      readonly detail: string;
      // 17b — присутствует только на err-строках, возникших в ответ на hookBatch (индекс упавшего
      // бара внутри батча; host-сторона переводит его в абсолютный barIndex).
      readonly barOffset?: number;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'eof' }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'overflow' };

