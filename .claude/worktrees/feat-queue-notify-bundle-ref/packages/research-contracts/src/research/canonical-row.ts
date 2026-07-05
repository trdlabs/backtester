/**
 * CanonicalRow v1 — авторитетная on-disk форма финализированного minute snapshot'а
 * для исторического хранилища (010-historical-market-storage).
 *
 * v1 — заморожен на 16 полях (immutable). 028 ввёл additive `CanonicalRowV2`
 * (schema_version=2, +taker buy/sell/has_taker_flow — см. ниже) через новое
 * под-дерево, без in-place миграции v1 partitions; reader v1∪v2.
 *
 * Forbidden fields см. specs/010-historical-market-storage/contracts/canonical-row.md
 * §Forbidden fields. Никаких per-exchange OI/liquidation, derived ratios, strategy
 * signals, execution events или raw payload'ов. delta выводится из buy/sell (не
 * колонка); cumulative-агрегаты не хранятся.
 */

export const SCHEMA_VERSION = 1 as const;

export interface CanonicalRow {
  readonly schema_version: 1;
  /** ms UTC, выровнено по началу минуты: (minute_ts % 60_000) === 0. */
  readonly minute_ts: number;
  /** Нормализованный (normSymbol): trim + upper-case ASCII. */
  readonly symbol: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly turnover: number;
  /** Aggregated OI для (symbol, minute_ts) в USD; null если has_oi=false. */
  readonly oi_total_usd: number | null;
  /** Aggregated funding (8h-equivalent), live-forward с 027; null если has_funding=false (включая 0/<0 как валидные). Партиции до 027 остаются null (immutability). */
  readonly funding_rate: number | null;
  /** Total long liquidations для bucket'а [minute_ts, minute_ts+60_000); null если has_liquidations=false. */
  readonly liq_long_usd: number | null;
  /** Total short liquidations для bucket'а [minute_ts, minute_ts+60_000); null если has_liquidations=false. */
  readonly liq_short_usd: number | null;
  readonly has_oi: boolean;
  /** true ⇔ fundingSourceCount>=1 (027); различает present-zero/negative от missing. */
  readonly has_funding: boolean;
  readonly has_liquidations: boolean;
}

/**
 * Exhaustive list канонических полей. Используется verify_historical_no_derived_fields.mjs
 * для machine-checkable schema-purity verification (FR-007, SC-007).
 */
export const CANONICAL_ROW_FIELDS = [
  'schema_version',
  'minute_ts',
  'symbol',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'turnover',
  'oi_total_usd',
  'funding_rate',
  'liq_long_usd',
  'liq_short_usd',
  'has_oi',
  'has_funding',
  'has_liquidations',
] as const;

export type CanonicalRowField = typeof CANONICAL_ROW_FIELDS[number];

/**
 * CanonicalRow v2 — первый additive bump on-disk схемы (028-raw-taker-flow).
 *
 * v1 (16 полей) остаётся frozen и immutable: writer пишет v2 в отдельное
 * под-дерево `schema_version=2/`, v1-партиции не трогаются (immutability by
 * construction). Reader становится v1∪v2-aware (v1 → taker null/false, без 0).
 *
 * v2 строго additive OPTIONAL: 16 v1-полей + raw taker buy/sell + has_taker_flow.
 * Канон хранит только raw scalars: taker delta выводится из buy и sell при
 * чтении (lossless, не колонка); накопительные taker-агрегаты — downstream,
 * не хранятся. Per-exchange/derived поля по-прежнему запрещены в каноне.
 */

export const SCHEMA_VERSION_V2 = 2 as const;

export interface CanonicalRowV2 {
  readonly schema_version: 2;
  /** ms UTC, выровнено по началу минуты: (minute_ts % 60_000) === 0. */
  readonly minute_ts: number;
  /** Нормализованный (normSymbol): trim + upper-case ASCII. */
  readonly symbol: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly turnover: number;
  /** Aggregated OI для (symbol, minute_ts) в USD; null если has_oi=false. */
  readonly oi_total_usd: number | null;
  /** Aggregated funding (8h-equivalent); null если has_funding=false (включая 0/<0 как валидные). */
  readonly funding_rate: number | null;
  /** Total long liquidations для bucket'а [minute_ts, minute_ts+60_000); null если has_liquidations=false. */
  readonly liq_long_usd: number | null;
  /** Total short liquidations для bucket'а [minute_ts, minute_ts+60_000); null если has_liquidations=false. */
  readonly liq_short_usd: number | null;
  readonly has_oi: boolean;
  readonly has_funding: boolean;
  readonly has_liquidations: boolean;
  /** Cross-source SUM taker BUY quote-объёма; null если has_taker_flow=false. */
  readonly taker_buy_volume_usd: number | null;
  /** Cross-source SUM taker SELL quote-объёма; null если has_taker_flow=false. */
  readonly taker_sell_volume_usd: number | null;
  /** true ⇔ takerSourceCount>=1; различает present-zero/negative от missing. */
  readonly has_taker_flow: boolean;
}

/**
 * Exhaustive list канонических полей v2 (19). Используется
 * verify_historical_no_derived_fields.mjs для schema-purity verification под v2.
 */
export const CANONICAL_ROW_V2_FIELDS = [
  'schema_version',
  'minute_ts',
  'symbol',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'turnover',
  'oi_total_usd',
  'funding_rate',
  'liq_long_usd',
  'liq_short_usd',
  'has_oi',
  'has_funding',
  'has_liquidations',
  'taker_buy_volume_usd',
  'taker_sell_volume_usd',
  'has_taker_flow',
] as const;

export type CanonicalRowV2Field = typeof CANONICAL_ROW_V2_FIELDS[number];
