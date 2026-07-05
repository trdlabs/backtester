# Sandbox execution topology — дизайн реализации (backtester core)

**Статус:** дизайн утверждён (2026-06-22). Вход — settled-брифинг `2026-06-22-sandbox-execution-topology-analysis.md` (решение принято, здесь — реализация).
**Scope:** backtester-internal изменения (этот репозиторий). Companion-задачи в `trading-lab` — отдельной спекой/PR, после фиксации контракта (§7).

## 1. Проблема (подтверждено по коду, 2026-06-22)

Demo-путь — это **overlay-engine** (`engine:'overlay'`, `BACKTESTER_ENABLE_OVERLAY_ENGINE=true`):
`worker.ts` → `materializeBundle()` пишет bundle в `os.tmpdir()` (`/tmp/btx-bundle-*`) → overlay-router → `engine/sandbox/sandbox-executor.ts` → `SandboxSession` → `buildDockerRunArgs()` выдаёт два host-bind-mount: `-v <bundleDir>:/sandbox/bundle:ro` и `-v <harnessDir>:/sandbox/harness:ro`.

Когда backtester сам в контейнере и говорит с host-демоном (DooD), демон резолвит `-v` SOURCE на **host-FS**, а не в FS контейнера backtester'а. Эти пути там не существуют → sandbox получает пустые/неверные mount'ы.

**Три конкретных бага** (не два):
1. **Нет `docker` CLI в образе** (`FROM node:22-slim`, без установки) → `spawn docker ENOENT` → процесс падает, run остаётся `submitted`, нет `backtest.completed`.
2. **DooD bind-mount aliasing** — `/tmp/btx-bundle-*` и harness-dir контейнер-локальны; host-демон их не резолвит.
3. **Dockerfile вообще не копирует `sandbox-harness-overlay`** (только legacy `sandbox-harness`), а `_engine/` — gitignored/собираемый. Даже без DooD source overlay-harness'а отсутствует в demo-образе.

**В пользу дизайна:**
- `entry.mjs` читает `/sandbox/bundle/<entryPoint>` и `/sandbox/harness/entry.mjs` **буквально** — если положить нужный контент по этим двум путям, harness **не меняется**.
- Host-Docker — **29.5.3**, значит `docker run --mount type=volume,…,volume-subpath=…,readonly` (Docker ≥25) доступен → монтируем per-run **subpath** одного общего named-тома, сохраняя per-run изоляцию без правок harness'а.
- Legacy `src/sandbox/docker.ts` — отдельный билдер (`buildRunArgs`, монтирует только harness; bundle идёт через stdin), используется **momentum**-путём, не demo. **Вне scope** этой работы (см. §8).

## 2. Решение — `MountSource` абстракция

Вводим discriminated union и заставляем билдер `docker run` ветвиться по нему — это и делает один кодопуть рабочим в обоих режимах:

```ts
export type MountSource =
  | { kind: 'bind';   hostPath: string }                 // dev / host-процесс (сегодняшнее поведение)
  | { kind: 'volume'; volume: string; subpath: string }; // demo / DooD
```

`buildDockerRunArgs` выдаёт для каждого источника:
- **bind** → `-v <hostPath>:/sandbox/bundle:ro` (без изменений)
- **volume** → `--mount type=volume,src=<volume>,dst=/sandbox/bundle,volume-subpath=<subpath>,readonly`

Чистый хелпер `toMountSource(cfg, dir)` (новый модуль `mounts.ts`):
- bind-режим → `{ kind:'bind', hostPath: dir }`
- volume-режим → проверяет, что `dir` под `mountpoint`; `{ kind:'volume', volume, subpath: relative(mountpoint, dir) }`. Если `dir` НЕ под mountpoint — бросаем (программерская ошибка, fail-fast).

**bundle и harness обрабатываются одинаково**: в volume-режиме оба — просто директории под mountpoint'ом тома backtester'а, поэтому один хелпер покрывает оба.

`MountConfig` (передаётся вниз):
```ts
export type MountConfig =
  | { mode: 'bind' }
  | { mode: 'volume'; volume: string; mountpoint: string };
```

## 3. Выбор режима (по env, dev не меняется)

`config.ts` `OverlaySandboxSettings` получает `volume?: string` + `volumeMountpoint?: string` из `BACKTESTER_SANDBOX_OVERLAY_VOLUME` / `BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT`.

- **оба заданы → volume-режим** (demo: compose задаёт оба).
- **ни один → bind-режим** (dev: native host-bind-mount'ы — байт-в-байт текущий путь, регрессии нет).
- задан ровно один → fail-fast при загрузке конфига (мисконфигурация).

## 4. Доставка контента в том

- **Bundle:** `materializeBundle(inline, baseDir?)` получает опциональный `baseDir`. Внутри по-прежнему `mkdtemp('btx-bundle-')` (рандомный per-run суффикс, как сегодня — это путь dir'а, не имя контейнера, FR-024 не затрагивается). volume-режим → `baseDir = <mountpoint>/bundles`; bind-режим → `os.tmpdir()` (как сейчас). Итоговый dir уникален; `subpath` для mount'а считается через `relative(mountpoint, bundleDir)`. `cleanup()` по-прежнему `rm -rf` per-run директории (per-run lifecycle сохранён).
- **Harness:** новый `ensureHarnessInVolume(harnessDir, mountpoint): string` — копирует in-image overlay-harness-дерево в `<mountpoint>/harness/<contentHash>` **один раз, идемпотентно** (skip-if-present), делает world-readable, возвращает in-volume абсолютный путь. `<contentHash>` = хэш дерева harness'а → разные версии backtester'а сосуществуют на общем томе, mount иммутабелен.

Оба пути (bundle и harness) прогоняются через `makeWorldReadable`, чтобы sandbox-пользователь `nobody` (65534) читал `:ro`/`readonly`-mount.

Симметрия: после `ensureHarnessInVolume` эффективный `harnessDir` в volume-режиме = `<mountpoint>/harness/<hash>` (путь под mountpoint'ом), и тот же `toMountSource` превращает его в `volume+subpath`, как и bundle.

## 5. Прокладка (threading)

- `DockerRunOptions`: `{ name, bundle: MountSource, harness: MountSource }` (было `bundleDir`/`harnessDir`).
- `SandboxExecutorDeps` получает `mount: MountConfig` (рядом с `harnessDir`).
- `SandboxSession` получает `MountConfig`; в `open()` вычисляет `bundleMount = toMountSource(mount, this.bundle.bundleDir)` и `harnessMount = toMountSource(mount, this.harnessDir)`, передаёт в `driver.spawnSession`.
- `routing.ts` `createExecutorRouter` пробрасывает `sandboxDeps.mount` в `SandboxModuleExecutor`.
- `worker.ts`:
  - вычисляет `MountConfig` из `deps.overlaySandbox` (volume vs bind).
  - volume-режим: `sandboxBundleFor` материализует bundle в `<mountpoint>/bundles`; `overlayRouterFor` вызывает `ensureHarnessInVolume` (идемпотентно) и подставляет in-volume harness-путь.
  - bind-режим: всё как сейчас (`os.tmpdir()`, in-image harness-путь).

## 6. Lockdown / lifecycle — без изменений

Все флаги (`--network none`, `--read-only`, tmpfs, `--cap-drop ALL`, `--security-opt no-new-privileges`, mem/cpu/pids-лимиты, non-root `--user`, `--disallow-code-generation-from-strings`) и per-run lifecycle (НЕ `--rm`; явный `docker rm -f` в `close()`) сохранены. `--mount …,readonly` — точный эквивалент старого `:ro` для двух контент-mount'ов. **Никакого in-process bypass'а** для research-overlay'ев — изоляция non-negotiable.

## 7. Dockerfile (фиксит баги 1 + 3)

- Ставим современный `docker` CLI: multi-stage `COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker` (только CLI, без демона, версия ≥25 → `volume-subpath`).
- `COPY apps/backtester/sandbox-harness-overlay` (сейчас отсутствует) **и** `COPY apps/backtester/scripts` (билдер `_engine` живёт там; сейчас не копируется), затем сборка `_engine/` в образе (`node apps/backtester/scripts/build-sandbox-harness-overlay.mjs`). Требует `tsc` + type-only research-contracts на этапе build — обеспечить наличие typescript в образе (devDep корня; `pnpm install` без `--prod`, до `ENV NODE_ENV=production`). Альтернатива при сложностях: собрать `_engine` на host и `COPY` готовое дерево (флаг при планировании).

## 8. Файлы (backtester scope)

- `engine/sandbox/docker-driver.ts` — `MountSource`, `DockerRunOptions`, ветвление `buildDockerRunArgs`.
- `engine/sandbox/mounts.ts` (новый) — `MountConfig`, `MountSource`, `toMountSource`.
- `engine/sandbox/harness-volume.ts` (новый) — `ensureHarnessInVolume`.
- `engine/sandbox/bundle-materialize.ts` — опциональный `baseDir`.
- `engine/sandbox/sandbox-session.ts`, `sandbox-executor.ts`, `routing.ts` — проброс `MountConfig`.
- `config.ts` — `volume`/`volumeMountpoint` + env + fail-fast на half-config.
- `jobs/worker.ts` — провод (materialize baseDir, ensureHarnessInVolume, MountConfig).
- `Dockerfile` — docker CLI + overlay-harness + `_engine`.
- **Вне scope:** `src/sandbox/*` (legacy momentum-путь) — остаётся bind-only, НЕ DooD-safe; задокументировано. Demo его не использует.

## 9. Тесты

- **Unit — run-arg construction** (главное):
  - volume-режим: для bundle и harness присутствуют `--mount type=volume,…,volume-subpath=…,readonly`; **нет** host-bind `-v` для bundle/harness; все lockdown-флаги на месте; имя контейнера детерминировано.
  - bind-режим: вывод байт-в-байт сегодняшний (`-v …:ro` для обоих), флаги на месте.
- **Unit — `toMountSource`**: bind→hostPath; volume→корректный subpath; `dir` не под mountpoint → throw; half-config → fail-fast.
- **Unit — `ensureHarnessInVolume`**: копирует при отсутствии, идемпотентен при повторе, world-readable, стабильный `<hash>`.
- **Unit — `materializeBundle(baseDir)`**: пишет под переданный baseDir; cleanup удаляет per-run dir.
- Существующий sandbox-suite (характеризационные/интеграционные) — зелёный.

## 10. Контракт для companion (`trading-lab`, отдельная ветка/PR, после backtester)

- **Имя тома:** `btx-sandbox` (env `BACKTESTER_SANDBOX_OVERLAY_VOLUME`).
- **Mountpoint в backtester:** `/sandbox-shared` (env `BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT`).
- **Сокет:** `/var/run/docker.sock` смонтирован в backtester.
- **Образ:** backtester-образ с docker CLI.
- Lab demo compose (`docker-compose.yml` + `docker-compose.demo.yml`): монтирует сокет + том в сервис `backtester`, задаёт две env-переменные, использует CLI-образ. `OPERATOR_DOWNSTREAM_BACKTESTS=true` уже включён → organic `backtest.completed` → проактивное сообщение оператора без `/tasks`-инъекции.
- Dev-скрипт (minimal-docker): `docker compose up -d postgres redis mock-platform` + app-сервисы как host-процессы с watch (mprocs/concurrently/Procfile), backtester на host → bind-режим, sandbox нативно (без DooD).

## 11. Риски (документируем)

- **Host docker.sock = effective host-root** для контейнера backtester'а. Приемлемо для demo/local; для prod — `dind`-sidecar или реальный sandbox-runtime (gVisor/Kata/Firecracker), note-only, вне scope.
- **Backtester в demo-образе работает как root** (нужно для записи в том; `node:22-slim` без `USER`). Та же граница доверия, что и сокет. Документируем.
- **Docker ≥25 для `volume-subpath`** — требование к demo/prod-хосту. Host сейчас 29.5.3; CLI в образе пинуем ≥25.
- **Производительность — non-goal.** Тёплый/пулинговый sandbox-контейнер — отдельная будущая оптимизация (и безопасна только как «warm container + fresh process + tmpfs reset per run»). Не складываем сюда.

## 12. Acceptance (DoD)

- **demo:** `make demo` (с lab-обвязкой §10) гоняет реальный research-backtest end-to-end — sandbox спавнится sibling-контейнером, стратегия исполняется, backtester постит `backtest-completed` callback, `trading-lab` достигает реального `backtest.completed` (→ `backtest.result_ready` → проактивное сообщение оператора, organically).
- **dev:** backtester host-процессом спавнит sandbox нативно (без DooD), поведение не изменилось.
- Lockdown-флаги + per-run cleanup целы; backtester test-suite зелёный.
