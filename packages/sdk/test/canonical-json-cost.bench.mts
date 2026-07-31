// Цена канонизации артефакта прогона: старый путь против быстрого пути для целых.
//
// Станок раннера этого не видит — он меряет барный цикл, а канонизация происходит при хэшировании
// результата, уже после замера. Между тем артефакт пропорционален числу баров: на 60-тысячебарном
// окне это 60 тыс. записей решений и столько же точек equity, и каждое число идёт через decimal.js.
//
// Обе реализации живут ЗДЕСЬ и сравниваются в одном процессе, чтобы разница не смешалась с
// разницей запусков. Эталон — дословная копия прежнего кода.
import { Decimal } from 'decimal.js';

Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN });
const SCALE = 8;

function quantizeOld(n: number): string {
  if (!Number.isFinite(n)) throw new Error('non-finite');
  let d = new Decimal(n).toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN);
  if (d.isZero()) d = new Decimal(0);
  return d.toFixed();
}

function quantizeNew(n: number): string {
  if (!Number.isFinite(n)) throw new Error('non-finite');
  if (Number.isSafeInteger(n)) return String(n);
  let d = new Decimal(n).toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN);
  if (d.isZero()) d = new Decimal(0);
  return d.toFixed();
}

function makeSerializer(q: (n: number) => string) {
  const ser = (value: unknown): string => {
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'number') return q(value as number);
    if (t === 'boolean') return value === true ? 'true' : 'false';
    if (t === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : ser(v))).join(',')}]`;
    if (t === 'object') {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${ser(obj[k])}`).join(',')}}`;
    }
    throw new Error('unsupported');
  };
  return ser;
}

// Форма артефакта воспроизводит настоящую: записи решений и кривая equity, где почти все числа —
// целые (индекс бара, метка времени), а дробное одно (equity).
const BARS = 60_000;
const T0 = 1_700_000_000_000;
const artifact = {
  decisionRecords: Array.from({ length: BARS }, (_, i) => ({
    barIndex: i,
    barTs: T0 + i * 60_000,
    symbol: 'BTCUSDT',
    hook: 'onBarClose',
    baseDecision: { kind: 'idle' },
    overlayEffects: [],
    finalDecision: { kind: 'idle' },
    riskDecision: null,
  })),
  equityCurve: Array.from({ length: BARS }, (_, i) => ({
    barIndex: i,
    barTs: T0 + i * 60_000,
    equity: 10_000 + (i % 997) * 0.37,
  })),
};

function bench(label: string, fn: () => string): number {
  fn(); // прогрев
  const runs: number[] = [];
  for (let r = 0; r < 3; r += 1) {
    const t0 = process.hrtime.bigint();
    fn();
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  runs.sort((a, b) => a - b);
  console.log(`${label.padEnd(22)} ${runs[0]!.toFixed(0).padStart(6)} мс (мин из 3)`);
  return runs[0]!;
}

const serOld = makeSerializer(quantizeOld);
const serNew = makeSerializer(quantizeNew);

// Тождество на РЕАЛЬНОЙ форме артефакта, а не только на выборке чисел.
const a = serOld(artifact);
const b = serNew(artifact);
console.log(`тождество побайтово: ${a === b ? 'ДА' : 'НЕТ — правка неверна'}`);
if (a !== b) process.exit(1);

const oldMs = bench('старый путь', () => serOld(artifact));
const newMs = bench('быстрый путь', () => serNew(artifact));
console.log(`выигрыш: ×${(oldMs / newMs).toFixed(2)} (${(((oldMs - newMs) / oldMs) * 100).toFixed(1)}%), ` +
  `на прогон в ${BARS} баров это ${(oldMs - newMs).toFixed(0)} мс`);
