// ГЕЙТ ДРЕЙФА: всё, что рантайм собирает из исходников, обязано собираться и в образе.
//
// Откуда взялся. Харнесс изолята (`sandbox-harness-overlay/_isolate/harness.js`) собирается
// скриптом `build:isolate-harness` и лежит в `.gitignore`. Локально его оставляет `pretest`, и
// образ, собранный на машине разработчика, подхватывал его через `COPY` — выглядело исправно.
// В чистом чекауте (CI, релизная сборка) файла нет, `COPY` копирует пустоту, а Dockerfile его не
// собирал: в образе харнесса не оказывалось, и бэкенд `BACKTESTER_SANDBOX_BACKEND=isolate` падал бы
// на первом прогоне. Проверено прямым опытом — сборка с убранным из контекста `_isolate/` дала
// образ без него.
//
// Ловушка общая, а не про изолят: любой gitignored артефакт, нужный в рантайме, попадает в образ
// либо потому, что Dockerfile его СОБИРАЕТ, либо потому, что он случайно оказался в контексте
// сборки. Второе неотличимо от первого до тех пор, пока кто-нибудь не соберёт из чистого чекаута.
//
// Поэтому гейт сверяет не текст Dockerfile с ожидаемым списком, а ДВА ИСТОЧНИКА: скрипты
// `build:*` в package.json и команды `RUN` в Dockerfile. Появится новый харнесс — тест напомнит о
// Dockerfile сам, без чьей-либо памяти.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const dockerfile = readFileSync(resolve(REPO_ROOT, 'Dockerfile'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** Скрипты, собирающие рантайм-артефакты песочницы. Каждый обязан быть и в образе. */
const HARNESS_BUILD_SCRIPTS = Object.entries(pkg.scripts).filter(([name]) => /^build:.*harness/.test(name));

describe('Dockerfile — рантайм-артефакты собираются в образе, а не подбираются из контекста', () => {
  it('в package.json вообще есть скрипты сборки харнессов (иначе тест ничего не проверяет)', () => {
    // Без этой проверки переименование скриптов превратило бы гейт в пустой цикл, который всегда
    // зелёный. Пустой список — не «нечего проверять», а сломанный гейт.
    expect(HARNESS_BUILD_SCRIPTS.length).toBeGreaterThanOrEqual(2);
  });

  it.each(HARNESS_BUILD_SCRIPTS)('Dockerfile собирает артефакт скрипта %s', (name, command) => {
    // Сверяется путь к скрипту, а не имя npm-скрипта: Dockerfile зовёт `node <путь>` напрямую,
    // потому что на этом шаге образа pnpm-скрипты рабочего пространства ещё не нужны.
    const scriptPath = command.match(/(apps\/backtester\/scripts\/[\w.-]+\.mjs)/)?.[1];
    expect(scriptPath, `скрипт ${name} не похож на запуск файла из apps/backtester/scripts`).toBeDefined();
    expect(
      dockerfile.includes(scriptPath!),
      `Dockerfile не запускает ${scriptPath} — артефакт попадёт в образ только с машины, где он уже собран`,
    ).toBe(true);
  });

  it('артефакты харнессов действительно gitignored — иначе гейт защищает от несуществующей проблемы', () => {
    // Если артефакты когда-нибудь закоммитят, `COPY` станет достаточным, и требование собирать их
    // в образе превратится в лишнюю работу. Тогда этот тест и надо будет пересмотреть — а пока он
    // фиксирует, что основание для него в силе.
    const gitignore = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain('sandbox-harness-overlay/_isolate/');
    expect(gitignore).toContain('sandbox-harness-overlay/_engine/');
  });
});
