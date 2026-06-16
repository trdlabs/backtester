// Host-side Docker driver for the sandbox. One short-lived container per run: write the request to
// stdin, read one JSON response from stdout, enforce a wall-time limit (kill on overrun), and inspect
// for OOM. The kernel/container is the security boundary — not any in-process check.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface SandboxLimits {
  readonly image: string;
  readonly memoryMb: number;
  readonly cpus: number;
  readonly pidsLimit: number;
  readonly wallTimeMs: number;
  readonly tmpfsMb: number;
  readonly user: string;
  readonly maxOutputBytes: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  image: 'node:24-alpine',
  memoryMb: 256,
  cpus: 1,
  pidsLimit: 64,
  wallTimeMs: 10_000,
  tmpfsMb: 64,
  user: '65534:65534',
  maxOutputBytes: 4_000_000,
};

export interface DockerRunResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  oomKilled: boolean;
  exitCode: number | null;
  spawnError?: string;
}

function runDocker(args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolveP) => {
    let stdout = '';
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('error', () => resolveP({ stdout: '', code: null }));
    child.on('close', (code) => resolveP({ stdout, code }));
  });
}

/** True when the Docker daemon is reachable. Used to gate the sandbox path / sandbox tests. */
export async function dockerAvailable(): Promise<boolean> {
  const { code } = await runDocker(['version', '--format', '{{.Server.Version}}']);
  return code === 0;
}

function buildRunArgs(name: string, harnessDir: string, limits: SandboxLimits): string[] {
  return [
    'run',
    '-i',
    '--name',
    name,
    '--network',
    'none', // no network — no exfiltration, no platform/host services
    '--read-only', // immutable rootfs
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,size=${limits.tmpfsMb}m`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(limits.pidsLimit), // blocks fork bombs
    '--memory',
    `${limits.memoryMb}m`,
    '--memory-swap',
    `${limits.memoryMb}m`, // no swap → memory cap is real
    '--cpus',
    String(limits.cpus),
    '--user',
    limits.user, // non-root; NO -e flags → no secrets/env reach the module
    '-v',
    `${harnessDir}:/harness:ro`,
    limits.image,
    'node',
    '--disallow-code-generation-from-strings',
    '/harness/entry.mjs',
  ];
}

/** Run the harness container once with `input` on stdin; resolve its stdout (+ liveness signals). */
export async function runHarnessContainer(
  input: string,
  harnessDir: string,
  limits: SandboxLimits,
): Promise<DockerRunResult> {
  const name = `bt-sbx-${randomUUID()}`;
  const args = buildRunArgs(name, harnessDir, limits);

  const result = await new Promise<DockerRunResult>((resolveP) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      spawn('docker', ['kill', name], { stdio: 'ignore' });
    }, limits.wallTimeMs);

    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < limits.maxOutputBytes) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < limits.maxOutputBytes) stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolveP({ stdout, stderr, timedOut, oomKilled: false, exitCode: null, spawnError: err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolveP({ stdout, stderr, timedOut, oomKilled: false, exitCode: code });
    });

    child.stdin.on('error', () => {}); // ignore EPIPE if the container died early
    child.stdin.write(input);
    child.stdin.end();
  });

  if (result.spawnError) return result;

  // Distinguish OOM-kill (exit 137 from the kernel) from a clean exit / our own timeout-kill.
  const inspect = await runDocker(['inspect', name, '--format', '{{.State.OOMKilled}}']);
  const oomKilled = inspect.stdout.trim() === 'true';
  spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });

  return { ...result, oomKilled };
}
