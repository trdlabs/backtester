// Волна C — сравнение двух наборов артефактов, снятых на одних и тех же замороженных лентах.
//
// Зачем это существует. Волна C единственная двигает golden'ы, и на её время golden'ы перестают
// работать детектором регрессий: при разъехавшихся хешах невозможно отличить ожидаемое численное
// изменение от сломанного поведения. Детектором становится этот отчёт.
//
// Владелец разрешил перемораживать golden'ы (решение 2026-07-28), но разрешение действует только
// когда изменились ЛИШЬ численные величины. Поэтому центральное решение здесь — деление чисел на
// два класса:
//
//   ВЕЛИЧИНЫ  — цены, размеры, комиссии, equity. Им можно двигаться: смена схемы квантизации
//               меняет последний разряд, и это ровно то, ради чего волна затевалась.
//   ТОЖДЕСТВО — метки времени, индексы баров, счётчики, seed. Это НЕ величины, а имена событий.
//               Их сдвиг означает, что поменялась последовательность решений, а не арифметика, —
//               то есть поведение сломано, и переморозка запрещена.
//
// Деление сделано fail-closed: класс ТОЖДЕСТВО определяется по имени поля, и всё, что похоже на
// метку/индекс/счётчик, попадает в него автоматически. Ошибиться безопасно можно только в одну
// сторону — лишнее поле в ТОЖДЕСТВЕ даст ложную остановку, а не молчаливую переморозку.

/** Путь до листа в дереве артефакта, например `orders[3].fillPrice`. */
export type Path = string;

export interface NumericMove {
  readonly path: Path;
  readonly before: number;
  readonly after: number;
  /** |after − before| */
  readonly absDelta: number;
  /** |after − before| / max(|before|, ε) — 0 когда before нулевой и after тоже */
  readonly relDelta: number;
}

export interface StructuralBreak {
  readonly path: Path;
  readonly kind:
    | 'missing_in_after'
    | 'missing_in_before'
    | 'type_changed'
    | 'array_length_changed'
    | 'value_changed'
    | 'identity_number_changed';
  readonly before: unknown;
  readonly after: unknown;
}

export interface DifferentialReport {
  /** Разрешена ли переморозка: структурных расхождений нет. */
  readonly refreezeAllowed: boolean;
  readonly structuralBreaks: readonly StructuralBreak[];
  readonly numericMoves: readonly NumericMove[];
  /** Сколько числовых листьев сравнили всего — знаменатель для «сдвинулось N из M». */
  readonly numericLeavesCompared: number;
}

/**
 * Поля, чьё числовое значение — ТОЖДЕСТВО, а не величина.
 *
 * Проверяется по последнему сегменту пути, регистронезависимо, по суффиксу: `ts`, `barTs`,
 * `fillTs`, `exitTs` — все ловятся суффиксом `ts`; `barIndex`, `decisionBarIndex`,
 * `fillBarIndex` — суффиксом `index`; `ordersCount`, `barsProcessed` — `count`/`processed`.
 */
const IDENTITY_SUFFIXES = ['ts', 'index', 'count', 'seed', 'processed', 'length', 'version'] as const;

export function isIdentityNumber(path: Path): boolean {
  const leaf = lastSegment(path).toLowerCase();
  return IDENTITY_SUFFIXES.some((suffix) => leaf.endsWith(suffix));
}

function lastSegment(path: Path): string {
  // `orders[3].fillPrice` → `fillPrice`; `orders[3]` → `orders`
  const noIndex = path.replace(/\[\d+\]$/, '');
  const dot = noIndex.lastIndexOf('.');
  return dot === -1 ? noIndex : noIndex.slice(dot + 1);
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Сравнить два артефакта. Обход строго параллельный: расхождение формы (ключи, длина массива,
 * тип листа) — уже структурное, потому что артефакт одной и той же ленты обязан иметь одну форму.
 */
export function compareArtifacts(before: unknown, after: unknown, root = ''): DifferentialReport {
  const structuralBreaks: StructuralBreak[] = [];
  const numericMoves: NumericMove[] = [];
  let numericLeavesCompared = 0;

  function walk(a: unknown, b: unknown, path: Path): void {
    const ta = typeOf(a);
    const tb = typeOf(b);
    if (ta !== tb) {
      structuralBreaks.push({ path, kind: 'type_changed', before: a, after: b });
      return;
    }

    if (ta === 'array') {
      const arrA = a as unknown[];
      const arrB = b as unknown[];
      if (arrA.length !== arrB.length) {
        structuralBreaks.push({ path, kind: 'array_length_changed', before: arrA.length, after: arrB.length });
        return; // дальше сравнивать нечего: индексы уже разъехались
      }
      for (let i = 0; i < arrA.length; i += 1) walk(arrA[i], arrB[i], `${path}[${i}]`);
      return;
    }

    if (ta === 'object') {
      const objA = a as Record<string, unknown>;
      const objB = b as Record<string, unknown>;
      const keys = new Set([...Object.keys(objA), ...Object.keys(objB)]);
      for (const key of [...keys].sort()) {
        const childPath = path === '' ? key : `${path}.${key}`;
        const hasA = Object.hasOwn(objA, key);
        const hasB = Object.hasOwn(objB, key);
        if (!hasB) {
          structuralBreaks.push({ path: childPath, kind: 'missing_in_after', before: objA[key], after: undefined });
          continue;
        }
        if (!hasA) {
          structuralBreaks.push({ path: childPath, kind: 'missing_in_before', before: undefined, after: objB[key] });
          continue;
        }
        walk(objA[key], objB[key], childPath);
      }
      return;
    }

    if (ta === 'number') {
      numericLeavesCompared += 1;
      const na = a as number;
      const nb = b as number;
      if (Object.is(na, nb)) return;
      if (isIdentityNumber(path)) {
        // Метка, индекс или счётчик сдвинулся — это смена последовательности событий, а не
        // арифметики. Переморозка запрещена.
        structuralBreaks.push({ path, kind: 'identity_number_changed', before: na, after: nb });
        return;
      }
      const absDelta = Math.abs(nb - na);
      const denom = Math.abs(na);
      numericMoves.push({ path, before: na, after: nb, absDelta, relDelta: denom === 0 ? absDelta : absDelta / denom });
      return;
    }

    // string / boolean / null — величинами не бывают.
    if (a !== b) structuralBreaks.push({ path, kind: 'value_changed', before: a, after: b });
  }

  walk(before, after, root);

  return {
    refreezeAllowed: structuralBreaks.length === 0,
    structuralBreaks,
    numericMoves,
    numericLeavesCompared,
  };
}

/** Отчёт в Markdown — то, что прикладывается к PR переморозки. */
export function formatDifferentialReport(
  reports: ReadonlyMap<string, DifferentialReport>,
  opts: { readonly topMovers?: number } = {},
): string {
  const top = opts.topMovers ?? 20;
  const lines: string[] = [];

  // Пустой набор сценариев — не «всё чисто», а «ничего не проверили». `every` на пустом множестве
  // истинно, поэтому без явной проверки отчёт бы соврал зелёным именно там, где проверки не было.
  if (reports.size === 0) {
    return '## Вердикт: ОСТАНОВКА — ни одного сценария не сравнили\n\nПустой набор не является доказательством: проверять было нечего.\n';
  }

  const allowed = [...reports.values()].every((r) => r.refreezeAllowed);
  lines.push(allowed ? '## Вердикт: ПЕРЕМОРОЗКА РАЗРЕШЕНА' : '## Вердикт: ОСТАНОВКА — нужно решение владельца');
  lines.push('');
  lines.push(
    allowed
      ? 'Во всех сценариях сдвинулись только величины. Последовательность решений, состав ордеров и' +
          ' сделок, индексы баров и метки времени совпали.'
      : 'Есть структурные расхождения: изменилось не только численное значение. Это не переморозка,' +
          ' а изменение поведения — см. таблицу ниже.',
  );
  lines.push('');

  lines.push('| Сценарий | Вердикт | Структурных расхождений | Сдвинулось чисел | Из скольких | Макс. отн. сдвиг |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const [name, r] of reports) {
    const maxRel = r.numericMoves.reduce((m, x) => Math.max(m, x.relDelta), 0);
    lines.push(
      `| \`${name}\` | ${r.refreezeAllowed ? 'ok' : '**СТОП**'} | ${r.structuralBreaks.length} | ` +
        `${r.numericMoves.length} | ${r.numericLeavesCompared} | ${maxRel === 0 ? '—' : maxRel.toExponential(2)} |`,
    );
  }
  lines.push('');

  for (const [name, r] of reports) {
    if (r.structuralBreaks.length === 0) continue;
    lines.push(`### Структурные расхождения — \`${name}\``);
    lines.push('');
    lines.push('| Путь | Что | Было | Стало |');
    lines.push('| --- | --- | --- | --- |');
    for (const b of r.structuralBreaks.slice(0, 200)) {
      lines.push(`| \`${b.path}\` | ${b.kind} | \`${JSON.stringify(b.before)}\` | \`${JSON.stringify(b.after)}\` |`);
    }
    if (r.structuralBreaks.length > 200) lines.push(`| … | ещё ${r.structuralBreaks.length - 200} | | |`);
    lines.push('');
  }

  for (const [name, r] of reports) {
    if (r.numericMoves.length === 0) continue;
    const movers = [...r.numericMoves].sort((x, y) => y.relDelta - x.relDelta).slice(0, top);
    lines.push(`### Крупнейшие численные сдвиги — \`${name}\``);
    lines.push('');
    lines.push('| Путь | Было | Стало | Абс. | Отн. |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const m of movers) {
      lines.push(
        `| \`${m.path}\` | ${m.before} | ${m.after} | ${m.absDelta.toExponential(2)} | ${m.relDelta.toExponential(2)} |`,
      );
    }
    if (r.numericMoves.length > top) lines.push(`| … | ещё ${r.numericMoves.length - top} | | | |`);
    lines.push('');
  }

  return lines.join('\n');
}
