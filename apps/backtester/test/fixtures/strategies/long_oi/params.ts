/**
 * 026 Long OI StrategyModule — настраиваемые параметры (LongOiParams) + JSON Schema + DEFAULT_PARAMS.
 *
 * Чистый модуль: только типы и константы, без I/O (без fs/crypto/path), без runtime-импорта
 * `src/bots/**`/`config.ts` (forbidden-boundary, см. contracts/forbidden-boundary.md).
 *
 * **Pinned source of truth (A1):** дефолты перенесены КАК ЯВНЫЕ TS-КОНСТАНТЫ из
 * `src/bots/long_oi/config.ts makeLongOiBotConfig()` (env-fallback'и = check-time дефолты —
 * env не подставляется в check-прогоне). После 026 этот файл — единственный авторитет дефолтов
 * модуля; «legacy-derived» нигде не остаётся неявным. Полная таблица значений+источников —
 * contracts/params-schema.md. TP/exit/защита/DCA/fail_fast — ПАРАМЕТРЫ, не хардкод (clarify 2026-06-09).
 *
 * **НЕ воспроизводятся** (host-owned sizing → диагностируются как `sizing_model_delta`):
 * `risk.notionalUsd`/`baseOrderUsd`/`leverage`, весь `riskScoreScaler.*`, `failFast.entryGate.*`.
 */

// ───────────────────────────────────────────────────────────────────────────
// §5 TpLadderConfig — TP-пороги + параметрический TP1 (026 NEW)
// ───────────────────────────────────────────────────────────────────────────

/** Действие на TP1: legacy ≡ `milestone_only`; дефолт 026 = `partial_exit`. */
export type Tp1Action = 'milestone_only' | 'partial_exit' | 'full_exit';

export interface TpLadderConfig {
  /** Порог TP1 (% от avgEntry). */
  tp1Pct: number;
  /** Порог TP2 / полный выход (% от avgEntry). */
  tp2Pct: number;
  /** Поведение на достижении TP1 (026 NEW; параметрично). */
  tp1Action: Tp1Action;
  /** Доля частичного выхода на TP1 при `tp1Action='partial_exit'`; (0,100]. */
  tp1ExitPercent: number;
}

// ───────────────────────────────────────────────────────────────────────────
// §6 ProtectionConfig — движение защиты (BE/trailing)
// ───────────────────────────────────────────────────────────────────────────

/** Режим trailing-стопа. Legacy: trailing отсутствует. 026: сделан возможным, off by default. */
export type TrailingMode = 'off';

export interface ProtectionConfig {
  /** Сдвиг защиты в безубыток после TP1 (BE = `ctx.position.entryPrice`, без fee/slippage — A2). */
  moveProtectionToBEAfterTp1: boolean;
  /** Trailing-режим (off by default; configurable per US7). */
  trailing: TrailingMode;
}

// ───────────────────────────────────────────────────────────────────────────
// §7 DcaConfig — DCA-доливки
// ───────────────────────────────────────────────────────────────────────────

/** Пороги переподтверждения перед DCA-доливкой (OI/bounce/green). */
export interface DcaReconfirmConfig {
  /** Мин. отскок от нового локального лоу (% — `dca.minBouncePctFromNewLow`). */
  minBouncePctFromNewLow: number;
  /** Мин. восстановление OI за 2м (`dca.minOiRecoveryPct2m`). */
  minOiRecoveryPct2m: number;
  /** Требуемое число зелёных свечей (`dca.requireGreenCandles`). */
  requireGreenCandles: number;
  /** Порог быстрого отскока (% — `dca.fastBouncePct`). */
  fastBouncePct: number;
}

export interface DcaConfig {
  /** Макс. число доливок; `≥0`; `≤ RiskProfile.dcaLimits.maxAdds` (host). */
  maxAdds: number;
  /** Пороги падения от last-entry для каждой доливки (% — legacy uniform `minDropFromLastEntryPct`). */
  dropPcts: number[];
  /** Пороги переподтверждения. */
  reconfirm: DcaReconfirmConfig;
  /** Множители размера доливок — ТОЛЬКО `sizingHint` (host equity-fraction авторитетен). */
  sizeMultipliers: number[];
}

// ───────────────────────────────────────────────────────────────────────────
// §8 FailFastConfig — защитный ранний выход (pre-TP1)
// ───────────────────────────────────────────────────────────────────────────

export interface FailFastConfig {
  /** Включён ли fail-fast (default-off). */
  enabled: boolean;
  /** Мин. число свечей после входа до оценки. */
  minCandlesAfterEntry: number;
  /** Макс. дрейф close за 3 свечи (% — отрицательный). */
  maxCloseDrift3Pct: number;
  /** Макс. суммарные зелёные тела за 2 свечи (%). */
  maxSumGreenBodies2Pct: number;
  /** Пропустить fail-fast, если отскок от entry превысил (%). */
  skipIfBounceFromEntryPct: number;
  /** Композитный drift-критерий включён (default-off). */
  driftCompositeEnabled: boolean;
  /** Мягкий порог дрейфа для композита (%). */
  compositeDriftSoftPct: number;
  /** Мин. убыток vs entry для композита (%). */
  compositeMinLossPctVsEntry: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Entry/dump/watch/oi/liq/warmup
// ───────────────────────────────────────────────────────────────────────────

/** Режим триггера dump-детекта. */
export type DumpTriggerMode = 'high_to_low' | 'open_to_close';

export interface DumpConfig {
  /** Окно поиска dump (минут). */
  lookbackMin: number;
  /** Мин. падение для срабатывания dump (%). */
  minDropPct: number;
  /** Режим триггера. */
  triggerMode: DumpTriggerMode;
  /** high_to_low: мин. удержание close (%). */
  highToLowMinCloseHoldPct: number;
  /** high_to_low: макс. зелёный recovery-отскок (%). */
  highToLowMaxGreenRecoveryBouncePct: number;
  /** high_to_low: макс. позиция close в диапазоне (%). */
  highToLowMaxClosePosInRangePct: number;
}

export interface WatchConfig {
  /** Таймаут watch (минут) → COOLDOWN. */
  maxMinutes: number;
  /** Длительность COOLDOWN после таймаута (минут). */
  cooldownMinutes: number;
}

export interface EntryConfig {
  /** Мин. отскок от лоу для входа (%). */
  minBouncePctFromLow: number;
  /** Требуемое число зелёных ценовых свечей. */
  requireGreenPriceCandles: number;
  /** Порог быстрого входа (%). */
  fastBouncePct: number;
}

export interface OiFilterConfig {
  /** Мин. восстановление OI за 2м для входа. */
  entryMinOiRecoveryPct2m: number;
}

export interface LiqFilterConfig {
  /** Окно поиска ликвидаций (минут). */
  lookbackMin: number;
  /** Мин. USD long-ликвидаций. */
  minLongLiqUsd: number;
  /** Требовать наличие ликвидации для входа. */
  requireLiquidation: boolean;
  /** Мин. отношение long-liq к OI (%). */
  minLongLiqOiRatioPct: number;
}

export interface WarmupConfig {
  /** Мин. число свечей до начала торговли. */
  candlesMin: number;
  /** Макс. возраст сигнала (минут). */
  maxSignalAgeMin: number;
  /** Макс. отскок от лоу на warmup (%). */
  maxBounceFromLowPct: number;
  /**
   * Ts первой «живой» свечи. Runtime-поле: приходит через `ctx.params` (pinned в config snapshot),
   * зеркалит `SymbolState.live.firstLiveCandleTs`. В DEFAULT_PARAMS отсутствует (заполняется хостом).
   */
  firstLiveCandleTs?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// §3 LongOiParams — корневой объект параметров модуля
// ───────────────────────────────────────────────────────────────────────────

export interface LongOiParams {
  /** TP-ладдер (§5). */
  tpLadder: TpLadderConfig;
  /** Hard-stop (% против avgEntry). */
  hardStopPct: number;
  /** Time-exit (минут в позиции). */
  maxHoldMin: number;
  /** Движение защиты (§6). */
  protection: ProtectionConfig;
  /** DCA (§7). */
  dca: DcaConfig;
  /** Fail-fast (§8). */
  failFast: FailFastConfig;
  /** Dump-детект. */
  dump: DumpConfig;
  /** Watch/cooldown. */
  watch: WatchConfig;
  /** Подтверждение входа. */
  entry: EntryConfig;
  /** OI-фильтр входа. */
  oiFilter: OiFilterConfig;
  /** Liq-фильтр входа. */
  liqFilter: LiqFilterConfig;
  /** Warmup-пропуск сигналов. */
  warmup: WarmupConfig;
}

// ───────────────────────────────────────────────────────────────────────────
// DEFAULT_PARAMS — pinned порт из config.ts makeLongOiBotConfig() (A1)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Начальная унифицированная стратегия. Значения — точный порт env-fallback'ов
 * `makeLongOiBotConfig()` (см. contracts/params-schema.md «Источник»). TP1 параметрический:
 * дефолт = `partial_exit` 50% + BE = entryPrice (clarify 2026-06-09).
 */
export const DEFAULT_PARAMS: LongOiParams = {
  tpLadder: {
    tp1Pct: 3.5, // exit.tp1Pct
    tp2Pct: 5, // exit.tp2Pct
    tp1Action: 'partial_exit', // 026 NEW (legacy ≡ milestone_only)
    tp1ExitPercent: 50, // 026 NEW
  },
  hardStopPct: 12, // exit.hardStopPct
  maxHoldMin: 180, // exit.maxHoldMin
  protection: {
    moveProtectionToBEAfterTp1: true, // exit.moveStopToBEAfterTp1
    trailing: 'off', // 026 NEW
  },
  dca: {
    maxAdds: 2, // dca.maxCount
    dropPcts: [3, 3], // dca.minDropFromLastEntryPct (uniform, per-add)
    reconfirm: {
      minBouncePctFromNewLow: 0.5, // dca.minBouncePctFromNewLow
      minOiRecoveryPct2m: 0.005, // dca.minOiRecoveryPct2m
      requireGreenCandles: 2, // dca.requireGreenCandles
      fastBouncePct: 2.0, // dca.fastBouncePct
    },
    sizeMultipliers: [1.2, 1.5], // risk.dca1/dca2NotionMultiplier (sizingHint only)
  },
  failFast: {
    enabled: false, // failFast.enabled
    minCandlesAfterEntry: 2, // failFast.minCandlesAfterEntry
    maxCloseDrift3Pct: -1.5, // failFast.maxCloseDrift3Pct
    maxSumGreenBodies2Pct: 0.75, // failFast.maxSumGreenBodies2Pct
    skipIfBounceFromEntryPct: 1.25, // failFast.skipIfBounceFromEntryPct
    driftCompositeEnabled: false, // failFast.driftCompositeEnabled
    compositeDriftSoftPct: -1.2, // failFast.compositeDriftSoftPct
    compositeMinLossPctVsEntry: -2.3, // failFast.compositeMinLossPctVsEntry
  },
  dump: {
    lookbackMin: 20, // dump.lookbackMin
    minDropPct: 10, // dump.minDropPct
    triggerMode: 'high_to_low', // dump.triggerMode
    highToLowMinCloseHoldPct: 6, // dump.highToLowMinCloseHoldPct
    highToLowMaxGreenRecoveryBouncePct: 3.5, // dump.highToLowMaxGreenRecoveryBouncePct
    highToLowMaxClosePosInRangePct: 55, // dump.highToLowMaxClosePosInRangePct
  },
  watch: {
    maxMinutes: 40, // watch.maxMinutes
    cooldownMinutes: 20, // watch.cooldownMinutes
  },
  entry: {
    minBouncePctFromLow: 0.6, // entry.minBouncePctFromLow
    requireGreenPriceCandles: 2, // entry.requireGreenPriceCandles
    fastBouncePct: 2.5, // entry.fastBouncePct
  },
  oiFilter: {
    entryMinOiRecoveryPct2m: 0.05, // entry.minOiRecoveryPct2m
  },
  liqFilter: {
    lookbackMin: 8, // entry.liqLookbackMin
    minLongLiqUsd: 10, // entry.minLongLiqUsd
    requireLiquidation: true, // entry.requireLiquidation
    minLongLiqOiRatioPct: 0.02, // entry.minLongLiqOiRatioPct
  },
  warmup: {
    candlesMin: 30, // warmup.candlesMin
    maxSignalAgeMin: 5, // warmup.maxSignalAgeMin
    maxBounceFromLowPct: 5, // warmup.maxBounceFromLowPct
    // firstLiveCandleTs — runtime via ctx.params
  },
};

// ───────────────────────────────────────────────────────────────────────────
// paramsSchema — JSON Schema (draft-07) для 017-валидатора манифеста (fail-closed)
// ───────────────────────────────────────────────────────────────────────────

/**
 * JSON Schema `LongOiParams`. Объявляется в манифесте (T005). Перечисляет ≥ ручек FR-025
 * (DCA-пороги/число/размер, % TP1, правила TP2, BE, trailing, fail_fast, entry-confirmation, OI/liq).
 * Ключевые ограничения: tp1ExitPercent∈(0,100], tp1Action∈enum, maxAdds≥0, tp1Pct/tp2Pct/hardStopPct/maxHoldMin>0.
 */
export const paramsSchema: object = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: [
    'tpLadder',
    'hardStopPct',
    'maxHoldMin',
    'protection',
    'dca',
    'failFast',
    'dump',
    'watch',
    'entry',
    'oiFilter',
    'liqFilter',
    'warmup',
  ],
  properties: {
    tpLadder: {
      type: 'object',
      additionalProperties: false,
      required: ['tp1Pct', 'tp2Pct', 'tp1Action', 'tp1ExitPercent'],
      properties: {
        tp1Pct: { type: 'number', exclusiveMinimum: 0 },
        tp2Pct: { type: 'number', exclusiveMinimum: 0 },
        tp1Action: { type: 'string', enum: ['milestone_only', 'partial_exit', 'full_exit'] },
        tp1ExitPercent: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
      },
    },
    hardStopPct: { type: 'number', exclusiveMinimum: 0 },
    maxHoldMin: { type: 'number', exclusiveMinimum: 0 },
    protection: {
      type: 'object',
      additionalProperties: false,
      required: ['moveProtectionToBEAfterTp1', 'trailing'],
      properties: {
        moveProtectionToBEAfterTp1: { type: 'boolean' },
        trailing: { type: 'string', enum: ['off'] },
      },
    },
    dca: {
      type: 'object',
      additionalProperties: false,
      required: ['maxAdds', 'dropPcts', 'reconfirm', 'sizeMultipliers'],
      properties: {
        maxAdds: { type: 'integer', minimum: 0 },
        dropPcts: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 } },
        reconfirm: {
          type: 'object',
          additionalProperties: false,
          required: ['minBouncePctFromNewLow', 'minOiRecoveryPct2m', 'requireGreenCandles', 'fastBouncePct'],
          properties: {
            minBouncePctFromNewLow: { type: 'number', minimum: 0 },
            minOiRecoveryPct2m: { type: 'number', minimum: 0 },
            requireGreenCandles: { type: 'integer', minimum: 0 },
            fastBouncePct: { type: 'number', minimum: 0 },
          },
        },
        sizeMultipliers: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 } },
      },
    },
    failFast: {
      type: 'object',
      additionalProperties: false,
      required: [
        'enabled',
        'minCandlesAfterEntry',
        'maxCloseDrift3Pct',
        'maxSumGreenBodies2Pct',
        'skipIfBounceFromEntryPct',
        'driftCompositeEnabled',
        'compositeDriftSoftPct',
        'compositeMinLossPctVsEntry',
      ],
      properties: {
        enabled: { type: 'boolean' },
        minCandlesAfterEntry: { type: 'integer', minimum: 0 },
        maxCloseDrift3Pct: { type: 'number' },
        maxSumGreenBodies2Pct: { type: 'number' },
        skipIfBounceFromEntryPct: { type: 'number' },
        driftCompositeEnabled: { type: 'boolean' },
        compositeDriftSoftPct: { type: 'number' },
        compositeMinLossPctVsEntry: { type: 'number' },
      },
    },
    dump: {
      type: 'object',
      additionalProperties: false,
      required: [
        'lookbackMin',
        'minDropPct',
        'triggerMode',
        'highToLowMinCloseHoldPct',
        'highToLowMaxGreenRecoveryBouncePct',
        'highToLowMaxClosePosInRangePct',
      ],
      properties: {
        lookbackMin: { type: 'integer', exclusiveMinimum: 0 },
        minDropPct: { type: 'number', exclusiveMinimum: 0 },
        triggerMode: { type: 'string', enum: ['high_to_low', 'open_to_close'] },
        highToLowMinCloseHoldPct: { type: 'number' },
        highToLowMaxGreenRecoveryBouncePct: { type: 'number' },
        highToLowMaxClosePosInRangePct: { type: 'number' },
      },
    },
    watch: {
      type: 'object',
      additionalProperties: false,
      required: ['maxMinutes', 'cooldownMinutes'],
      properties: {
        maxMinutes: { type: 'integer', exclusiveMinimum: 0 },
        cooldownMinutes: { type: 'integer', minimum: 0 },
      },
    },
    entry: {
      type: 'object',
      additionalProperties: false,
      required: ['minBouncePctFromLow', 'requireGreenPriceCandles', 'fastBouncePct'],
      properties: {
        minBouncePctFromLow: { type: 'number', minimum: 0 },
        requireGreenPriceCandles: { type: 'integer', minimum: 0 },
        fastBouncePct: { type: 'number', minimum: 0 },
      },
    },
    oiFilter: {
      type: 'object',
      additionalProperties: false,
      required: ['entryMinOiRecoveryPct2m'],
      properties: {
        entryMinOiRecoveryPct2m: { type: 'number', minimum: 0 },
      },
    },
    liqFilter: {
      type: 'object',
      additionalProperties: false,
      required: ['lookbackMin', 'minLongLiqUsd', 'requireLiquidation', 'minLongLiqOiRatioPct'],
      properties: {
        lookbackMin: { type: 'integer', exclusiveMinimum: 0 },
        minLongLiqUsd: { type: 'number', minimum: 0 },
        requireLiquidation: { type: 'boolean' },
        minLongLiqOiRatioPct: { type: 'number', minimum: 0 },
      },
    },
    warmup: {
      type: 'object',
      additionalProperties: false,
      required: ['candlesMin', 'maxSignalAgeMin', 'maxBounceFromLowPct'],
      properties: {
        candlesMin: { type: 'integer', minimum: 0 },
        maxSignalAgeMin: { type: 'integer', minimum: 0 },
        maxBounceFromLowPct: { type: 'number', minimum: 0 },
        firstLiveCandleTs: { type: 'number' },
      },
    },
  },
};
