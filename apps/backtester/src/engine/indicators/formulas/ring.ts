// Кольцевое окно фиксированного размера для потоковых формул.
//
// Заменяет пару `push()` + `shift()`: `Array.shift` сдвигает весь хвост, то есть окно длины
// `period` стоило O(period) на каждый бар. Кольцо пишет в одну ячейку.
//
// Единственное, что здесь важно, — `forEachOldestFirst` обходит элементы В ТОМ ЖЕ ПОРЯДКЕ, что
// прежний массив: от самого старого к самому свежему. Порядок обхода — не деталь реализации, а
// часть контракта: суммирование в SMA идёт по возрастанию индекса байт-в-байт как legacy
// `smaAsOf`, и любая перестановка слагаемых сдвинула бы значение в последнем разряде.

export class RingWindow {
  private readonly buf: Float64Array;
  private head = 0; // индекс самого старого элемента
  private len = 0;

  constructor(private readonly capacity: number) {
    // Нулевая или дробная ёмкость дала бы `% 0` → NaN во всех значениях, то есть тихо испорченный
    // индикатор вместо ошибки. Массив на её месте вёл себя иначе, поэтому граница проверяется здесь.
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`RingWindow: ёмкость должна быть целой ≥ 1, получено ${capacity}`);
    }
    this.buf = new Float64Array(capacity);
  }

  /** Число элементов в окне (≤ capacity). */
  get length(): number {
    return this.len;
  }

  /** Добавить элемент; при переполнении самый старый вытесняется — как `push` + `shift`. */
  push(x: number): void {
    if (this.len < this.capacity) {
      this.buf[(this.head + this.len) % this.capacity] = x;
      this.len += 1;
      return;
    }
    this.buf[this.head] = x;
    this.head = (this.head + 1) % this.capacity;
  }

  /** Элемент по логическому индексу: 0 — самый старый. */
  at(i: number): number {
    return this.buf[(this.head + i) % this.capacity];
  }

  /** Сумма от самого старого к самому свежему — тот же порядок слагаемых, что и в массиве. */
  sum(): number {
    let s = 0;
    for (let i = 0; i < this.len; i += 1) s += this.buf[(this.head + i) % this.capacity];
    return s;
  }
}
