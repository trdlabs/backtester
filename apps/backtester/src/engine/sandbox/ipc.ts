// 019 — host-сторона NDJSON-IPC (US2; research R4, contracts/sandbox-ipc-protocol; FR-014).
//
// Конверты init/hook (request) и ok/err (response); сопоставление по `seq`. IPC СИНХРОНЕН (018 seam
// синхронен): host пишет запрос в stdin контейнера и читает ответ из stdout через raw-fd `fs.readSync`
// в поллинг-цикле с Atomics-сном — это блокирует event loop на время round-trip'а (приемлемо для
// батч-runner'а) и одновременно даёт host-side per-call deadline + байт-счётчики потоков без таймеров.

import { readSync, writeSync } from 'node:fs';
import type { ResourceLimits } from '../sandbox-policy.js';
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

/** Заблокировать поток на `ms` без event-loop'а (для поллинга raw-fd). */
function sleepMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Синхронный NDJSON-канал поверх сырых fd контейнера. Один экземпляр на сессию.
 * Считает байты stdout/stderr нарастающим итогом (квоты потоков) и длину одной строки-ответа
 * (`maxDecisionBytes`). stderr копится в bounded-буфер (диагностика; redaction — US6).
 */
export class SyncIpcChannel {
  private stdoutAcc = '';
  private stdoutTotal = 0;
  private stderrBuf = '';
  private stderrTotal = 0;
  private readonly readBuf = Buffer.allocUnsafe(8192);

  constructor(
    private readonly stdinFd: number,
    private readonly stdoutFd: number,
    private readonly stderrFd: number,
    private readonly limits: ResourceLimits,
  ) {}

  /** Отправить запрос (NDJSON-строка + '\n'). */
  send(req: Request): void {
    writeSync(this.stdinFd, `${JSON.stringify(req)}\n`);
  }

  /** Прочитать stderr non-blocking в bounded-буфер; вернуть true при превышении квоты. */
  private drainStderr(): boolean {
    for (;;) {
      let got: number;
      try {
        got = readSync(this.stderrFd, this.readBuf, 0, this.readBuf.length, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EAGAIN') return false;
        return false; // stderr closed/err — не критично
      }
      if (got === 0) return false;
      this.stderrTotal += got;
      if (this.stderrBuf.length < this.limits.maxStderrBytes) {
        this.stderrBuf += this.readBuf.toString('utf8', 0, got);
        if (this.stderrBuf.length > this.limits.maxStderrBytes) {
          this.stderrBuf = `${this.stderrBuf.slice(0, this.limits.maxStderrBytes)}…[truncated]`;
        }
      }
      if (this.stderrTotal > this.limits.maxStderrBytes * 4) return true; // явный flood
    }
  }

  /** Bounded-текст stderr (диагностика). */
  stderrText(): string {
    return this.stderrBuf;
  }

  /**
   * Ждать одну строку-ответ до абсолютного `deadlineEpochMs`. Параллельно дренирует stderr и
   * следит за квотами потоков. Возвращает разобранный ok/err либо нарушение (timeout/eof/overflow/malformed).
   */
  receive(deadlineEpochMs: number): ReceiveOutcome {
    for (;;) {
      // уже есть полная строка в аккумуляторе?
      const nl = this.stdoutAcc.indexOf('\n');
      if (nl >= 0) {
        const line = this.stdoutAcc.slice(0, nl);
        this.stdoutAcc = this.stdoutAcc.slice(nl + 1);
        if (Buffer.byteLength(line, 'utf8') > this.limits.maxDecisionBytes) {
          return { kind: 'malformed', detail: 'response line exceeds maxDecisionBytes' };
        }
        return this.parseLine(line);
      }

      if (this.drainStderr()) return { kind: 'overflow' };

      let got: number;
      try {
        got = readSync(this.stdoutFd, this.readBuf, 0, this.readBuf.length, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EAGAIN') {
          if (Date.now() >= deadlineEpochMs) return { kind: 'timeout' };
          sleepMs(1);
          continue;
        }
        return { kind: 'eof' };
      }
      if (got === 0) {
        // pipe закрыт — контейнер вышел
        return { kind: 'eof' };
      }
      this.stdoutTotal += got;
      if (this.stdoutTotal > this.limits.maxStdoutBytes) return { kind: 'overflow' };
      this.stdoutAcc += this.readBuf.toString('utf8', 0, got);
      if (this.stdoutAcc.length > this.limits.maxDecisionBytes * 2 && this.stdoutAcc.indexOf('\n') < 0) {
        return { kind: 'malformed', detail: 'unterminated oversized response' };
      }
      if (Date.now() >= deadlineEpochMs) return { kind: 'timeout' };
    }
  }

  private parseLine(line: string): ReceiveOutcome {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return { kind: 'malformed', detail: 'response is not valid JSON' };
    }
    if (typeof obj !== 'object' || obj === null) {
      return { kind: 'malformed', detail: 'response is not an object' };
    }
    const rec = obj as Record<string, unknown>;
    if (rec.t === 'ok') {
      const decisions = Array.isArray(rec.decisions) ? (rec.decisions as unknown[]) : [];
      return { kind: 'ok', seq: typeof rec.seq === 'number' ? rec.seq : undefined, decisions };
    }
    if (rec.t === 'err') {
      return {
        kind: 'err',
        seq: typeof rec.seq === 'number' ? rec.seq : undefined,
        hook: typeof rec.hook === 'string' ? rec.hook : undefined,
        code: typeof rec.code === 'string' ? rec.code : 'sandbox_crashed',
        detail: typeof rec.detail === 'string' ? rec.detail : '',
      };
    }
    return { kind: 'malformed', detail: `unknown response envelope t=${String(rec.t)}` };
  }
}
