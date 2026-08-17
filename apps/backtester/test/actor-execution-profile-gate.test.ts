// 083 S3 — ГЕЙТ ПРОФИЛЯ ИСПОЛНЕНИЯ: whitelist по образцу риска (решение владельца 2026-08-17).
//
// ═══ ЧТО ЭТОТ ГЕЙТ ЗАКРЫВАЕТ ═══
//
// У РИСК-профиля whitelist стоял с самого начала: правило, которого actor-путь не исполняет,
// отвергает прогон, а не исполняется молча в усечённом виде. У профиля ИСПОЛНЕНИЯ такого гейта не
// было, и асимметрия стоила ровно того, чего гейт риска не допускает:
//
//   из профиля в actor-путь доезжают ТОЛЬКО `feeModel.bps` и `slippageModel.bps`;
//   `fillModel` не доезжает вовсе, и налив идёт по открытию СЛЕДУЮЩЕГО бара.
//
// Прогон, объявивший `same_bar_close`, считался по другой цене, чем заказано, — и числа при этом
// выглядели совершенно законными. Расхождение видел только тот, кто сравнил бы объявленное с
// исполненным, а сравнивать было нечем.
//
// ═══ ЧЕГО ГЕЙТ НЕ ДЕЛАЕТ ═══
//
// Он не меняет поведение дефолтного пути ни на бит: `DEFAULT_EXEC` объявляет `next_bar_open` —
// ровно то, что дорога и делает. Гейт закрывает РАСХОЖДЕНИЕ, а не наливку.

import { describe, expect, it } from 'vitest';

import { unsupportedExecutionRules } from '../src/engine/actor/production.js';
import type { ExecutionProfileShape } from '../src/engine/actor/production.js';
import { DEFAULT_EXEC } from '../src/engine/profiles.js';

const base: ExecutionProfileShape = {
  id: 'probe_exec',
  version: '1.0.0',
  fillModel: { kind: 'next_bar_open' },
  feeModel: { kind: 'fixed_bps', bps: 10 },
  slippageModel: { kind: 'fixed_bps', bps: 5 },
};

describe('поставляемый профиль исполнения проходит', () => {
  it('DEFAULT_EXEC исполним actor-путём — дефолт не сдвинулся', () => {
    // Первая проба файла и самая важная: гейт, отвергающий дефолт, сломал бы каждый actor-прогон.
    expect(unsupportedExecutionRules(DEFAULT_EXEC as ExecutionProfileShape)).toEqual([]);
  });
});

describe('объявленное, но неисполняемое — ОТКАЗ, а не молчание', () => {
  it('same_bar_close отвергается: дорога наливает по следующему открытию', () => {
    // Тот самый случай. Прежде он проезжал молча и давал числа по ДРУГОЙ цене.
    expect(unsupportedExecutionRules({ ...base, fillModel: { kind: 'same_bar_close' } })).toEqual([
      'fillModel.kind=same_bar_close',
    ]);
  });

  it('fundingModel отвергается: начисления actor-путь не делает вовсе', () => {
    // Прогон под ним посчитался бы БЕЗ фандинга, и разница ушла бы прямо в pnl.
    const withFunding = { ...base, fundingModel: { kind: 'per_minute_prorate', intervalHours: 8 } };
    expect(unsupportedExecutionRules(withFunding)).toEqual(['fundingModel']);
  });

  it('незнакомое правило отвергается ВСЕГДА — whitelist, а не список запрещённого', () => {
    // Список запрещённого пропустил бы каждое правило, которого мы сегодня не предвидели, — то
    // есть ровно те, что появятся позже.
    const exotic = { ...base, borrowModel: { kind: 'flat' } } as unknown as ExecutionProfileShape;
    expect(unsupportedExecutionRules(exotic)).toEqual(['borrowModel']);
  });
});

describe('знакомое правило с непригодным ЗНАЧЕНИЕМ тоже отвергается', () => {
  it('чужая модель комиссии: у неё может не быть bps вовсе', () => {
    expect(
      unsupportedExecutionRules({ ...base, feeModel: { kind: 'maker_taker' } }),
    ).toEqual(['feeModel.kind=maker_taker']);
  });

  it('fixed_bps с NaN: каждое сравнение с ним ложно, и стоимость молча выключена', () => {
    // Тот же класс, что `maxPositionNotionalPct: NaN` у риска: `typeof === 'number'` проходит, а
    // арифметика даёт NaN во всём прогоне.
    expect(
      unsupportedExecutionRules({ ...base, slippageModel: { kind: 'fixed_bps', bps: Number.NaN } }),
    ).toEqual(['slippageModel.bps=NaN']);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: годное значение не отвергается', () => {
    // Иначе пробы выше зеленели бы у реализации, отвергающей вообще всё.
    expect(unsupportedExecutionRules({ ...base, slippageModel: { kind: 'fixed_bps', bps: 0 } })).toEqual([]);
  });
});
