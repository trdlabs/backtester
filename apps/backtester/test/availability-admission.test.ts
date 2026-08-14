// Д3 3.3в — допуск периода к прогону: две проверки, и разрешает вычисление вторая.

import { describe, expect, it } from 'vitest';
import {
  AdmissionRefusedError,
  admitWindow,
  admissionEvidence,
  confirmWindowStillAdmitted,
  withAdmittedWindow,
  type AdmissionSource,
} from '../src/data/availability-admission';

const FROM = Date.parse('2026-06-10T00:00:00Z');
const TO = Date.parse('2026-06-12T23:59:59.999Z');

const success = (over: Record<string, unknown> = {}) => ({
  ok: true as const,
  requestedFromMs: 0,
  requestedToMs: TO + 5,
  effectiveFromMs: FROM,
  effectiveToMs: TO,
  availableFromMs: FROM,
  availableToMs: TO,
  earliestAvailableDay: '2026-06-10',
  lastContiguousClosedDay: '2026-06-12',
  archiveId: 'arch-1',
  datasetId: 'ds-1',
  availabilityId: `sha256:${'a'.repeat(64)}`,
  asOfMs: 1_000,
  clamped: true,
  ...over,
});

/** Источник, отвечающий по очереди — первая проверка, потом вторая. */
function sourceOf(...responses: unknown[]): AdmissionSource & { calls: Array<[number, number]> } {
  const calls: Array<[number, number]> = [];
  let i = 0;
  return {
    calls,
    async preflight(fromMs: number, toMs: number) {
      calls.push([fromMs, toMs]);
      return (responses[Math.min(i++, responses.length - 1)]) as never;
    },
  };
}

describe('первая проверка — что позволено', () => {
  it('отдаёт effective-период и идентичность решения', async () => {
    const d = await admitWindow(sourceOf(success()), 0, TO + 5);
    expect(d.effectiveFromMs).toBe(FROM);
    expect(d.effectiveToMs).toBe(TO);
    expect(d.clamped).toBe(true);
    // Запрошенное сохраняется как было: иначе в evidence попал бы период,
    // которого никто не просил.
    expect(d.requestedFromMs).toBe(0);
    expect(d.requestedToMs).toBe(TO + 5);
    expect(d.availabilityId).toMatch(/^sha256:/);
  });

  it('отказ платформы доносится вместе с её кодом', async () => {
    const src = sourceOf({ ok: false, code: 'AVAILABILITY_NOT_INITIALIZED', message: 'нет индекса', availabilityState: 'not_initialized' });
    await expect(admitWindow(src, 0, TO)).rejects.toThrow(AdmissionRefusedError);
    await admitWindow(src, 0, TO).catch((e: AdmissionRefusedError) => {
      expect(e.code).toBe('preflight_rejected');
      // Код платформы не схлопывается в «не получилось»: по нему решают, что чинить.
      expect(e.platformCode).toBe('AVAILABILITY_NOT_INITIALIZED');
    });
  });

  it('пустое пересечение отвергается даже если платформа его вернула', async () => {
    // Платформа такого не отдаёт. Но потребитель, доверяющий чужому инварианту
    // без проверки, узнаёт о его нарушении в виде пустого прогона.
    const src = sourceOf(success({ effectiveFromMs: TO, effectiveToMs: FROM, clamped: false }));
    await expect(admitWindow(src, 0, TO)).rejects.toThrow(/empty_effective_window/);
  });
});

describe('вторая проверка — действует ли разрешение сейчас', () => {
  it('спрашивает РОВНО про effective-окно, а не про запрошенное', async () => {
    const src = sourceOf(success(), success({ requestedFromMs: FROM, requestedToMs: TO, clamped: false }));
    const d = await admitWindow(src, 0, TO + 5);
    await confirmWindowStillAdmitted(src, d);
    expect(src.calls[0]).toEqual([0, TO + 5]);
    expect(src.calls[1]).toEqual([FROM, TO]);
  });

  it('расширение индекса законно — availabilityId сверять не требуется', async () => {
    // Ночью закрылся новый день: дайджест индекса другой, разрешение то же.
    const src = sourceOf(
      success(),
      success({
        requestedFromMs: FROM, requestedToMs: TO, clamped: false,
        availabilityId: `sha256:${'b'.repeat(64)}`, asOfMs: 2_000,
        lastContiguousClosedDay: '2026-06-13', availableToMs: TO + 86_400_000,
      }),
    );
    const d = await admitWindow(src, 0, TO + 5);
    const c = await confirmWindowStillAdmitted(src, d);
    expect(c.admittedAvailabilityId).toBe(`sha256:${'b'.repeat(64)}`);
    expect(c.admittedAsOfMs).toBe(2_000);
  });

  it('откат watermark — отказ: окно вернулось обрезанным', async () => {
    const src = sourceOf(
      success(),
      success({ requestedFromMs: FROM, requestedToMs: TO, effectiveToMs: TO - 86_400_000, clamped: true }),
    );
    const d = await admitWindow(src, 0, TO + 5);
    await expect(confirmWindowStillAdmitted(src, d)).rejects.toThrow(/window_no_longer_admitted/);
  });

  it('границы разошлись без флага clamped — тоже отказ', async () => {
    // Отдельная ветка: флаг сообщает НАМЕРЕНИЕ платформы, границы — факт.
    // Совпадать обязаны оба, иначе достаточно было бы соврать флагом.
    const src = sourceOf(
      success(),
      success({ requestedFromMs: FROM, requestedToMs: TO, effectiveToMs: TO - 1, clamped: false }),
    );
    const d = await admitWindow(src, 0, TO + 5);
    await expect(confirmWindowStillAdmitted(src, d)).rejects.toThrow(/границы разошлись/);
  });

  it('повторная проверка отказала — вычисление не начинается', async () => {
    const src = sourceOf(
      success(),
      { ok: false, code: 'AVAILABILITY_EMPTY', message: 'закрытых дней нет', availabilityState: 'empty' },
    );
    const d = await admitWindow(src, 0, TO + 5);
    await expect(confirmWindowStillAdmitted(src, d)).rejects.toThrow(/window_no_longer_admitted/);
  });

  it.each([
    ['archiveId', { archiveId: 'arch-2' }],
    ['datasetId', { datasetId: 'ds-2' }],
  ])('смена %s — отказ: это уже не те данные', async (_field, over) => {
    const src = sourceOf(success(), success({ requestedFromMs: FROM, requestedToMs: TO, clamped: false, ...over }));
    const d = await admitWindow(src, 0, TO + 5);
    await expect(confirmWindowStillAdmitted(src, d)).rejects.toThrow(/identity_changed/);
  });
});

describe('порядок: preflight(requested) → load(effective) → preflight(effective) → compute', () => {
  it('шаги идут в этом порядке и все получают ОДНО effective-окно', async () => {
    const src = sourceOf(success(), success({ requestedFromMs: FROM, requestedToMs: TO, clamped: false }));
    const trace: string[] = [];
    const run = await withAdmittedWindow(src, 0, TO + 5, {
      load: async (eff) => { trace.push(`load ${eff.fromMs}..${eff.toMs}`); return 'данные'; },
      compute: async (eff, loaded, ev) => {
        trace.push(`compute ${eff.fromMs}..${eff.toMs} (${loaded}, admitted=${ev.admittedAsOfMs})`);
        return 'результат';
      },
    });

    expect(src.calls[0]).toEqual([0, TO + 5]);       // requested
    expect(src.calls[1]).toEqual([FROM, TO]);        // effective
    expect(trace).toEqual([
      `load ${FROM}..${TO}`,
      `compute ${FROM}..${TO} (данные, admitted=1000)`,
    ]);
    // Загрузка ПОСЛЕ первой проверки, вычисление ПОСЛЕ второй.
    expect(src.calls.length).toBe(2);
    expect(run.result).toBe('результат');
    expect(run.effective).toEqual({ fromMs: FROM, toMs: TO });
  });

  it('на отказе ВТОРОЙ проверки compute не вызывается вовсе', async () => {
    const src = sourceOf(
      success(),
      success({ requestedFromMs: FROM, requestedToMs: TO, effectiveToMs: TO - 86_400_000, clamped: true }),
    );
    let loaded = false;
    let computed = false;
    await expect(withAdmittedWindow(src, 0, TO + 5, {
      load: async () => { loaded = true; return 1; },
      compute: async () => { computed = true; return 2; },
    })).rejects.toThrow(/window_no_longer_admitted/);

    // Загрузка успела произойти — и её результат отбрасывается. Вычисление и
    // сохранение результата не начинаются: досчитывать «сколько успели» нельзя.
    expect(loaded).toBe(true);
    expect(computed).toBe(false);
  });

  it('на отказе ПЕРВОЙ проверки не вызывается даже загрузка', async () => {
    const src = sourceOf({ ok: false, code: 'AVAILABILITY_INVALID', message: 'битый', availabilityState: 'invalid' });
    let loaded = false;
    await expect(withAdmittedWindow(src, 0, TO, {
      load: async () => { loaded = true; return 1; },
      compute: async () => 2,
    })).rejects.toThrow(/preflight_rejected/);
    expect(loaded).toBe(false);
  });
});

describe('evidence разводит решение и допуск', () => {
  it('первая проверка даёт период и своё availabilityId, вторая — подтверждение', async () => {
    const src = sourceOf(
      success(),
      success({ requestedFromMs: FROM, requestedToMs: TO, clamped: false, availabilityId: `sha256:${'c'.repeat(64)}`, asOfMs: 3_000 }),
    );
    const d = await admitWindow(src, 0, TO + 5);
    const c = await confirmWindowStillAdmitted(src, d);
    const ev = admissionEvidence(d, c);

    expect(ev).toEqual({
      requestedFromMs: 0,
      requestedToMs: TO + 5,
      effectiveFromMs: FROM,
      effectiveToMs: TO,
      clamped: true,
      availabilityId: `sha256:${'a'.repeat(64)}`,
      asOfMs: 1_000,
      admittedAvailabilityId: `sha256:${'c'.repeat(64)}`,
      admittedAsOfMs: 3_000,
      archiveId: 'arch-1',
      datasetId: 'ds-1',
    });
    // Разделяющая проверка: идентичности РАЗНЫЕ. Схлопни их в одно поле — и
    // «на чём решили» стало бы неотличимо от «чем разрешили».
    expect(ev.availabilityId).not.toBe(ev.admittedAvailabilityId);
  });
});
