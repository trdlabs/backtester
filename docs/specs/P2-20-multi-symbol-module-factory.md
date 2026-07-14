# P2-20 — multi-symbol trusted run requires a moduleFactory (per-symbol isolation)

## Проблема

`simulateTarget` (runner.ts:683-685, symbol-major) и `runBarMajor` (:734-736, bar-major): без
`moduleFactory` один и тот же объект `module` переиспользуется для ВСЕХ символов —

```ts
const symbolStrategy = target.strategy.moduleFactory !== undefined
  ? { ...target.strategy, module: target.strategy.moduleFactory(params) } // fresh per symbol
  : target.strategy;                                                       // REUSE (leak)
```

Symbol-major кормит один инстанс последовательно (module-level state символа 1 сидит на символе 2);
bar-major интерливит все символы через одно замыкание. Следствие: **sandbox-twin** (per-symbol
сессии/контейнеры) расходится с trusted, а флип `barMajor` меняет результат — ломается премиса
«byte-identical per symbol», на которой стоит корректность Slice A/B.

## Решение — blanket fail-fast (решение заказчика)

`runBacktest` **отклоняет** multi-symbol trusted in-process прогон без `moduleFactory`:

```ts
if (request.symbols.length > 1 && strategy.moduleFactory === undefined && strategy.provenance !== 'bundle') {
  return rejected('invalid_module_ref', '…requires a moduleFactory…', '/symbols');
}
```

Решение (user): **всегда** требовать `moduleFactory` при N>1 (даже для stateless-стратегии) — statelessness
не детектируется автоматически, а factory — единственный механизм per-symbol изоляции, симметричный
sandbox-сессиям. `shortAfterPump` (trusted, stateless) получает тривиальную factory.

### Почему bundle exempt

Sandbox-бандлы исполняются per-symbol в отдельных сессиях/контейнерах (изоляция гарантирована
топологией). Guard пропускает `provenance === 'bundle'`. Для этого на engine-`ResolvedStrategy` добавлено
опциональное поле `provenance?: 'trusted' | 'bundle'` (проставляется 019-registry; `createTrustedRegistry`
теперь ставит `'trusted'`).

### Плумбинг factory

- `RegistryInput.strategies` / `RegistryDefinition.strategies` допускают опциональный `moduleFactory`.
- `createTrustedRegistry` пропагирует `moduleFactory` в `ResolvedStrategy` + ставит `provenance:'trusted'`
  (раньше терял factory — потому twin-trusted путь рушился guard'ом).
- `shortAfterPump.moduleFactory` — свежий `{ manifest, onBarClose }` per symbol (stateless → byte-identical).

## Byte-identical

`shortAfterPump` stateless (onBarClose — чистая функция ctx), поэтому factory даёт идентичный вывод:
frozen bar-major golden (non-Docker) держится, single-symbol не меняется. Guard отклоняет ТОЛЬКО
ранее-багованные multi-symbol-trusted-no-factory прогоны (которые молча текли состоянием). result_hash
success-путей не меняется.

## Тесты

- **guard unit** (`multi-symbol-factory-guard.test.ts`, in-process, no Docker): N>1 trusted no-factory →
  `rejected('invalid_module_ref', '/symbols', /moduleFactory/)`; single-symbol no-factory → НЕ reject;
  N>1 с factory → НЕ reject.
- **runner-universe-cap**: test-модуль получил factory (multi-symbol требует её) — cap-логика (maxN) под
  тестом снова достижима.
- **bar-major golden** (non-Docker frozen `result_hash`): держится с factory (trusted byte-identical).
- **Docker twin/universe** (`bar-major-golden`, `bar-major-batch-golden`, `overlay-universe-equivalence`):
  trusted==sandbox под factory — **CI-validated** (WSL2 Docker недоступен в этой сессии; локально
  frozen-golden non-Docker части + логический аргумент подтверждают эквивалентность).
