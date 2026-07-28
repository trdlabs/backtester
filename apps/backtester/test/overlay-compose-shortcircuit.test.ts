// Шаг B3: короткое замыкание композиции при нуле оверлеев.
//
// Правка держится на утверждении «при пустом списке compose возвращает ровно {base, []}».
// Проверять надо именно это тождество, а не то, что оба пути «выглядят одинаково»: если compose
// когда-нибудь начнёт делать при пустом списке что-то ещё, тест обязан упасть здесь, а не через
// разъехавшиеся golden'ы.

import { describe, expect, it } from 'vitest';

import { OverlayComposer } from '../src/engine/overlay.js';
import type { StrategyDecision } from '@trading/research-contracts/research';

const BASES: readonly StrategyDecision[] = [
  { kind: 'idle' },
  { kind: 'enter', side: 'long', notional: 100 } as StrategyDecision,
  { kind: 'exit' } as StrategyDecision,
];

describe('OverlayComposer.withoutOverlays', () => {
  it('совпадает с compose на пустом списке для каждой формы решения', async () => {
    const composer = new OverlayComposer();
    for (const base of BASES) {
      const viaCompose = await composer.compose(base, [], async () => {
        throw new Error('getDecision не должен вызываться при пустом списке');
      });
      expect(OverlayComposer.withoutOverlays(base)).toEqual(viaCompose);
    }
  });

  it('отдаёт base без копирования и с пустыми effects', () => {
    const base: StrategyDecision = { kind: 'idle' };
    const out = OverlayComposer.withoutOverlays(base);
    expect(out.finalDecision).toBe(base);
    expect(out.effects).toEqual([]);
    expect(out.error).toBeUndefined();
  });
});
