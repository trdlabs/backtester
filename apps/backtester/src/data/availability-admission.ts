// Допуск периода к прогону (Д3, 3.3в) — сторона бэктестера.
//
// ДВЕ ПРОВЕРКИ, И РАЗРЕШАЕТ ВЫЧИСЛЕНИЕ ВТОРАЯ.
//
// Первая отвечает «что мне вообще позволено» и даёт effective-период: только
// его и можно читать. Между загрузкой данных и стартом вычисления проходит
// время — минуты на большом периоде, — и за это время watermark мог откатиться:
// день, считавшийся закрытым, оказался повреждён и был разблокирован обратно.
// Вычисление на данных, допуск к которым уже отозван, даёт результат, который
// выглядит законным и не является им.
//
// Форма второй проверки существенна. Спрашиваем не «тот же ли индекс», а
// «действует ли ещё выданное разрешение»: preflight вызывается РОВНО НА ТОМ
// effective-окне, которое выдала первая проверка, и требуется, чтобы оно
// вернулось неизменным и НЕОБРЕЗАННЫМ. Равенство `availabilityId` не
// требуется — индекс мог расшириться закрытием нового дня, и это законно.
// А вот `archiveId` и `datasetId` обязаны сохраниться: смена первого означает
// другой архив, второго — другую методику агрегации, и в обоих случаях это уже
// не те данные, на которые выдавалось разрешение.

// ФОРМА ОТВЕТА ДОПУСКА ПРИХОДИТ ИЗ SDK и здесь не переобъявляется.
//
// Локальная копия жила тут ровно столько, сколько пин SDK держал движок: версию
// контракта задаёт `@trdlabs/engine` (срез S3, `engine-pin-single-sdk`), а
// приложение обязано упереться в его точный пин, и на engine 0.10.0 / SDK 0.15.0
// `preflight` ещё не существовало. С переездом на 0.15.0 / 0.19.0 копия удалена,
// и не «для чистоты»: две структурно похожие формы расходятся молча. У SDK `code`
// — замкнутый union `PreflightRejectCode`, а не `string`, и есть `status`, по
// которому видно, кто виноват — запрос, момент или сервис. Копия не знала ни
// того, ни другого и приняла бы чужой код за законный отказ.
import type { PreflightRejectCode, PreflightResult } from '@trdlabs/sdk/historical';

/** Источник допуска. Порт бэктестера предоставляет ровно это и ничего больше. */
export interface AdmissionSource {
  preflight(fromMs: number, toMs: number): Promise<PreflightResult>;
}

/** Решение первой проверки. Именно `effective*` определяет, что читать. */
export interface AdmissionDecision {
  readonly requestedFromMs: number;
  readonly requestedToMs: number;
  readonly effectiveFromMs: number;
  readonly effectiveToMs: number;
  readonly clamped: boolean;
  readonly archiveId: string | null;
  readonly datasetId: string | null;
  readonly availabilityId: string;
  readonly asOfMs: number;
}

/** Подтверждение второй проверки. Оно и разрешает вычисление. */
export interface AdmissionConfirmation {
  readonly admittedAvailabilityId: string;
  readonly admittedAsOfMs: number;
  readonly archiveId: string | null;
  readonly datasetId: string | null;
}

export type AdmissionRefusalCode =
  /** Платформа отказала в допуске — код её отказа сохраняется как есть. */
  | 'preflight_rejected'
  /** Пересечение оказалось пустым: читать нечего. */
  | 'empty_effective_window'
  /** Повторная проверка обрезала окно — watermark откатился. */
  | 'window_no_longer_admitted'
  /** Сменился архив или методика агрегации. */
  | 'identity_changed';

/**
 * Отказ допуска. Результат прогона при этом НЕ создаётся: уже загруженные
 * данные отбрасываются, а не досчитываются «сколько успели» — усечённый прогон
 * неотличим от полного по своим числам и потому опаснее отсутствия прогона.
 */
export class AdmissionRefusedError extends Error {
  constructor(
    readonly code: AdmissionRefusalCode,
    message: string,
    /** Код отказа платформы, если отказала она. Замкнутый union из SDK, а не
     *  свободная строка: пять кодов чинят пять разных людей, и «какой-то текст
     *  приехал» не помогает ни одному из них. */
    readonly platformCode?: PreflightRejectCode,
  ) {
    super(`admission refused (${code}): ${message}`);
    this.name = 'AdmissionRefusedError';
  }
}

/** Первая проверка: что позволено. */
export async function admitWindow(
  source: AdmissionSource,
  requestedFromMs: number,
  requestedToMs: number,
): Promise<AdmissionDecision> {
  const res = await source.preflight(requestedFromMs, requestedToMs);
  if (!res.ok) {
    throw new AdmissionRefusedError('preflight_rejected', res.message, res.code);
  }
  if (res.effectiveFromMs > res.effectiveToMs) {
    // Платформа такого не отдаёт — она отвергает пустое пересечение сама. Но
    // потребитель, доверяющий чужому инварианту без проверки, узнаёт о его
    // нарушении не здесь, а в виде пустого прогона.
    throw new AdmissionRefusedError(
      'empty_effective_window',
      `effective окно пусто: [${res.effectiveFromMs}, ${res.effectiveToMs}]`,
    );
  }
  return {
    requestedFromMs: res.requestedFromMs,
    requestedToMs: res.requestedToMs,
    effectiveFromMs: res.effectiveFromMs,
    effectiveToMs: res.effectiveToMs,
    clamped: res.clamped,
    archiveId: res.archiveId,
    datasetId: res.datasetId,
    availabilityId: res.availabilityId,
    asOfMs: res.asOfMs,
  };
}

/**
 * Вторая проверка: действует ли разрешение ПРЯМО СЕЙЧАС.
 *
 * Вызывается после загрузки данных и до старта вычисления.
 */
export async function confirmWindowStillAdmitted(
  source: AdmissionSource,
  decision: AdmissionDecision,
): Promise<AdmissionConfirmation> {
  const res = await source.preflight(decision.effectiveFromMs, decision.effectiveToMs);
  if (!res.ok) {
    throw new AdmissionRefusedError(
      'window_no_longer_admitted',
      `повторная проверка отказала: ${res.message}`,
      res.code,
    );
  }
  // Окно, выданное первой проверкой, обязано вернуться НЕОБРЕЗАННЫМ. Обрезка
  // здесь означает, что доступный интервал сузился, — то есть watermark
  // откатился, и часть уже загруженных данных больше не допущена.
  if (res.clamped) {
    throw new AdmissionRefusedError(
      'window_no_longer_admitted',
      `окно обрезано при повторной проверке: [${res.effectiveFromMs}, ${res.effectiveToMs}]`,
    );
  }
  if (res.effectiveFromMs !== decision.effectiveFromMs || res.effectiveToMs !== decision.effectiveToMs) {
    // Отдельная ветка от `clamped`: флаг сообщает НАМЕРЕНИЕ платформы, границы —
    // факт. Совпадать обязаны оба, иначе достаточно было бы соврать флагом.
    throw new AdmissionRefusedError(
      'window_no_longer_admitted',
      `границы разошлись: было [${decision.effectiveFromMs}, ${decision.effectiveToMs}], ` +
        `стало [${res.effectiveFromMs}, ${res.effectiveToMs}]`,
    );
  }
  if (res.archiveId !== decision.archiveId) {
    throw new AdmissionRefusedError(
      'identity_changed',
      `archiveId сменился: ${String(decision.archiveId)} → ${String(res.archiveId)}`,
    );
  }
  if (res.datasetId !== decision.datasetId) {
    throw new AdmissionRefusedError(
      'identity_changed',
      `datasetId сменился: ${String(decision.datasetId)} → ${String(res.datasetId)}`,
    );
  }
  // `availabilityId` НЕ сверяется намеренно: закрытие нового дня расширяет
  // индекс и меняет его дайджест, не отменяя выданного разрешения. Требовать
  // равенства значило бы ронять каждый прогон, переживший ночное закрытие.
  return {
    admittedAvailabilityId: res.availabilityId,
    admittedAsOfMs: res.asOfMs,
    archiveId: res.archiveId,
    datasetId: res.datasetId,
  };
}

/**
 * Единый effective-запрос. После первой проверки существует ОДНО окно, и им
 * пользуются все: загрузчик, движок, дочерние срезы, evidence.
 *
 * Исходные `requested*` остаются только в аудите. Разнося их по коду, мы
 * получили бы прогон, где загрузчику дали одно окно, движку другое, а в
 * evidence уехало третье — и совпадение всех трёх держалось бы на внимании.
 */
export interface EffectiveRequest {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface AdmittedRun<T> {
  readonly effective: EffectiveRequest;
  readonly decision: AdmissionDecision;
  readonly confirmation: AdmissionConfirmation;
  readonly evidence: AdmissionEvidence;
  readonly result: T;
}

/**
 * Порядок: preflight(requested) → load(effective) → preflight(effective) → compute(effective).
 *
 * Порядок и есть содержание. Загружать до первой проверки значит тянуть данные,
 * на которые может не быть права; считать до второй — считать на данных, право
 * на которые могло быть отозвано, пока шла загрузка.
 *
 * На отказе ВТОРОЙ проверки `compute` не вызывается вовсе: уже загруженные
 * данные отбрасываются, результат прогона не создаётся. Досчитать «сколько
 * успели» нельзя — усечённый прогон по своим числам неотличим от полного.
 */
export async function withAdmittedWindow<L, T>(
  source: AdmissionSource,
  requestedFromMs: number,
  requestedToMs: number,
  steps: {
    load: (effective: EffectiveRequest) => Promise<L>;
    compute: (effective: EffectiveRequest, loaded: L, evidence: AdmissionEvidence) => Promise<T>;
  },
): Promise<AdmittedRun<T>> {
  const decision = await admitWindow(source, requestedFromMs, requestedToMs);
  const effective: EffectiveRequest = { fromMs: decision.effectiveFromMs, toMs: decision.effectiveToMs };

  const loaded = await steps.load(effective);

  // Между загрузкой и вычислением watermark мог откатиться. Проверяем ДО того,
  // как хоть что-то посчитано.
  const confirmation = await confirmWindowStillAdmitted(source, decision);
  const evidence = admissionEvidence(decision, confirmation);

  const result = await steps.compute(effective, loaded, evidence);
  return { effective, decision, confirmation, evidence, result };
}

/** То, что уезжает в evidence прогона. Разведено по источнику: что решено и что подтверждено. */
export interface AdmissionEvidence {
  readonly requestedFromMs: number;
  readonly requestedToMs: number;
  readonly effectiveFromMs: number;
  readonly effectiveToMs: number;
  readonly clamped: boolean;
  /** Идентичность ПЕРВОГО решения. */
  readonly availabilityId: string;
  readonly asOfMs: number;
  /** Идентичность ВТОРОЙ проверки — той, что разрешила вычисление. */
  readonly admittedAvailabilityId: string;
  readonly admittedAsOfMs: number;
  /** Подтверждены обеими проверками. */
  readonly archiveId: string | null;
  readonly datasetId: string | null;
}

export function admissionEvidence(
  decision: AdmissionDecision,
  confirmation: AdmissionConfirmation,
): AdmissionEvidence {
  return {
    requestedFromMs: decision.requestedFromMs,
    requestedToMs: decision.requestedToMs,
    effectiveFromMs: decision.effectiveFromMs,
    effectiveToMs: decision.effectiveToMs,
    clamped: decision.clamped,
    availabilityId: decision.availabilityId,
    asOfMs: decision.asOfMs,
    admittedAvailabilityId: confirmation.admittedAvailabilityId,
    admittedAsOfMs: confirmation.admittedAsOfMs,
    archiveId: confirmation.archiveId,
    datasetId: confirmation.datasetId,
  };
}
