# P3-3 — stdout: per-frame cap вместо lifetime-cumulative

## Проблема

`AsyncIpcChannel` (`apps/backtester/src/engine/sandbox/async-ipc-channel.ts`) считает stdout
**кумулятивно на всю сессию**: `stdoutTotal += chunk.length` (никогда не освобождается) и сравнивает с
`maxStdoutBytes`. Длинная легитимная стратегия, эмитящая `decisions`/`annotate` каждый бар (full-day =
1440 баров/символ), суммарно превышает cap → `overflow` → `sandbox_output_overflow` в середине прогона,
хотя ни один отдельный ответ не был большим. Тот же класс проблемы у stderr: `stderrTotal >
maxStderrBytes * 4` — кумулятивный триггер overflow, диагностика валит прогон.

Обход `EVIDENCE_LONG_SANDBOX` (`maxStdoutBytes: 2 MiB`) — симптоматическое лечение, не устраняет
кумулятивную природу.

Просто поднять/убрать cap нельзя: cap — реальная анти-flood/анти-DoS граница на host-память.

## Модель (по указанию заказчика)

Заменяем один кумулятивный счётчик на два мгновенных лимита + освобождение:

1. **Per-frame cap** — одна NDJSON-строка (завершённый ответ) ≤ `maxDecisionBytes`. Уже есть в
   `receive()`. Без изменений.
2. **Per-buffer cap** — живой неразобранный буфер `stdoutAcc` (байты, без `\n`) ограничен
   `bufferCap = max(maxStdoutBytes, maxDecisionBytes * 2)`. Превышение → `overflow` (fail-closed).
   Проверяется и в `stdout.on('data')` (bound памяти вне pending-`receive`), и в `receive()`.
3. **Освобождение байтов после разбора frame** — `stdoutAcc = stdoutAcc.slice(nl + 1)` уже освобождает
   разобранный ответ. Убираем `stdoutTotal` полностью → суммарный проход за сессию **не ограничен**,
   ограничен только мгновенный размер буфера.
4. **stderr — отдельный ограниченный tail** — `stderrBuf` bounded (первые `maxStderrBytes` +
   `…[truncated]`). Убираем кумулятивный `stderrTotal > maxStderrBytes * 4` overflow-триггер: stderr —
   канал диагностики, он больше **не валит** прогон.
5. **Никакого lifetime-cumulative cap.**

### Выбор `bufferCap = max(maxStdoutBytes, maxDecisionBytes * 2)`

- default: `max(65536, 131072) = 128 KiB` — вмещает один max-frame (64 KiB) + запас.
- evidence_long: `max(2 MiB, 131072) = 2 MiB`.

Легитимный поток (последовательная сессия, один round-trip в полёте) держит в буфере ≤ один ответ
≤ `maxDecisionBytes` < `bufferCap` → overflow **никогда** не срабатывает, длинные прогоны проходят.
Значения политик **не меняются** → detерминированный input-tuple (FR-023) и Docker-goldens byte-identical.

## Таксономия `ReceiveOutcome` (сохранена)

| Ситуация | Код | Изменение |
|---|---|---|
| валидный ответ | `ok`/`okBatch`/`okBarMajor`/`err` | — |
| невалидный JSON (frame с `\n`) | `malformed` | — |
| завершённый frame > `maxDecisionBytes` | `malformed` | — |
| дедлайн / EOF | `timeout` / `eof` | — |
| **живой буфер без `\n` > `bufferCap`** | `overflow` | было `malformed('unterminated')` → теперь `overflow` (flood ≠ frame) |
| **stdout flood > `bufferCap`** | `overflow` | было кумулятивным, теперь мгновенным |
| **stderr flood** | — (bounded tail) | было `overflow`, теперь не фатально |

Терминальный код контейнера при `overflow` (`sandbox_output_overflow`) — тот же.

## Безопасность (анти-DoS сохранён)

Кумулятивный счётчик host-память **не держал** — только ложно валил. Реальная защита памяти —
bound живого буфера (`stdoutAcc`, `stderrBuf`) + контейнерные лимиты (memory cgroup 128 MiB, pids=64,
net=none, wallTime). `bufferCap` ограничивает мгновенный host-буфер → flood по-прежнему fail-closed
через `overflow`.

## Тесты (TDD)

Unit (`async-ipc-channel.test.ts`, `maxDecisionBytes=64, maxStdoutBytes=4096` → `bufferCap=4096`):
1. **длинный корректный прогон** — 200×`ok`-строк, суммарно > 4096 Б, каждая ≤ 64 Б, receive по одной →
   все `ok`, ни одного `overflow`. (RED: старый код валит на ~128-й строке.)
2. **один oversized frame** — строка 200 Б (> 64, < 4096) + `\n` → `malformed` (fail-closed).
3. **поток без newline** — > 4096 Б без `\n` → `overflow` (bounded).
4. **malformed frame** — `not json\n` → `malformed`; oversized-with-newline → `malformed` (таксономия).
5. **stderr flood** — 1025 Б в stderr + валидный `ok` в stdout → `ok` (не `overflow`), `stderrText()` bounded.

Integration (Docker):
6. **N=2/3/64 byte-identical** — существующие equivalence/universe Docker-прогоны остаются зелёными
   (default-путь идентичен).
