# Phase 009 — Historical Client in `trading-backtester` Design Spec

**Goal:** Teach `trading-backtester` to fetch OHLCV + funding + open-interest data from `trading-mock-platform`'s `/historical/*` surface instead of private/live providers, enabling full sandbox backtests in demo mode.

**Approach:** Thin Adapter — new `MockPlatformDataPort` that implements the existing `BacktesterDataPort` seam, wired via `BACKTESTER_DATA_SOURCE=mock`.

---

## 1. Architecture

### Files changed

| File | Change |
|------|--------|
| `apps/backtester/src/data/mock-platform-data-port.ts` | CREATE — `MockPlatformDataPort` + `MockPlatformReader` |
| `apps/backtester/src/config.ts` | MODIFY — add `'mock'` to `dataSource` union, add `mockPlatformUrl?` |
| `apps/backtester/src/app.ts` | MODIFY — wire `MockPlatformDataPort` when `dataSource === 'mock'` |
| `apps/backtester/test/mock-platform-data-port.test.ts` | CREATE — unit + integration tests |

### Seam already in place

`BacktesterDataPort` is the stable seam (`apps/backtester/src/data/reader.ts`):

```typescript
interface BacktesterDataPort {
  listDatasets(): Promise<DatasetDescriptor[]>;
  openDataset(ref: string): Promise<HistoricalDatasetReader | undefined>;
}
```

`MockPlatformDataPort` is a third implementation alongside `FixtureDataPort` and `HttpDataPort`. No changes to the seam.

---

## 2. `MockPlatformDataPort` — Public API

```typescript
interface MockPlatformDataPortOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;  // injectable for tests
  readonly pageLimit?: number;     // default 500
}

class MockPlatformDataPort implements BacktesterDataPort {
  listDatasets(): Promise<DatasetDescriptor[]>
  openDataset(ref: string): Promise<MockPlatformReader | undefined>
}

class MockPlatformReader implements HistoricalDatasetReader {
  queryRange(q: RangeQuery): AsyncIterable<ReaderRow[]>
  queryOneSymbolTimeSeries(q: OneSymbolQuery): AsyncIterable<ReaderRow[]>
}
```

---

## 3. Dataset ref format

`"{symbol}:{timeframe}"` — e.g. `"BTCUSDT:1h"`, `"ETHUSDT:4h"`.

One dataset = one symbol × one timeframe. `DatasetDescriptor.symbols = [symbol]`.

---

## 4. Data flow

### `listDatasets()`

1. `GET /historical/coverage` → `HistoricalCoverageSnapshot`
2. If `availability === 'unavailable'` → return `[]`
3. For each `entry` in `snapshot.entries` where `entry.availability === 'available'`:
   ```
   DatasetDescriptor {
     datasetRef: `${entry.symbol}:${entry.timeframe}`,
     symbols:    [entry.symbol],
     timeframe:  entry.timeframe,
     period:     { from: toISO(entry.fromMs), to: toISO(entry.toMs) },
     rowCount:   entry.barCount,
   }
   ```

### `openDataset(ref)`

1. Parse `ref` as `symbol:timeframe` — if malformed → `undefined`
2. `GET /historical/discover` → `HistoricalCapabilityDescriptor`
3. Check `descriptor.symbols.includes(symbol)` — if not → `undefined`
4. Check `descriptor.timeframes.includes(timeframe)` — if not → `undefined`
5. Check bars resource availability != `'unavailable'` — if unavailable → `undefined`
6. Return `new MockPlatformReader(symbol, timeframe, ...)`

### `queryRange(q: { tsFrom, tsTo, symbols? })`

Fetches three streams **in parallel** for the full time range, then merges per-bar:

```
Promise.all([
  fetchAllPages(/historical/bars?symbol=&timeframe=&fromMs=tsFrom&toMs=tsTo),
  fetchAllPages(/historical/funding?symbol=&fromMs=tsFrom&toMs=tsTo),
  fetchAllPages(/historical/open-interest?symbol=&fromMs=tsFrom&toMs=tsTo),
])
```

**Merge strategy:**
- `fundingMap: Map<tsMs → rate>` built from funding entries
- `oiMap: Map<tsMs → openInterestUsd>` built from OI entries
- For each `OhlcvBar`:
  ```
  CanonicalRow {
    symbol,
    minute_ts:            bar.tsMs,
    open, high, low, close, volume: bar.*,
    turnover:             bar.close * bar.volume,  // USDT pair approximation
    funding_rate:         fundingMap.get(bar.tsMs) ?? null,
    has_funding:          fundingMap.has(bar.tsMs),
    oi_total_usd:         oiMap.get(bar.tsMs) ?? null,
    has_oi:               oiMap.has(bar.tsMs),
    taker_buy_volume_usd:  null,
    taker_sell_volume_usd: null,
    has_taker_flow:        false,
  }
  ```
- Yield rows in batches of `pageLimit`

---

## 5. Error handling

| Situation | Behavior |
|-----------|----------|
| `/historical/coverage` → non-2xx | `throw Error("mock-platform coverage: HTTP {status}")` |
| `coverage.availability === 'unavailable'` | `listDatasets()` returns `[]` (soft, no throw) |
| `openDataset('UNKNOWN:1h')` | returns `undefined` |
| resource availability `=== 'unavailable'` in discover | `openDataset()` returns `undefined` |
| `/historical/bars` page → non-2xx | `throw Error("mock-platform bars: HTTP {status}")` |
| `/historical/funding` page → non-2xx | `console.warn` + continue with empty funding map (non-fatal) |
| `/historical/open-interest` page → non-2xx | `console.warn` + continue with empty OI map (non-fatal) |

Bars are the load-bearing data. Funding/OI failures degrade gracefully.

---

## 6. Config changes

### `AppConfig` additions (`config.ts`)

```typescript
readonly dataSource: 'fixture' | 'http' | 'mock';   // was: 'fixture' | 'http'
readonly mockPlatformUrl?: string;                    // required when dataSource === 'mock'
```

### Env vars

| Env var | Example |
|---------|---------|
| `BACKTESTER_DATA_SOURCE=mock` | selects MockPlatformDataPort |
| `BACKTESTER_MOCK_PLATFORM_URL=http://localhost:8839` | base URL |

### `app.ts` wiring (after existing `http` branch)

```typescript
config.dataSource === 'mock' && config.mockPlatformUrl
  ? new MockPlatformDataPort({ baseUrl: config.mockPlatformUrl, pageLimit: config.dataApiPageLimit })
  : /* existing fallback to FixtureDataPort */
```

---

## 7. Testing strategy

### Unit + integration: `mock-platform-data-port.test.ts`

**Test setup:** `beforeAll` starts an in-process Hono fixture server on `127.0.0.1:{random port}` serving:
- `GET /historical/coverage` — 2 entries: `BTCUSDT:1h` (5 bars) + `BTCUSDT:1d` (2 bars)
- `GET /historical/discover` — symbols: `['BTCUSDT']`, timeframes: `['1h', '1d']`
- `GET /historical/bars` — paginates the above fixture bars (pageLimit=2 to exercise pagination)
- `GET /historical/funding` — 3 entries matching bar timestamps
- `GET /historical/open-interest` — 3 entries matching bar timestamps

**Test cases:**
1. `listDatasets()` returns 2 descriptors
2. `listDatasets()` returns `[]` when coverage responds `availability: 'unavailable'`
3. `openDataset('BTCUSDT:1h')` returns a reader
4. `openDataset('BTCUSDT:5m')` returns `undefined` (timeframe not in fixtures)
5. `openDataset('ETHUSDT:1h')` returns `undefined` (symbol not in fixtures)
6. `queryRange()` yields all 5 bars as `CanonicalRow[]`
7. `queryRange()` correctly sets `has_funding=true` for entries with matching timestamp
8. `queryRange()` correctly sets `has_oi=true` for entries with matching timestamp
9. `queryRange()` filters by `tsFrom`/`tsTo`
10. `queryRange()` handles multi-page bar responses (pageLimit=2, 5 bars → 3 pages)

### End-to-end: full backtest via `buildApp`

Uses `buildApp(testConfig({ dataSource: 'mock', mockPlatformUrl }), { dataPort: new MockPlatformDataPort(...) })` and submits a real `RunSubmitRequest`. Asserts the run reaches `completed` status.

---

## 8. Out of scope (Phase 009)

- Taker flow / liquidations merge into `CanonicalRow`
- `trading-lab` orchestration changes
- New backtest algorithms
- Any changes to `trading-mock-platform`

---

## Done when

`trading-backtester` can execute real sandbox backtests (`BACKTESTER_DATA_SOURCE=mock BACKTESTER_MOCK_PLATFORM_URL=http://localhost:8839 pnpm start`) on historical data served by `trading-mock-platform`, all tests pass.
