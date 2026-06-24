// 019 — DockerDriver (US2; research R1, contracts/sandbox-ipc-protocol; FR-016/017/018).
//
// Построение `docker run`-команды со ВСЕМИ флагами изоляции/квот из SandboxPolicy и spawn контейнера
// через встроенный node:child_process (без dockerode). Граница безопасности — флаги ядра (network none,
// read-only rootfs, tmpfs, memory/cpus/pids, cap-drop ALL, no-new-privileges, non-root user, env НЕ
// пробрасывается, bundle/harness только :ro). Имя контейнера — детерминированное (без wall-clock/random).
//
// IPC асинхронен: AsyncIpcChannel потребляет child.stdin/stdout/stderr напрямую как потоки.
// Драйвер возвращает живой child-процесс; close() закрывает stdin через сам стрим (child.stdin.destroy()).

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SandboxPolicy } from '../sandbox-policy.js';
import type { MountSource } from './mounts.js';

/** Спавненный контейнер: имя + живой docker-CLI child-процесс (его стримы потребляет AsyncIpcChannel). */
export interface SpawnedContainer {
  readonly name: string;
  readonly child: ChildProcessWithoutNullStreams;
}

/** Параметры запуска контейнера сессии: имя + источники mount'ов bundle/harness. */
export interface DockerRunOptions {
  readonly name: string;
  readonly bundle: MountSource;   // → /sandbox/bundle:ro
  readonly harness: MountSource;  // → /sandbox/harness:ro
}

/** Привести произвольную строку к допустимому фрагменту docker-имени ([a-zA-Z0-9_.-]). */
export function dockerSanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

/**
 * Детерминированное имя контейнера сессии: `sbx-<runId>-<moduleId>-<version>-<symbol>` (+ опц. суффикс).
 * Без wall-clock/random (FR-024). Усечено до разумной длины.
 */
export function sessionContainerName(
  runId: string,
  moduleId: string,
  version: string,
  symbol: string,
  suffix?: string,
): string {
  const raw = `sbx-${runId}-${moduleId}-${version}-${symbol}${suffix !== undefined ? `-${suffix}` : ''}`;
  return dockerSanitize(raw).slice(0, 200);
}

/** Сформировать `-v host:dst:ro` (bind) или `--mount …,volume-subpath=…,readonly` (volume). */
function mountArgs(src: MountSource, dst: string): readonly string[] {
  if (src.kind === 'bind') return ['-v', `${src.hostPath}:${dst}:ro`];
  return ['--mount', `type=volume,src=${src.volume},dst=${dst},volume-subpath=${src.subpath},readonly`];
}

/** Построить аргументы `docker run …` из политики (контракт sandbox-ipc-protocol §docker-инвокация). */
export function buildDockerRunArgs(policy: SandboxPolicy, opts: DockerRunOptions): readonly string[] {
  const { isolation: iso, limits } = policy;
  // NB: НЕ '--rm' — контейнер остаётся в 'exited' до явного `docker rm -f` (close()), чтобы host мог
  // прочитать .State.OOMKilled/.ExitCode для различения sandbox_memory_exceeded vs sandbox_crashed (T031).
  return [
    'run', '-i',
    '--name', opts.name,
    '--network', iso.network,
    '--read-only',
    '--tmpfs', `/tmp:rw,noexec,nosuid,size=${iso.tmpfsSizeBytes}`,
    '--memory', String(limits.memoryBytes),
    '--memory-swap', String(limits.memoryBytes),
    '--cpus', String(limits.cpus),
    '--pids-limit', String(iso.pidsLimit),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', iso.user,
    // env НЕ пробрасывается (нет -e) ⇒ секреты не наследуются (FR-017)
    ...mountArgs(opts.bundle, '/sandbox/bundle'),
    ...mountArgs(opts.harness, '/sandbox/harness'),
    iso.image,
    'node', '--disallow-code-generation-from-strings', '/sandbox/harness/entry.mjs',
  ];
}

/** Драйвер контейнеров sandbox: spawn + детерминированная очистка через docker-CLI. */
export class DockerDriver {
  /** Запустить контейнер сессии; вернуть живой child-процесс (стримы — для AsyncIpcChannel). */
  spawnSession(policy: SandboxPolicy, opts: DockerRunOptions): SpawnedContainer {
    const args = buildDockerRunArgs(policy, opts);
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    return {
      name: opts.name,
      child,
    };
  }

  /** Прочитать exit-состояние контейнера (для различения OOM vs краш). undefined если контейнера нет. */
  inspectState(name: string): { oomKilled: boolean; exitCode: number; running: boolean } | undefined {
    const r = spawnSync(
      'docker',
      ['inspect', '--format', '{{.State.OOMKilled}}|{{.State.ExitCode}}|{{.State.Running}}', name],
      { encoding: 'utf8' },
    );
    if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
    const [oom, code, running] = r.stdout.trim().split('|');
    return { oomKilled: oom === 'true', exitCode: Number.parseInt(code, 10) || 0, running: running === 'true' };
  }

  /** Принудительно убить контейнер (`docker kill -s KILL`); ошибки игнорируются (idempotent). */
  kill(name: string): void {
    spawnSync('docker', ['kill', '-s', 'KILL', name], { stdio: 'ignore' });
  }

  /** Удалить контейнер (`docker rm -f`); idempotent — гарантирует детерминированную очистку. */
  remove(name: string): void {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
}
