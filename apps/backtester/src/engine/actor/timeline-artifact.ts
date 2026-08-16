// 083 S3 — поток диспетчеризации КАК ОТДЕЛЬНЫЙ АРТЕФАКТ, связанный с прогоном целостностью
// (ADR-0014).
//
// ═══ ПОЧЕМУ НЕ КЛЮЧ В EVIDENCE ═══
//
// Решение принято ADR-0014 и здесь только исполняется, но одну его половину стоит держать перед
// глазами: `resultHash = contentRef(payload)`, где payload — весь `RunOutcome`. Любое поле,
// доехавшее до него, попадает в хеш прогона И в ответ `/result`. Поток растёт ЛИНЕЙНО по числу
// событий: на прогоне в сотни тысяч баров он на порядки больше остального результата. Поэтому он
// уезжает в artifact store отдельным объектом, а в результате остаётся ссылка.
//
// ═══ ЧТО ИМЕННО СВЯЗЫВАЕТ АРТЕФАКТ С ПРОГОНОМ ═══
//
// Хеш содержимого, а не договорённость. Стор content-addressed: `artifactId` И ЕСТЬ `sha256:` от
// канонической сериализации. Из этого хочется заключить, что сверять нечего — ссылка не может
// указывать на другое содержимое по построению.
//
// ЭТО НЕВЕРНО, и разница практическая. `FileArtifactStore.read` открывает файл по имени, равному
// hex'у хеша, и отдаёт то, что в нём лежит. Никто не проверяет, что прочитанное всё ещё хешируется
// в своё имя. Подменённый на диске файл вернётся молча — и прогон будет объяснён потоком, который
// ему не принадлежит. Content-addressing даёт адрес, а не гарантию; гарантию даёт ПЕРЕСЧЁТ.
//
// Отсюда `assertActorTimelineIntegrity`: ссылка разрешается, содержимое читается, его хеш
// пересчитывается и сверяется. Гейт является ЧАСТЬЮ решения, а не улучшением к нему (ADR-0014 §3):
// без него появляются две истины о прогоне, и потерю одной из них не видно по результату.
//
// И этого всё ещё МАЛО. Пересчёт доказывает, что артефакт самосогласован — что он не подменён на
// диске. Самосогласован и чужой артефакт: поток того же актора из повторного прогона той же
// конфигурации имеет свой честный хеш, свои дескрипторы, столько же строк — и другое содержимое.
// Поэтому сверяется не только «прочитанное отвечает своему адресу», но и «адрес принадлежит
// ОЖИДАЕМОМУ документу»: `contentRef(ожидаемый) === artifactId`. Первое — про хранилище, второе —
// про то, ТОТ ЛИ поток объясняет прогон.
//
// ═══ ПОЧЕМУ ДОКУМЕНТ, А НЕ ГОЛЫЙ МАССИВ СТРОК ═══
//
// `ActorTimelineArtifact` — это `ActorTimelineRow[]`, и в нём НЕТ ни идентификатора актора, ни
// дескрипторов подписок. Пока актор один, это выглядит достаточным и таковым не является:
//
//   • строки называют `subscriptionId`, но не называют, ЧЕМ он был разрешён. Дескрипторы живут в
//     `ActorInit.subscriptions`, и без них `sub-req-candles` в потоке — просто строка;
//   • при нескольких акторах (ступень 1 multi-symbol) два потока с пересекающимися `seq`
//     склеились бы в одну историю, и разделить их было бы нечем: `seq` актор-локален.
//
// Второе — не гипотеза о будущем, а свойство уже написанного: `actorId` объявлен обязательным в
// `ActorExecutionRecord` ровно по этой причине. Артефакт, теряющий его при сериализации, вернул бы
// дефект, который запись уже закрыла.

import type { ArtifactReference, ContentHash } from '@trdlabs/backtester-sdk/artifacts';
import type { ActorSubscriptionDescriptor } from '@trdlabs/sdk/research-contract';

import { contentRef } from '../../determinism/hash.js';
import type { ArtifactStore } from '../../artifacts/store.js';
import type { ActorExecutionRecord } from './execution-record.js';
import { projectActorTimeline, type ActorTimelineArtifact } from './timeline.js';

/** Тип артефакта в манифесте и в `artifactRefs`. Одно объявление на запись и на сверку. */
export const ACTOR_TIMELINE_ARTIFACT_TYPE = 'actor-timeline';

/**
 * Документ потока одного актора — то, что реально уезжает в стор и хешируется.
 *
 * Идентичность актора и дескрипторы подписок лежат ЗДЕСЬ, а не выводятся читателем: артефакт обязан
 * объяснять прогон сам по себе, без доступа к тому, что его породило.
 */
export interface ActorTimelineDocument {
  readonly actorId: string;
  readonly symbol: string;
  /** Тот же список, что уехал в `ActorInit.subscriptions`, включая канонический хостовый источник. */
  readonly subscriptions: readonly ActorSubscriptionDescriptor[];
  readonly rows: ActorTimelineArtifact;
}

/** Отказ гейта целостности. Отдельный класс: чинит его тот, кто отвечает за хранилище, а не за поток. */
export class ActorTimelineIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActorTimelineIntegrityError';
  }
}

function fail(message: string): never {
  throw new ActorTimelineIntegrityError(message);
}

/**
 * Построить документ из записи прогона.
 *
 * Проекция потока вызывается внутри (`projectActorTimeline`), а она, в свою очередь, проверяет
 * поток гардами. Записать непроверенный поток значило бы положить в стор форму, про которую никто
 * не утверждал, что она связна, — и связать её с прогоном хешем, то есть придать ей вес.
 */
export function buildActorTimelineDocument(record: ActorExecutionRecord): ActorTimelineDocument {
  if (record.actorId.trim() === '') {
    fail('запись прогона без actorId: поток нечем отличить от потока другого актора');
  }
  if (record.subscriptions.length === 0) {
    fail(
      `актор ${record.actorId}: пустой список подписок — subscriptionId строк потока не с чем ` +
        'сопоставить, и артефакт перестаёт объяснять сам себя',
    );
  }
  return {
    actorId: record.actorId,
    symbol: record.symbol,
    subscriptions: record.subscriptions,
    rows: projectActorTimeline(record.timeline, record.frontiers),
  };
}

/**
 * Записать документы в стор и вернуть ссылки.
 *
 * Порядок ссылок — по `actorId`, а не по порядку предъявления: манифест прогона обязан быть
 * функцией содержимого, иначе два одинаковых прогона дают разные манифесты из-за того, в каком
 * порядке хост обошёл символы.
 */
export async function persistActorTimelines(
  store: ArtifactStore,
  documents: readonly ActorTimelineDocument[],
): Promise<readonly ArtifactReference[]> {
  const ordered = [...documents].sort((a, b) => a.actorId.localeCompare(b.actorId));
  const refs: ArtifactReference[] = [];
  for (const doc of ordered) {
    const contentHash = await store.write(doc);
    refs.push({
      artifactId: contentHash,
      artifactType: ACTOR_TIMELINE_ARTIFACT_TYPE,
      availability: 'available',
      approxItemCount: doc.rows.length,
    });
  }
  return refs;
}

/**
 * ГЕЙТ ЦЕЛОСТНОСТИ (ADR-0014 §3). Обязателен, а не рекомендован.
 *
 * Для каждой ссылки: разрешить, прочитать, ПЕРЕСЧИТАТЬ хеш прочитанного и сверить с записанным.
 * Сверка идёт с тем, что реально вернул стор, — не с тем, что мы туда клали: сравнение документа с
 * самим собой прошло бы и на пустом хранилище.
 *
 * Отказы намеренно не сведены в один: «артефакта нет», «содержимое подменено», «поток чужого
 * актора», «дескрипторы не те», «строк не столько» и, замыкающим, «ссылка указывает не на тот
 * документ» чинятся разными людьми, и общее сообщение отправило бы диагноста искать не там.
 *
 * ПОРЯДОК ПРОВЕРОК НОРМАТИВЕН, а не косметичен — обоснование у замыкающей сверки.
 */
export async function assertActorTimelineIntegrity(
  store: ArtifactStore,
  refs: readonly ArtifactReference[],
  expected: readonly ActorTimelineDocument[],
): Promise<void> {
  const timelineRefs = refs.filter((r) => r.artifactType === ACTOR_TIMELINE_ARTIFACT_TYPE);
  if (timelineRefs.length !== expected.length) {
    fail(
      `ссылок на поток ${timelineRefs.length}, а акторов ${expected.length} — ` +
        'прогон объяснён не полностью, и по результату этого не видно',
    );
  }

  const byActor = new Map(expected.map((d) => [d.actorId, d]));

  for (const ref of timelineRefs) {
    const id = ref.artifactId as ContentHash;

    if (!(await store.has(id))) {
      fail(`артефакт потока ${id} отсутствует в хранилище — ссылка есть, содержимого нет`);
    }

    let raw: unknown;
    try {
      raw = await store.read(id);
    } catch (cause) {
      fail(`артефакт потока ${id} не читается: ${(cause as Error).message}`);
    }

    // ГЛАВНАЯ СТРОКА ФАЙЛА. Стор content-addressed, и соблазн ей пренебречь силён: «ссылка и есть
    // хеш, читать нечего». Но `read` отдаёт содержимое файла, а не доказательство, что файл всё ещё
    // своё имя оправдывает. Подменённый на диске артефакт вернётся молча.
    const actual = contentRef(raw);
    if (actual !== id) {
      fail(
        `артефакт потока ${id} подменён: хеш прочитанного содержимого ${actual}. ` +
          'Content-addressing даёт адрес, но не гарантию — гарантию даёт пересчёт',
      );
    }

    const doc = raw as ActorTimelineDocument;
    const mine = byActor.get(doc.actorId);
    if (mine === undefined) {
      fail(
        `артефакт ${id} принадлежит актору «${doc.actorId}», которого в этом прогоне нет ` +
          `(есть: ${[...byActor.keys()].join(', ')}) — ссылка указывает на чужой поток`,
      );
    }
    // Идентичность актора и дескрипторы обязаны ПЕРЕЖИТЬ сериализацию. Проверяется каноническим
    // сравнением, а не поштучно: список дескрипторов — часть контракта `ActorInit`, и потеря даже
    // хостового источника сделала бы половину событий потока беспризорной.
    if (contentRef(doc.subscriptions) !== contentRef(mine.subscriptions)) {
      fail(
        `актор ${doc.actorId}: дескрипторы подписок в артефакте не совпадают с теми, с которыми ` +
          'актор был создан — subscriptionId строк потока сопоставлять не с чем',
      );
    }
    if (doc.rows.length !== mine.rows.length) {
      fail(
        `актор ${doc.actorId}: в артефакте ${doc.rows.length} строк потока против ${mine.rows.length} ` +
          'в прогоне',
      );
    }

    // ЗАМЫКАЮЩАЯ СВЕРКА: ссылка обязана указывать на ОЖИДАЕМЫЙ ДОКУМЕНТ ЦЕЛИКОМ.
    //
    // Всё предыдущее сверяло артефакт с прогоном по ОТДЕЛЬНЫМ признакам: чей это поток, те ли
    // дескрипторы, столько ли строк. Каждый признак закрывает свой способ подмены, и ни один не
    // закрывает главный: самосогласованный поток ТОГО ЖЕ актора той же конфигурации — скажем, из
    // повторного прогона — совпадает по всем трём и отличается СОДЕРЖИМЫМ строк. Он проходил бы
    // гейт, и прогон был бы объяснён потоком, который ему не принадлежит: ровно те «две истины»,
    // ради которых гейт и заведён (ADR-0014 §3).
    //
    // Сверка идёт с ОЖИДАЕМЫМ документом, а не с прочитанным. `contentRef(raw) === id` выше
    // доказывает только, что артефакт не подменён НА ДИСКЕ, то есть самосогласован; самосогласована
    // и любая чужая правда.
    //
    // ПОЧЕМУ ЭТО ПОСЛЕДНЯЯ ПРОВЕРКА, А НЕ ПЕРВАЯ. Она строго сильнее трёх предыдущих: вместе с
    // `contentRef(raw) === id` она даёт `contentRef(raw) === contentRef(mine)`, то есть полное
    // равенство документов. Поставленная выше, она отняла бы у тех трёх все их случаи — они стали
    // бы ветками с недостижимым условием, то есть перестали бы проверять что-либо, продолжая
    // выглядеть проверками. Здесь же каждая из них — более точный диагноз своего подмножества, а
    // эта замыкает остаток. Порядок трогать нельзя.
    //
    // На честном пути сверка тавтологична: `id` вернул `store.write(mine)`, а он и есть
    // `contentRef(mine)`. Тавтологичность — свойство ЧЕСТНОГО пути, а не проверки; проверка ровно
    // про то, был ли путь честным.
    const expectedId = contentRef(mine);
    if (expectedId !== id) {
      fail(
        `актор ${doc.actorId}: ссылка ${id} указывает не на тот документ — артефакт самосогласован ` +
          `и принадлежит тому же актору, но это не поток ЭТОГО прогона (его хеш ${expectedId})`,
      );
    }

    byActor.delete(doc.actorId);
  }

  if (byActor.size > 0) {
    fail(`потоки акторов не сохранены: ${[...byActor.keys()].join(', ')}`);
  }
}
