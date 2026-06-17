// 019 — DockerDriver (US2; research R1, contracts/sandbox-ipc-protocol; FR-016/017/018).
//
// Построение `docker run`-команды со ВСЕМИ флагами изоляции/квот из SandboxPolicy и spawn контейнера
// через встроенный node:child_process (без dockerode). Граница безопасности — флаги ядра (network none,
// read-only rootfs, tmpfs, memory/cpus/pids, cap-drop ALL, no-new-privileges, non-root user, env НЕ
// пробрасывается, bundle/harness только :ro). Имя контейнера — детерминированное (без wall-clock/random).
//
// IPC синхронен (018 ModuleExecutor seam синхронен): host читает stdout контейнера через raw-fd
// (`fs.readSync`), поэтому драйвер отдаёт сырые дескрипторы потоков (см. ipc.ts).

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SandboxPolicy } from '../sandbox-policy.js';

/** Спавненный контейнер: процесс docker-CLI + сырые fd его stdio (для синхронного NDJSON-IPC). */
export interface SpawnedContainer {
  readonly name: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdinFd: number;
  readonly stdoutFd: number;
  readonly stderrFd: number;
}

/** Параметры запуска контейнера сессии. */
export interface DockerRunOptions {
  readonly name: string;
  readonly bundleDir: string; // host abs path — монтируется :ro в /sandbox/bundle
  readonly harnessDir: string; // host abs path — монтируется :ro в /sandbox/harness
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

/** Построить аргументы `docker run …` из политики (контракт sandbox-ipc-protocol §docker-инвокация). */
export function buildDockerRunArgs(policy: SandboxPolicy, opts: DockerRunOptions): readonly string[] {
  const { isolation: iso, limits } = policy;
  // NB: НЕ '--rm' — контейнер остаётся в 'exited' до явного `docker rm -f` (close()), чтобы host мог
  // прочитать .State.OOMKilled/.ExitCode для различения sandbox_memory_exceeded vs sandbox_crashed (T031).
  return [
    'run',
    '-i',
    '--name',
    opts.name,
    '--network',
    iso.network, // 'none'
    '--read-only',
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,size=${iso.tmpfsSizeBytes}`,
    '--memory',
    String(limits.memoryBytes),
    '--memory-swap',
    String(limits.memoryBytes), // = memory ⇒ без swap
    '--cpus',
    String(limits.cpus),
    '--pids-limit',
    String(iso.pidsLimit),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    iso.user,
    // env НЕ пробрасывается (нет -e) ⇒ секреты не наследуются (FR-017)
    '-v',
    `${opts.bundleDir}:/sandbox/bundle:ro`,
    '-v',
    `${opts.harnessDir}:/sandbox/harness:ro`,
    iso.image,
    'node',
    '--disallow-code-generation-from-strings',
    '/sandbox/harness/entry.mjs',
  ];
}

/** Извлечь сырой fd потока (Node v24: через внутренний `_handle.fd`; для синхронного IPC). */
function rawFd(stream: { readonly fd?: number | null } & Record<string, unknown>, label: string): number {
  const direct = stream.fd;
  if (typeof direct === 'number' && direct >= 0) return direct;
  const handle = (stream as { _handle?: { fd?: number } })._handle;
  if (handle !== undefined && typeof handle.fd === 'number' && handle.fd >= 0) return handle.fd;
  throw new Error(`docker-driver: cannot obtain raw fd for ${label}`);
}

/** Драйвер контейнеров sandbox: spawn + детерминированная очистка через docker-CLI. */
export class DockerDriver {
  /** Запустить контейнер сессии; вернуть процесс и сырые fd его stdio. */
  spawnSession(policy: SandboxPolicy, opts: DockerRunOptions): SpawnedContainer {
    const args = buildDockerRunArgs(policy, opts);
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    return {
      name: opts.name,
      child,
      stdinFd: rawFd(child.stdin as never, 'stdin'),
      stdoutFd: rawFd(child.stdout as never, 'stdout'),
      stderrFd: rawFd(child.stderr as never, 'stderr'),
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
