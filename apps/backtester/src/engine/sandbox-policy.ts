// 019 — SandboxPolicy/ResourceLimits/IsolationParams + registry (US2; data-model §3/§3.1,
// contracts/sandbox-policy; FR-020/023).
//
// Operator-owned, привязка по id+version (зеркало 018 RiskProfile/ExecutionProfile); часть
// детерминированного input-tuple (FR-023) — поэтому `image` пиннится КОНКРЕТНЫМ digest'ом ЗДЕСЬ.
// Bundle-авторы изменить политику не могут.

import type { Ref } from '@trading/research-contracts/research';

/** Параметры изоляции контейнера (флаги ядра — основная гарантия безопасности, FR-016..019). */
export interface IsolationParams {
  readonly image: string; // pinned 'node:24-bookworm-slim@sha256:…'
  readonly network: 'none'; // FR-016
  readonly readOnlyRootfs: true; // FR-018
  readonly tmpfsSizeBytes: number; // ephemeral /tmp
  readonly dropAllCapabilities: true;
  readonly noNewPrivileges: true;
  readonly user: string; // напр. '65534:65534' (nobody)
  readonly pidsLimit: number; // FR-019: блокирует spawn/fork-бомбы
}

/** Квоты ресурсов (cgroups + host-таймеры/счётчики, FR-020/021). */
export interface ResourceLimits {
  readonly cpus: number; // --cpus
  readonly memoryBytes: number; // --memory (= --memory-swap → без swap)
  readonly wallTimeMsPerCall: number; // host-deadline на вызов хука
  readonly wallTimeMsPerSession: number; // бюджет на сессию
  readonly maxStdoutBytes: number; // FR-020
  readonly maxStderrBytes: number; // FR-020 + bound диагностики
  readonly maxDecisionBytes: number; // верхняя граница одной строки-ответа
}

/** Политика sandbox — привязывается по `id@version`; входит в детерминированный input-tuple. */
export interface SandboxPolicy {
  readonly id: string;
  readonly version: string;
  readonly isolation: IsolationParams;
  readonly limits: ResourceLimits;
}

/** Реестр политик: резолв по 017 `Ref` ({id, version}). */
export interface SandboxPolicyRegistry {
  resolve(ref: Ref): SandboxPolicy | undefined;
}

/**
 * Pinned базовый образ sandbox (digest — НЕ placeholder; см. FR-023). ДОЛЖЕН совпадать с образом,
 * который проверяет `verify_019_preflight.mjs` и `infra/sandbox/Dockerfile.sandbox`.
 */
export const SANDBOX_IMAGE =
  'node:24-bookworm-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf';

/** Политика по умолчанию `default_sandbox@1.0.0` (data-model §3.1). */
export const DEFAULT_SANDBOX: SandboxPolicy = {
  id: 'default_sandbox',
  version: '1.0.0',
  isolation: {
    image: SANDBOX_IMAGE,
    network: 'none',
    readOnlyRootfs: true,
    tmpfsSizeBytes: 16_777_216,
    dropAllCapabilities: true,
    noNewPrivileges: true,
    user: '65534:65534',
    pidsLimit: 64,
  },
  limits: {
    cpus: 1,
    memoryBytes: 134_217_728, // 128 MiB
    wallTimeMsPerCall: 2_000,
    wallTimeMsPerSession: 30_000,
    maxStdoutBytes: 65_536,
    maxStderrBytes: 16_384,
    maxDecisionBytes: 65_536,
  },
};

/**
 * Probe-банда `tiny_mem_sandbox@1.0.0` (US4): малый `memoryBytes` — чтобы OOM-probe срабатывал
 * быстро и наблюдаемо. Достаточно для старта node:24-slim, но мал для крупной аллокации (data-model §3.1).
 */
export const TINY_MEM_SANDBOX: SandboxPolicy = {
  id: 'tiny_mem_sandbox',
  version: '1.0.0',
  isolation: { ...DEFAULT_SANDBOX.isolation },
  limits: {
    ...DEFAULT_SANDBOX.limits,
    memoryBytes: 100_663_296, // 96 MiB — node стартует, но крупная аллокация → cgroup OOM
    wallTimeMsPerCall: 5_000, // OOM-аллокация может занять чуть дольше
  },
};

/**
 * Evidence-прогон политика `evidence_long@1.0.0`: реальные long_oi-прогоны идут на полном дне (1440
 * баров/символ) и эмитят `annotate` почти на каждом баре, так что кумулятивный сессионный stdout
 * (default 64KiB) и `wallTimeMsPerSession` (30с) дефолтной политики переполняются. Поднимаем ТОЛЬКО
 * эти два лимита; вся изоляция (net=none, ro-rootfs, cap-drop, 128MiB, no-new-privs, pids=64) и
 * `maxDecisionBytes` (одна строка-ответа) — БЕЗ изменений. `maxStdoutBytes` остаётся тесной анти-flood
 * DoS-границей (2MiB ≈ 6–7× от наблюдаемого peak ~300KB, НЕ безразмерный буфер). Кумулятивный cap
 * сохранён намеренно (per-bar reset = регрессия безопасности; per-bar limit допустим только ВДОБАВОК).
 */
export const EVIDENCE_LONG_SANDBOX: SandboxPolicy = {
  id: 'evidence_long',
  version: '1.0.0',
  isolation: { ...DEFAULT_SANDBOX.isolation },
  limits: {
    ...DEFAULT_SANDBOX.limits,
    maxStdoutBytes: 2_097_152, // 2 MiB — tight anti-flood cap for full-day annotate-heavy runs
    wallTimeMsPerSession: 300_000, // 300s — full-day per-symbol session budget (per-call stays 2s)
  },
};

function key(id: string, version: string): string {
  return `${id}@${version}`;
}

/** Построить registry политик из явного набора (без побочных эффектов). */
export function createSandboxPolicyRegistry(policies: readonly SandboxPolicy[]): SandboxPolicyRegistry {
  const map = new Map<string, SandboxPolicy>(policies.map((p) => [key(p.id, p.version), p]));
  return { resolve: (ref) => map.get(key(ref.id, ref.version)) };
}

/** Поставляемые 019 политики (default + probe-банда tiny_mem_sandbox для US4). */
export const SANDBOX_POLICIES: SandboxPolicyRegistry = createSandboxPolicyRegistry([
  DEFAULT_SANDBOX,
  TINY_MEM_SANDBOX,
  EVIDENCE_LONG_SANDBOX,
]);
