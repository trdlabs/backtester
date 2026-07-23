// env-catalog item 3 — типизированная env-схема (контракт env-schema.1, control-center
// docs/architecture/contracts/env-schema.md).
//
// Пины:
//  1) экспорт `envSchemaDocument()` валиден по vendored JSON Schema контракта (ajv, draft 2020-12)
//     И по семантическим правилам валидатора control-center (сортировка, уникальность,
//     default_state ∈ flag_states, secret/required ⇒ default null);
//  2) экспорт детерминирован (байт-в-байт), `renderEnvSchemaJson()` — JSON + завершающий '\n';
//  3) полная инвентаризация: точный отсортированный список всех переменных репо;
//  4) fail-fast: `loadEnv()` отклоняет ровно те env, которые отклоняет `loadConfig()`
//     (паритет accept-set — существующие fail-fast места не ослаблены), и агрегирует ВСЕ
//     ошибки разом (safeParse), а не первую;
//  5) ENV.md / .env.example на диске совпадают с генератором (дрейф-гейт «Генерация» как тест);
//  6) правило секретов: значения секретов не появляются ни в схеме, ни в ENV.md, ни в example.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  ENV_VARS,
  EnvValidationError,
  envSchemaDocument,
  isLoopbackHost,
  loadEnv,
  renderEnvSchemaJson,
} from '../src/env';
import { renderEnvExample, renderEnvMd } from '../src/env-docs';
import { loadConfig } from '../src/config';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

const contractSchema = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/env-schema-1.contract.schema.json'), 'utf8'),
) as object;

/** Полная инвентаризация process.env-чтений репо (src + tests), отсортирована по name (UTF-16). */
const EXPECTED_NAMES = [
  'BACKTESTER_ARTIFACTS_DIR',
  'BACKTESTER_AUTH_TOKEN',
  'BACKTESTER_AUTO_WORKER',
  'BACKTESTER_BAR_BATCHING',
  'BACKTESTER_BAR_MAJOR',
  'BACKTESTER_BAR_MAJOR_BATCH',
  'BACKTESTER_BATCH_BARS',
  'BACKTESTER_BUNDLES_DIR',
  'BACKTESTER_COALESCE_ENABLED',
  'BACKTESTER_COMPUTE_LOCK_TTL_MS',
  'BACKTESTER_COMPUTE_WAIT_MAX_ATTEMPTS',
  'BACKTESTER_DATA_API_MAX_ATTEMPTS',
  'BACKTESTER_DATA_API_MAX_PAGES',
  'BACKTESTER_DATA_API_MAX_ROWS',
  'BACKTESTER_DATA_API_OPERATION_DEADLINE_MS',
  'BACKTESTER_DATA_API_PAGE_LIMIT',
  'BACKTESTER_DATA_API_RETRY_BASE_MS',
  'BACKTESTER_DATA_API_RETRY_MAX_MS',
  'BACKTESTER_DATA_API_TIMEOUT_MS',
  'BACKTESTER_DATA_API_TOKEN',
  'BACKTESTER_DATA_API_URL',
  'BACKTESTER_DATA_SOURCE',
  'BACKTESTER_DEDUP_ENABLED',
  'BACKTESTER_DIAG_CONCENTRATION_PCT',
  'BACKTESTER_DIAG_MIN_TRADES',
  'BACKTESTER_ENABLE_OVERLAY_ENGINE',
  'BACKTESTER_FIXTURES_DIR',
  'BACKTESTER_HOLDOUT_ENABLED',
  'BACKTESTER_HOLDOUT_FRACTION',
  'BACKTESTER_HOST',
  'BACKTESTER_IPC_PROFILE',
  'BACKTESTER_JOB_OBS',
  'BACKTESTER_MOCK_PLATFORM_TOKEN',
  'BACKTESTER_MOCK_PLATFORM_URL',
  'BACKTESTER_NOVELTY_CORR_THRESHOLD',
  'BACKTESTER_NOVELTY_ENABLED',
  'BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS',
  'BACKTESTER_PG_POOL_MAX',
  'BACKTESTER_PG_STATEMENT_TIMEOUT_MS',
  'BACKTESTER_PORT',
  'BACKTESTER_PROMOTION_HOLDOUT_GATE',
  'BACKTESTER_QUEUE_MAX_DEPTH',
  'BACKTESTER_QUEUE_NOTIFY',
  'BACKTESTER_QUEUE_RETRY_AFTER_S',
  'BACKTESTER_QUEUE_TIMEOUT_MS',
  'BACKTESTER_REAL_PLATFORM_TOKEN',
  'BACKTESTER_REAL_PLATFORM_URL',
  'BACKTESTER_RESULT_CACHE_SWEEP_INTERVAL_MS',
  'BACKTESTER_RESULT_CACHE_TTL_MS',
  'BACKTESTER_RUN_DIAGNOSTICS',
  'BACKTESTER_RUN_TIMEOUT_MS',
  'BACKTESTER_S3_ACCESS_KEY',
  'BACKTESTER_S3_BUCKET',
  'BACKTESTER_S3_ENDPOINT',
  'BACKTESTER_S3_FORCE_PATH_STYLE',
  'BACKTESTER_S3_REGION',
  'BACKTESTER_S3_SECRET_KEY',
  'BACKTESTER_SANDBOX_CPUS',
  'BACKTESTER_SANDBOX_HARNESS_DIR',
  'BACKTESTER_SANDBOX_IMAGE',
  'BACKTESTER_SANDBOX_MEMORY_MB',
  'BACKTESTER_SANDBOX_OVERLAY_CPUS',
  'BACKTESTER_SANDBOX_OVERLAY_HARNESS_DIR',
  'BACKTESTER_SANDBOX_OVERLAY_IMAGE',
  'BACKTESTER_SANDBOX_OVERLAY_MEMORY_MB',
  'BACKTESTER_SANDBOX_OVERLAY_PIDS',
  'BACKTESTER_SANDBOX_OVERLAY_VOLUME',
  'BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT',
  'BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_CALL',
  'BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_SESSION',
  'BACKTESTER_SANDBOX_PIDS',
  'BACKTESTER_SANDBOX_TMPFS_MB',
  'BACKTESTER_SANDBOX_USER',
  'BACKTESTER_SANDBOX_WALL_MS',
  'BACKTESTER_STORE_BACKEND',
  'BACKTESTER_TEST_DATABASE_URL',
  'BACKTESTER_TEST_DATA_API_TOKEN',
  'BACKTESTER_TEST_DATA_API_URL',
  'BACKTESTER_TRIAL_EMPIRICAL_MIN_N',
  'BACKTESTER_TRIAL_LEDGER',
  'BACKTESTER_UNIVERSE_MAX_N',
  'BACKTESTER_UNIVERSE_MEM_BASE_MB',
  'BACKTESTER_UNIVERSE_MEM_PER_SYMBOL_MB',
  'BACKTESTER_UNIVERSE_SESSION',
  'BACKTESTER_WALK_FORWARD_ENABLED',
  'BACKTESTER_WALK_FORWARD_MAX_FOLDS',
  'BENCH_API_PORT',
  'BENCH_CONC',
  'BENCH_MODE',
  'BENCH_N',
  'BENCH_PG_PORT',
  'BENCH_SESSION_BUDGET_MS',
  'BT_EVIDENCE_SIGNING_KEY',
  'DATABASE_URL',
  'DATA_API_FIXTURES_DIR',
  'DATA_API_HOST',
  'DATA_API_PORT',
  'DATA_API_TOKEN',
  'LONGOI_BUNDLE',
  'LONGOI_BUNDLE_HASH',
  'LONGOI_DIAG',
  'LONGOI_SNAPSHOT',
  'PLATFORM_REPO',
  'PNL_TOL',
  'RUN_BENCH',
  'RUN_CROSS_REPO_E2E',
  'SLICE_PATH',
  'TAPE_CACHE_MAX_ENTRIES',
  'WORKER_CONCURRENCY',
  'WORKER_ERROR_BACKOFF_BASE_MS',
  'WORKER_ERROR_BACKOFF_MAX_MS',
  'WORKER_HEALTH_PORT',
  'WORKER_HEARTBEAT_MS',
  'WORKER_ID',
  'WORKER_LEASE_TTL_MS',
  'WORKER_MAX_ATTEMPTS',
  'WORKER_POLL_MS',
] as const;

/** Деплой-таймовые фичефлаги E4b-паттерна (flag: true в схеме). */
const EXPECTED_FLAGS = [
  'BACKTESTER_BAR_BATCHING',
  'BACKTESTER_BAR_MAJOR',
  'BACKTESTER_BAR_MAJOR_BATCH',
  'BACKTESTER_COALESCE_ENABLED',
  'BACKTESTER_DEDUP_ENABLED',
  'BACKTESTER_ENABLE_OVERLAY_ENGINE',
  'BACKTESTER_HOLDOUT_ENABLED',
  'BACKTESTER_JOB_OBS',
  'BACKTESTER_NOVELTY_ENABLED',
  'BACKTESTER_PROMOTION_HOLDOUT_GATE',
  'BACKTESTER_QUEUE_NOTIFY',
  'BACKTESTER_RUN_DIAGNOSTICS',
  'BACKTESTER_TRIAL_LEDGER',
  'BACKTESTER_UNIVERSE_SESSION',
  'BACKTESTER_WALK_FORWARD_ENABLED',
] as const;

/** Секреты: значение никогда не появляется в схеме/ENV.md/example — только имя и форма. */
const EXPECTED_SECRETS = [
  'BACKTESTER_AUTH_TOKEN',
  'BACKTESTER_DATA_API_TOKEN',
  'BACKTESTER_MOCK_PLATFORM_TOKEN',
  'BACKTESTER_REAL_PLATFORM_TOKEN',
  'BACKTESTER_S3_ACCESS_KEY',
  'BACKTESTER_S3_SECRET_KEY',
  'BACKTESTER_TEST_DATABASE_URL',
  'BACKTESTER_TEST_DATA_API_TOKEN',
  'BT_EVIDENCE_SIGNING_KEY',
  'DATABASE_URL',
  'DATA_API_TOKEN',
] as const;

describe('env-schema.1 export (контракт control-center)', () => {
  const doc = envSchemaDocument();

  it('валиден по JSON Schema контракта (draft 2020-12, vendored копия)', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(contractSchema);
    const ok = validate(doc);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('верхний уровень: schema_version / repo / generated_from', () => {
    expect(doc.schema_version).toBe('env-schema.1');
    expect(doc.repo).toBe('trading-backtester'); // канонический id из control-center repos.yaml
    expect(doc.generated_from).toBe('apps/backtester/src/env.ts');
  });

  it('variables отсортированы по name (UTF-16) и уникальны', () => {
    const names = doc.variables.map((v) => v.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('полная инвентаризация: точный список переменных', () => {
    expect(doc.variables.map((v) => v.name)).toEqual([...EXPECTED_NAMES]);
  });

  it('семантические правила валидатора: secret ⇒ default null; required ⇒ default null; флаги', () => {
    for (const v of doc.variables) {
      if (v.secret) expect(v.default, v.name).toBeNull();
      if (v.required) expect(v.default, v.name).toBeNull();
      if (v.flag) {
        expect(v.required, v.name).toBe(false);
        expect(v.flag_states, v.name).toBeDefined();
        expect(v.default_state, v.name).toBeDefined();
        expect(v.flag_states).toContain(v.default_state);
        // Правило 4 валидатора: default, если задан, равен default_state.
        if (v.default !== null) expect(v.default).toBe(v.default_state);
      } else {
        expect(v.flag_states, v.name).toBeUndefined();
        expect(v.default_state, v.name).toBeUndefined();
      }
      if (v.type === 'enum') expect(v.enum_values?.length, v.name).toBeGreaterThan(0);
      else expect(v.enum_values, v.name).toBeUndefined();
      expect(v.description.length, v.name).toBeGreaterThan(0);
      expect(v.owner_unit.length, v.name).toBeGreaterThan(0);
    }
  });

  it('флаги: точный набор flag:true', () => {
    const flags = doc.variables.filter((v) => v.flag).map((v) => v.name);
    expect(flags).toEqual([...EXPECTED_FLAGS]);
  });

  it('BACKTESTER_TRIAL_LEDGER: default ON после #156 → default_state enforce', () => {
    const v = doc.variables.find((x) => x.name === 'BACKTESTER_TRIAL_LEDGER')!;
    expect(v.flag).toBe(true);
    expect(v.flag_states).toEqual(['off', 'enforce']);
    expect(v.default_state).toBe('enforce');
  });

  it('BACKTESTER_HOLDOUT_ENABLED и остальные флаги: default_state off', () => {
    for (const name of EXPECTED_FLAGS) {
      if (name === 'BACKTESTER_TRIAL_LEDGER') continue;
      const v = doc.variables.find((x) => x.name === name)!;
      expect(v.default_state, name).toBe('off');
    }
  });

  it('секреты: точный набор secret:true, все с default null', () => {
    const secrets = doc.variables.filter((v) => v.secret).map((v) => v.name);
    expect(secrets).toEqual([...EXPECTED_SECRETS]);
    for (const v of doc.variables.filter((x) => x.secret)) expect(v.default, v.name).toBeNull();
  });

  it('дефолты воспроизводят текущее поведение config.ts (точечные пины)', () => {
    const byName = new Map(doc.variables.map((v) => [v.name, v]));
    expect(byName.get('BACKTESTER_HOST')!.default).toBe('127.0.0.1');
    expect(byName.get('BACKTESTER_PORT')!.default).toBe('8080');
    expect(byName.get('BACKTESTER_DATA_SOURCE')!.default).toBe('fixture');
    expect(byName.get('BACKTESTER_DATA_SOURCE')!.enum_values).toEqual(['fixture', 'http', 'mock', 'real']);
    expect(byName.get('BACKTESTER_STORE_BACKEND')!.default).toBe('filesystem');
    expect(byName.get('BACKTESTER_DATA_API_TIMEOUT_MS')!.default).toBe('30000');
    expect(byName.get('BACKTESTER_QUEUE_TIMEOUT_MS')!.default).toBe('21600000');
    expect(byName.get('BACKTESTER_RUN_TIMEOUT_MS')!.default).toBe('7200000');
    expect(byName.get('BACKTESTER_AUTO_WORKER')!.default).toBe('true');
    expect(byName.get('WORKER_CONCURRENCY')!.default).toBe('4');
    expect(byName.get('WORKER_HEARTBEAT_MS')!.default).toBe('10000');
    expect(byName.get('WORKER_LEASE_TTL_MS')!.default).toBe('30000');
    expect(byName.get('TAPE_CACHE_MAX_ENTRIES')!.default).toBe('16');
    expect(byName.get('DATA_API_HOST')!.default).toBe('127.0.0.1');
    expect(byName.get('DATA_API_PORT')!.default).toBe('8081');
    expect(byName.get('BACKTESTER_HOLDOUT_FRACTION')!.default).toBe('0.2');
    expect(byName.get('BACKTESTER_S3_FORCE_PATH_STYLE')!.default).toBe('true');
  });

  it('consumers: непустые и указывают на существующие файлы репо', () => {
    for (const v of doc.variables) {
      expect(v.consumers.length, v.name).toBeGreaterThan(0);
      for (const c of v.consumers) {
        expect(existsSync(resolve(REPO_ROOT, c)), `${v.name} → ${c}`).toBe(true);
      }
    }
  });

  it('экспорт детерминирован: JSON байт-в-байт, 2 пробела, завершающий \\n', () => {
    const a = renderEnvSchemaJson();
    const b = renderEnvSchemaJson();
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(a).toBe(JSON.stringify(envSchemaDocument(), null, 2) + '\n');
    expect(JSON.parse(a)).toEqual(doc);
  });
});

describe('loadEnv: fail-fast, паритет accept-set с loadConfig', () => {
  const negatives: Array<[string, NodeJS.ProcessEnv, string]> = [
    ['неизвестный store backend', { BACKTESTER_STORE_BACKEND: 'gcs' }, 'BACKTESTER_STORE_BACKEND'],
    ['s3 без настроек', { BACKTESTER_STORE_BACKEND: 's3' }, 'BACKTESTER_S3_ENDPOINT'],
    ['data source real без url/token', { BACKTESTER_DATA_SOURCE: 'real' }, 'BACKTESTER_REAL_PLATFORM_URL'],
    [
      'bar-major и bar-batching одновременно',
      { BACKTESTER_BAR_MAJOR: 'true', BACKTESTER_BAR_BATCHING: 'true' },
      'BACKTESTER_BAR_MAJOR',
    ],
    [
      'holdout с невалидной фракцией',
      { BACKTESTER_HOLDOUT_ENABLED: 'true', BACKTESTER_HOLDOUT_FRACTION: '1.5' },
      'BACKTESTER_HOLDOUT_FRACTION',
    ],
    ['holdout без фракции', { BACKTESTER_HOLDOUT_ENABLED: 'true' }, 'BACKTESTER_HOLDOUT_FRACTION'],
    [
      'promotion gate без holdout',
      { BACKTESTER_PROMOTION_HOLDOUT_GATE: 'true' },
      'BACKTESTER_HOLDOUT_ENABLED',
    ],
    [
      'novelty с порогом вне [0,1]',
      { BACKTESTER_NOVELTY_ENABLED: 'true', BACKTESTER_NOVELTY_CORR_THRESHOLD: '2' },
      'BACKTESTER_NOVELTY_CORR_THRESHOLD',
    ],
    [
      'novelty с overlap < 1',
      { BACKTESTER_NOVELTY_ENABLED: 'true', BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS: '0' },
      'BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS',
    ],
    ['posInt-нарушение: timeout 0', { BACKTESTER_DATA_API_TIMEOUT_MS: '0' }, 'BACKTESTER_DATA_API_TIMEOUT_MS'],
    [
      'operation deadline < 0',
      { BACKTESTER_DATA_API_OPERATION_DEADLINE_MS: '-1' },
      'BACKTESTER_DATA_API_OPERATION_DEADLINE_MS',
    ],
    [
      'retry max < base',
      { BACKTESTER_DATA_API_RETRY_BASE_MS: '1000', BACKTESTER_DATA_API_RETRY_MAX_MS: '500' },
      'BACKTESTER_DATA_API_RETRY_MAX_MS',
    ],
    ['result-cache TTL мусор', { BACKTESTER_RESULT_CACHE_TTL_MS: '-5' }, 'BACKTESTER_RESULT_CACHE_TTL_MS'],
    [
      'sweep-interval мусор при заданном TTL',
      { BACKTESTER_RESULT_CACHE_TTL_MS: '1000', BACKTESTER_RESULT_CACHE_SWEEP_INTERVAL_MS: '0' },
      'BACKTESTER_RESULT_CACHE_SWEEP_INTERVAL_MS',
    ],
    ['не-loopback без auth-токена', { BACKTESTER_HOST: '0.0.0.0' }, 'BACKTESTER_AUTH_TOKEN'],
    [
      'overlay volume без mountpoint (half-config)',
      { BACKTESTER_SANDBOX_OVERLAY_VOLUME: 'vol' },
      'BACKTESTER_SANDBOX_OVERLAY_VOLUME',
    ],
  ];

  it.each(negatives)('негатив: %s — отклоняют ОБА (loadConfig и loadEnv)', (_name, env, mentions) => {
    expect(() => loadConfig(env)).toThrow();
    let err: unknown;
    try {
      loadEnv(env);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvValidationError);
    expect((err as EnvValidationError).message).toContain(mentions);
  });

  const positives: Array<[string, NodeJS.ProcessEnv]> = [
    ['пустой env (все дефолты)', {}],
    // sweep-interval без TTL игнорируется (зеркало loadConfig — TTL-ветка не входит).
    ['sweep-interval мусор БЕЗ TTL', { BACKTESTER_RESULT_CACHE_SWEEP_INTERVAL_MS: 'garbage' }],
    // Незнакомый data source тихо резолвится в fixture (текущее поведение, не ослаблять и не ужесточать).
    ['незнакомый data source', { BACKTESTER_DATA_SOURCE: 'weird' }],
    // Фракция вне (0,1) валидируется ТОЛЬКО при включённом holdout.
    ['плохая фракция при выключенном holdout', { BACKTESTER_HOLDOUT_FRACTION: '99' }],
    ['не-loopback С auth-токеном', { BACKTESTER_HOST: '0.0.0.0', BACKTESTER_AUTH_TOKEN: 't0k' }],
    ['пустой store backend → filesystem', { BACKTESTER_STORE_BACKEND: '' }],
    [
      'полный s3-набор',
      {
        BACKTESTER_STORE_BACKEND: 's3',
        BACKTESTER_S3_ENDPOINT: 'http://127.0.0.1:9000',
        BACKTESTER_S3_BUCKET: 'b',
        BACKTESTER_S3_ACCESS_KEY: 'a',
        BACKTESTER_S3_SECRET_KEY: 's',
      },
    ],
    [
      'overlay volume + mountpoint (полная пара)',
      { BACKTESTER_SANDBOX_OVERLAY_VOLUME: 'vol', BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT: '/sandbox-shared' },
    ],
  ];

  it.each(positives)('позитив: %s — принимают ОБА', (_name, env) => {
    expect(() => loadConfig(env)).not.toThrow();
    expect(() => loadEnv(env)).not.toThrow();
  });

  it('агрегирует ВСЕ ошибки разом (не первую)', () => {
    let err: EnvValidationError | undefined;
    try {
      loadEnv({
        BACKTESTER_STORE_BACKEND: 'gcs',
        BACKTESTER_DATA_API_TIMEOUT_MS: 'garbage',
        BACKTESTER_HOLDOUT_ENABLED: 'true',
      });
    } catch (e) {
      err = e as EnvValidationError;
    }
    expect(err).toBeInstanceOf(EnvValidationError);
    expect(err!.issues.length).toBeGreaterThanOrEqual(3);
    expect(err!.message).toContain('BACKTESTER_STORE_BACKEND');
    expect(err!.message).toContain('BACKTESTER_DATA_API_TIMEOUT_MS');
    expect(err!.message).toContain('BACKTESTER_HOLDOUT_FRACTION');
  });

  it('isLoopbackHost: перенесён без изменения семантики (P2-10)', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('127.attacker.internal')).toBe(false); // hostname-префикс — НЕ loopback
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });
});

describe('генерация ENV.md / .env.example (дрейф-гейт как тест)', () => {
  const doc = envSchemaDocument();

  it('ENV.md на диске совпадает с генератором', () => {
    const onDisk = readFileSync(resolve(REPO_ROOT, 'ENV.md'), 'utf8');
    expect(onDisk).toBe(renderEnvMd(doc));
  });

  it('.env.example на диске совпадает с генератором', () => {
    const onDisk = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8');
    expect(onDisk).toBe(renderEnvExample(doc));
  });

  it('секрет рендерится как NAME= с SOPS-комментарием; optional без дефолта — как # NAME=', () => {
    const example = renderEnvExample(doc);
    for (const name of EXPECTED_SECRETS) {
      expect(example).toContain(`\n${name}=\n`);
    }
    expect(example).toContain('SOPS/age-контуре');
    // optional без дефолта — закомментировано:
    expect(example).toContain('# BACKTESTER_DATA_API_URL=');
    // с дефолтом — раскомментировано со значением:
    expect(example).toContain('\nBACKTESTER_PORT=8080\n');
  });

  it('значения секретов не утекают: у секретов нет "=<значение>" ни в ENV.md, ни в example', () => {
    const example = renderEnvExample(doc);
    for (const name of EXPECTED_SECRETS) {
      expect(example).not.toMatch(new RegExp(`^${name}=.+$`, 'm'));
    }
    const md = renderEnvMd(doc);
    for (const v of doc.variables.filter((x) => x.secret)) {
      expect(v.default).toBeNull();
      expect(md).toContain(v.name); // имя и форма — да
    }
  });
});

describe('ENV_VARS registry', () => {
  it('количество переменных совпадает с инвентаризацией', () => {
    expect(ENV_VARS.length).toBe(EXPECTED_NAMES.length);
  });
});
