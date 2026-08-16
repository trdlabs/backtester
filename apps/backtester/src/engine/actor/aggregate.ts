// 083 S3 — сведение нескольких акторов в один результат прогона.
//
// ЧТО ЗДЕСЬ ГЛАВНОЕ. `seq` и `subscriptionId` АКТОР-ЛОКАЛЬНЫ (§3.5, doc у `ActorEnvelope`). У двух
// акторов одного прогона они совпадают по значению и означают РАЗНОЕ: `seq: 7` первого и `seq: 7`
// второго — два разных события. Склеить их потоки в один список, отсортировав по `seq`, значит
// получить правдоподобную ленту, описывающую историю, которой не было.
//
// Поэтому агрегация НЕ перенумеровывает и НЕ сливает: она сохраняет записи раздельно, помечая
// каждую строку `actorId`. Глобальной нумерации здесь не заводится намеренно — она была бы вторым
// идентификатором того же события, и первый же чекпойнт спросил бы, какой из двух настоящий.

import { canonicalJson } from '@trdlabs/engine';

import type { ActorExecutionRecord } from './execution-record.js';
import { projectActorRun, type ActorRunArtifacts } from './projection.js';
import type { ActorTimelineRow } from './timeline.js';

/** Строка объединённого потока: та же строка актора плюс его идентичность. */
export interface AggregatedTimelineRow extends ActorTimelineRow {
  readonly actorId: string;
  readonly symbol: string;
}

export interface AggregatedActorRun {
  /** Артефакты каждого актора, в порядке предъявления записей. */
  readonly perActor: readonly { readonly actorId: string; readonly symbol: string; readonly artifacts: ActorRunArtifacts }[];
  /**
   * Объединённый поток диспетчеризации ВСЕХ акторов.
   *
   * Порядок — `(actorId, seq)`, а не `seq`: сортировка по одному `seq` перемешала бы события разных
   * акторов так, будто они лежат на одной оси, а общей оси у них нет. Внутри одного актора порядок
   * его собственный и непрерывный.
   */
  readonly timeline: readonly AggregatedTimelineRow[];
}

/**
 * Свести записи нескольких акторов.
 *
 * `actorId` обязан быть уникален: два актора с одним идентификатором сделали бы разметку строк
 * бессмысленной — именно она и есть единственное, что не даёт их потокам слиться.
 */
export function aggregateActorRuns(records: readonly ActorExecutionRecord[]): AggregatedActorRun {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.actorId)) {
      throw new Error(
        `агрегация актор-прогонов: actorId '${record.actorId}' встречается дважды. Идентичность — ` +
          'единственное, что различает актор-локальные seq и subscriptionId; при её повторе два ' +
          'разных потока стали бы неотличимы',
      );
    }
    seen.add(record.actorId);
  }

  const perActor = records.map((record) => ({
    actorId: record.actorId,
    symbol: record.symbol,
    artifacts: projectActorRun(record),
  }));

  const timeline: AggregatedTimelineRow[] = [];
  for (const entry of perActor) {
    for (const row of entry.artifacts.timeline) {
      timeline.push({ ...row, actorId: entry.actorId, symbol: entry.symbol });
    }
  }

  return { perActor, timeline };
}

/**
 * Канонический вид объединённого потока — то, что уезжает в evidence.
 *
 * Сериализуется ЦЕЛИКОМ, вместе с разметкой: поток без `actorId` невозможно разобрать обратно, а
 * evidence, который нельзя разобрать, доказывает только факт своего существования.
 */
export function serializeAggregatedTimeline(timeline: readonly AggregatedTimelineRow[]): string {
  return canonicalJson(timeline);
}
