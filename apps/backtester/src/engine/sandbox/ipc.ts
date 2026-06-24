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

export type Request = InitRequest | HookRequest;

/** Исход одного round-trip'а (harness → host) либо нарушение, детектированное host-стороной. */
export type ReceiveOutcome =
  | { readonly kind: 'ok'; readonly seq?: number; readonly decisions: readonly unknown[] }
  | { readonly kind: 'err'; readonly seq?: number; readonly hook?: string; readonly code: string; readonly detail: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'eof' }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'overflow' };

