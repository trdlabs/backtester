// Генератор фикстуры-бандла с УПРАВЛЯЕМОЙ долей баров в позиции.
//
// Зачем. Единственный торговый бандл станка (`short_after_pump`) на синтетической ленте не
// совершает ни одной сделки: ему нужен памп +10% за 20 минут, а лента — случайное блуждание.
// Значит в isolate-режиме станок умел мерить ТОЛЬКО плоский прогон — а плоскость решает, работает
// ли батч 17b (он включается лишь когда нет позиции, нет pending и нет оверлеев).
//
// Из-за этого выигрыш батча на станке — потолок, а не типичное значение. Чтобы получить
// зависимость, а не одну цифру, нужен бандл, у которого доля баров в позиции задаётся: входит
// каждые `entryEvery` баров, выходит через `holdBars`.
//
//   pnpm exec tsx apps/backtester/scripts/make-duty-cycle-bundle.mts <entryEvery> <holdBars> <файл>
//
// Решения детерминированы номером бара и не зависят ни от цены, ни от индикаторов — фикстура меряет
// СТОИМОСТЬ ПУТИ, а не качество стратегии, и не должна зависеть от формы ленты.
import { writeFileSync } from 'node:fs';

// Аргументы проверяются явно: `Number(undefined)` даёт NaN, а `Math.max(2, NaN)` — тоже NaN, и
// генератор молча выпустил бы бандл с идентификатором `duty_cycle_NaN_NaN`. Фикстура, собранная из
// мусора, выглядит как рабочая ровно до момента, когда по ней сделают вывод.
function requireInt(raw: string | undefined, what: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${what}: ожидалось целое >= ${min}, получено ${JSON.stringify(raw)}`);
  }
  return n;
}

const entryEvery = requireInt(process.argv[2], 'entryEvery (аргумент 1)', 2);
const holdBars = requireInt(process.argv[3], 'holdBars (аргумент 2)', 1);
const outPath = process.argv[4] ?? `duty-${entryEvery}-${holdBars}.bundle.json`;
if (holdBars >= entryEvery) {
  throw new Error(`holdBars (${holdBars}) должен быть меньше entryEvery (${entryEvery}) — иначе позиция не закрывается до следующего входа`);
}

const id = `duty_cycle_${entryEvery}_${holdBars}`;

// Модуль самодостаточен внутри module/: никаких импортов (FR-003). Счётчик бара держится в
// замыкании фабрики — по контракту 019 инстанс создаётся на символ, поэтому состояние приватно.
const moduleSource = `// Фикстура станка: вход каждые ${entryEvery} баров, выход через ${holdBars}.
//
// Доля баров в позиции = holdBars / entryEvery. Батч 17b работает только на ПЛОСКИХ участках,
// поэтому эта доля прямо задаёт, сколько баров проходит по дорогому (небатчевому) пути.
export default function createStrategyModule() {
  let bar = -1;
  let sinceEntry = -1;
  return {
    manifest: ${JSON.stringify({ id, version: '0.1.0' })},
    onBarClose() {
      bar += 1;
      if (sinceEntry >= 0) return { kind: 'idle' };
      if (bar % ${entryEvery} === 0) {
        sinceEntry = 0;
        return { kind: 'enter', side: 'long' };
      }
      return { kind: 'idle' };
    },
    onPositionBar() {
      if (sinceEntry < 0) return { kind: 'idle' };
      sinceEntry += 1;
      if (sinceEntry >= ${holdBars}) {
        sinceEntry = -1;
        // Поле target ОБЯЗАТЕЛЬНО по контракту (ExitDecision). Без него решение отвергается
        // схемой, позиция не закрывается, и фикстура тихо вырождается: 600 входов дали одну
        // сделку, потому что после первого входа портфель больше никогда не был flat.
        return { kind: 'exit', target: 'time_exit' };
      }
      return { kind: 'idle' };
    },
  };
}
`;

const bundle = {
  manifest: {
    id,
    version: '0.1.0',
    kind: 'strategy',
    name: `duty cycle ${entryEvery}/${holdBars}`,
    summary: `Вход каждые ${entryEvery} баров, удержание ${holdBars}`,
    rationale: 'Фикстура перф-станка: задаёт долю баров в позиции, не является торговой идеей',
    author: 'agent',
    contractVersion: '017.1',
    status: 'research_only',
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    params: {},
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: false },
    hooks: ['onBarClose', 'onPositionBar'],
    bundleContractVersion: '019.1',
  },
  entry: 'module/index.js',
  files: { 'module/index.js': moduleSource },
};

writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`${outPath}: ${id}, доля баров в позиции ≈ ${((holdBars / entryEvery) * 100).toFixed(0)}%`);
