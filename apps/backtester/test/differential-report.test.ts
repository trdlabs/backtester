// Гейт переморозки golden'ов проверяется тестом, а не доверием.
//
// Владелец разрешил перемораживать golden'ы только когда изменились ЛИШЬ численные величины.
// Значит цена ошибки здесь несимметрична: ложная остановка стоит одного вопроса владельцу, а
// пропущенное структурное расхождение запекает сломанное поведение в новый эталон навсегда.
// Поэтому проверяется в первую очередь то, что харнесс НЕ пропускает.

import { describe, expect, it } from 'vitest';

import {
  compareArtifacts,
  formatDifferentialReport,
  isIdentityNumber,
  staleExceptions,
} from '../scripts/lib/differential-report.js';

const BASE = {
  status: 'completed',
  orders: [
    { id: 'o1', side: 'long', intent: 'open', status: 'filled', decisionBarIndex: 3 },
    { id: 'o2', side: 'long', intent: 'close', status: 'filled', decisionBarIndex: 9 },
  ],
  fills: [{ orderId: 'o1', fillBarIndex: 4, fillTs: 1_700_000_240_000, fillPrice: 100.12345678, feePaid: 0.05 }],
  trades: [{ side: 'long', entryTs: 1_700_000_240_000, exitTs: 1_700_000_540_000, pnl: 12.3456789 }],
  evidence: { barsProcessed: 600, seed: 12345 },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('differential — деление чисел на величины и тождество', () => {
  it('идентичные артефакты: переморозка разрешена, сдвигов нет', () => {
    const r = compareArtifacts(BASE, clone(BASE));
    expect(r.refreezeAllowed).toBe(true);
    expect(r.numericMoves).toHaveLength(0);
    expect(r.structuralBreaks).toHaveLength(0);
    expect(r.numericLeavesCompared).toBeGreaterThan(0);
  });

  it('сдвиг ВЕЛИЧИНЫ разрешён и зафиксирован', () => {
    const after = clone(BASE);
    after.fills[0]!.fillPrice = 100.12345679;
    const r = compareArtifacts(BASE, after);
    expect(r.refreezeAllowed).toBe(true);
    expect(r.numericMoves).toHaveLength(1);
    expect(r.numericMoves[0]!.path).toBe('fills[0].fillPrice');
    expect(r.numericMoves[0]!.relDelta).toBeLessThan(1e-9);
  });

  it('сдвиг МЕТКИ ВРЕМЕНИ останавливает переморозку', () => {
    const after = clone(BASE);
    after.trades[0]!.exitTs = 1_700_000_600_000;
    const r = compareArtifacts(BASE, after);
    expect(r.refreezeAllowed).toBe(false);
    expect(r.structuralBreaks[0]).toMatchObject({ path: 'trades[0].exitTs', kind: 'identity_number_changed' });
  });

  it('сдвиг ИНДЕКСА БАРА останавливает переморозку', () => {
    const after = clone(BASE);
    after.orders[1]!.decisionBarIndex = 10;
    const r = compareArtifacts(BASE, after);
    expect(r.refreezeAllowed).toBe(false);
    expect(r.structuralBreaks[0]!.kind).toBe('identity_number_changed');
  });

  it('изменение СТОРОНЫ ордера останавливает переморозку', () => {
    const after = clone(BASE);
    after.orders[0]!.side = 'short';
    const r = compareArtifacts(BASE, after);
    expect(r.refreezeAllowed).toBe(false);
    expect(r.structuralBreaks[0]).toMatchObject({ path: 'orders[0].side', kind: 'value_changed' });
  });

  it('изменение ЧИСЛА ордеров останавливает переморозку и не сравнивает разъехавшиеся индексы', () => {
    const after = clone(BASE);
    after.orders.push({ id: 'o3', side: 'short', intent: 'open', status: 'pending', decisionBarIndex: 11 });
    const r = compareArtifacts(BASE, after);
    expect(r.refreezeAllowed).toBe(false);
    expect(r.structuralBreaks).toHaveLength(1);
    expect(r.structuralBreaks[0]).toMatchObject({ path: 'orders', kind: 'array_length_changed' });
  });

  it('счётчик баров — тождество, а не величина', () => {
    const after = clone(BASE);
    after.evidence.barsProcessed = 601;
    expect(compareArtifacts(BASE, after).refreezeAllowed).toBe(false);
  });

  it('пропавшее и появившееся поле — оба структурные', () => {
    const removed = clone(BASE) as Record<string, unknown>;
    delete (removed as { status?: unknown }).status;
    expect(compareArtifacts(BASE, removed).structuralBreaks[0]!.kind).toBe('missing_in_after');
    expect(compareArtifacts(removed, BASE).structuralBreaks[0]!.kind).toBe('missing_in_before');
  });

  it('смена типа листа — структурная, даже если «значение то же»', () => {
    const after = clone(BASE) as Record<string, unknown>;
    (after.evidence as Record<string, unknown>).seed = '12345';
    expect(compareArtifacts(BASE, after).structuralBreaks[0]!.kind).toBe('type_changed');
  });

  it('классификация имён fail-closed: всё похожее на метку/индекс/счётчик — тождество', () => {
    for (const p of ['a.ts', 'a.barTs', 'a.fillTs', 'a.exitTs', 'a.barIndex', 'a.decisionBarIndex', 'a.ordersCount', 'a.evidence.seed', 'a.barsProcessed']) {
      expect(isIdentityNumber(p)).toBe(true);
    }
    for (const p of ['a.fillPrice', 'a.pnl', 'a.equity', 'a.feePaid', 'a.notional', 'a.size']) {
      expect(isIdentityNumber(p)).toBe(false);
    }
  });
});

describe('differential — объявленные исключения', () => {
  it('объявленное расхождение не блокирует переморозку, но остаётся видимым', () => {
    const after = { ...clone(BASE), status: 'rejected' };
    const strict = compareArtifacts(BASE, after);
    expect(strict.refreezeAllowed).toBe(false);

    const declared = compareArtifacts(BASE, after, '', ['status']);
    expect(declared.refreezeAllowed).toBe(true);
    expect(declared.structuralBreaks).toHaveLength(0);
    expect(declared.declaredExceptions).toEqual([
      { path: 'status', before: 'completed', after: 'rejected' },
    ]);
  });

  it('исключение прикрывает ТОЛЬКО названный путь, а не всё подряд', () => {
    const after = clone(BASE);
    after.status = 'rejected';
    after.orders[0]!.side = 'short';
    const r = compareArtifacts(BASE, after, '', ['status']);
    expect(r.refreezeAllowed).toBe(false);
    expect(r.structuralBreaks).toHaveLength(1);
    expect(r.structuralBreaks[0]!.path).toBe('orders[0].side');
  });

  it('протухание считается ПО ВСЕМУ ПРОГОНУ, а не по сценарию', () => {
    // Путь может существовать в одном сценарии и отсутствовать в другом — например `variant.*`
    // есть только там, где есть вариант. Если судить по сценарию, такой путь ложно «протухнет»
    // во всех остальных, и гейт остановит переморозку без причины.
    const moved = { ...clone(BASE), status: 'rejected' };
    const withPath = compareArtifacts(BASE, moved, '', ['status', 'variantOnly']);
    const withoutPath = compareArtifacts({ a: 1 }, { a: 1 }, '', ['status', 'variantOnly']);
    const reports = new Map([['a.json', withPath], ['b.json', withoutPath]]);

    // `status` встретился в одном сценарии — значит не протух.
    // `variantOnly` не встретился нигде — значит протух.
    expect(staleExceptions(reports, ['status', 'variantOnly'])).toEqual(['variantOnly']);
  });

  it('исключение, не встретившееся НИГДЕ, останавливает переморозку', () => {
    const reports = new Map([['a.json', compareArtifacts(BASE, clone(BASE), '', ['status'])]]);
    expect(staleExceptions(reports, ['status'])).toEqual(['status']);
    const md = formatDifferentialReport(reports, { expectChanged: ['status'] });
    expect(md).toContain('Протухшие исключения');
    expect(md).toContain('ОСТАНОВКА');
  });

  it('объявленные исключения печатаются отдельным разделом', () => {
    const after = { ...clone(BASE), status: 'rejected' };
    const md = formatDifferentialReport(new Map([['a.json', compareArtifacts(BASE, after, '', ['status'])]]), {
      expectChanged: ['status'],
    });
    expect(md).toContain('Объявленные исключения');
    expect(md).toContain('`status`');
    expect(md).toContain('"rejected"');
    expect(md).toContain('ПЕРЕМОРОЗКА РАЗРЕШЕНА');
    expect(md).not.toContain('Протухшие исключения');
  });
});

describe('differential — отчёт', () => {
  it('вердикт в заголовке отражает худший сценарий, а не первый', () => {
    const ok = compareArtifacts(BASE, clone(BASE));
    const broken = compareArtifacts(BASE, { ...clone(BASE), status: 'rejected' });
    const md = formatDifferentialReport(new Map([['a.json', ok], ['b.json', broken]]));
    expect(md).toContain('ОСТАНОВКА');
    expect(md).not.toContain('ПЕРЕМОРОЗКА РАЗРЕШЕНА');
    expect(md).toContain('**СТОП**');
  });

  it('пустой набор сценариев — НЕ разрешение: проверять было нечего', () => {
    const md = formatDifferentialReport(new Map());
    expect(md).toContain('ОСТАНОВКА');
    expect(md).not.toContain('ПЕРЕМОРОЗКА РАЗРЕШЕНА');
  });

  it('когда всё чисто — разрешение и перечисление сдвигов', () => {
    const after = clone(BASE);
    after.trades[0]!.pnl = 12.3456788;
    const md = formatDifferentialReport(new Map([['a.json', compareArtifacts(BASE, after)]]));
    expect(md).toContain('ПЕРЕМОРОЗКА РАЗРЕШЕНА');
    expect(md).toContain('trades[0].pnl');
  });
});
