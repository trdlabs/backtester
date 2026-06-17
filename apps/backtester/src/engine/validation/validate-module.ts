// 017 — ядро структурной валидации манифеста модуля (FR-020, US1).
// 017 НЕ исполняет тело модуля: проверяются manifest + author-supplied sampleDecisions (research D6).
//
// US1 (этот шаг): kind:'strategy' — конверт, версия контракта, params↔paramsSchema, decision-схема
// sample-решений, обязательность onBarClose, submit-статус research_only. Overlay-специфичные
// гейты (multi_hook/unknown_strategy_ref/separation) добавляются в US2 (T025).

import type {
  ContractContext,
  ModuleManifest,
  ValidationIssue,
  ValidationResult,
} from '@trading/research-contracts/research';

import { assemble, makeIssue } from './assemble.js';
import { normalizeManifest } from './normalize.js';
import { SCHEMA_IDS, jsonPointerOf, type SchemaRegistry } from './schema-registry.js';

/** Вход валидации модуля (author-supplied; data-model §13.1). */
export interface ModuleInput {
  readonly manifest: ModuleManifest;
  readonly sampleDecisions?: readonly unknown[];
}

/** kind решения стратегии → имя ветки в strategy-decision.schema.json. */
const STRATEGY_DECISION_DEFS: Readonly<Record<string, string>> = {
  enter: 'EnterDecision',
  exit: 'ExitDecision',
  add_to_position: 'AddToPositionDecision',
  update_protection: 'UpdateProtectionDecision',
  annotate: 'AnnotateDecision',
  idle: 'IdleDecision',
};

/** kind решения overlay → имя ветки в overlay-decision.schema.json. */
const OVERLAY_DECISION_DEFS: Readonly<Record<string, string>> = {
  pass: 'OverlayPassDecision',
  veto: 'OverlayVetoDecision',
  patch: 'OverlayPatchDecision',
  annotate: 'OverlayAnnotateDecision',
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Закрытый набор полей зоны RiskProfile/ExecutionProfile (FR-015, SC-006). Их присутствие в
 * манифесте/решении/overlay-`patch` → `separation_violation`. hint-поля (`stop`/`take`/`ttl`/
 * `sizingHint`/`update_protection`) сюда НЕ входят и нарушением не являются.
 */
const SEPARATION_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'size',
  'sizing',
  'qty',
  'quantity',
  'notional',
  'leverage',
  'exposure',
  'exposureLimits',
  'fee',
  'fees',
  'feeModel',
  'slippage',
  'slippageModel',
  'fill',
  'fillModel',
  'maxConcurrentPositions',
  'portfolioConstraints',
  'hardConstraints',
  'hardPortfolioConstraints',
]);

/** Объявленные потребности в данных, означающие lookahead (data-model §13.4). */
const LOOKAHEAD_NEEDS = ['forwardBars', 'forwardWindow', 'oracle', 'labeling', 'postTradeOutcome'] as const;

/** Объявленные потребности, означающие недетерминизм (FR-019). */
const NONDETERMINISM_NEEDS = ['wallClock', 'uncontrolledRandom'] as const;

/** Структурные point-in-time потребности 017 (всегда легитимны). */
const STRUCTURAL_NEEDS = ['closedCandlesUpToCurrent', 'asOfIndicators'] as const;

/** Пометить любые поля зоны risk/execution на верхнем уровне `obj` как `separation_violation`. */
function scanSeparation(
  obj: Record<string, unknown>,
  basePath: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (SEPARATION_FORBIDDEN_KEYS.has(key)) {
      issues.push(
        makeIssue(
          'separation_violation',
          `поле "${key}" относится к зоне RiskProfile/ExecutionProfile (FR-015)`,
          `${basePath}/${key}`,
        ),
      );
    }
  }
}

/** Проверка sample-решений против ветки decision-union по дискриминатору `kind` + separation-скан. */
function validateSampleDecisions(
  manifest: ModuleManifest,
  sampleDecisions: readonly unknown[],
  registry: SchemaRegistry,
  issues: ValidationIssue[],
): void {
  const isOverlay = manifest.kind === 'overlay';
  const defs = isOverlay ? OVERLAY_DECISION_DEFS : STRATEGY_DECISION_DEFS;
  const schemaId = SCHEMA_IDS[isOverlay ? 'overlay-decision' : 'strategy-decision'];

  sampleDecisions.forEach((dec, i) => {
    const rec = asRecord(dec);
    const basePath = `/sampleDecisions/${i}`;

    // separation: верхний уровень решения + содержимое overlay-`patch` (открытый object).
    if (rec) {
      scanSeparation(rec, basePath, issues);
      if (rec.kind === 'patch') {
        const patch = asRecord(rec.patch);
        if (patch) scanSeparation(patch, `${basePath}/patch`, issues);
      }
    }

    const kind = rec?.kind;
    if (typeof kind !== 'string' || !(kind in defs)) {
      issues.push(
        makeIssue(
          'decision_schema_invalid',
          'неизвестный или отсутствующий kind решения',
          `/sampleDecisions/${i}/kind`,
        ),
      );
      return;
    }
    const errs = registry.validateRef(`${schemaId}#/definitions/${defs[kind]}`, dec);
    for (const e of errs) {
      issues.push(
        makeIssue(
          'decision_schema_invalid',
          e.message ?? 'нарушение схемы решения',
          `/sampleDecisions/${i}${jsonPointerOf(e)}`,
        ),
      );
    }
  });
}

/**
 * Провалидировать submit модуля. Чистая функция: `(input + contractContext + registry) → ValidationResult`.
 * Аккумулирует ПОЛНЫЙ набор причин (FR-022); `normalized` прикрепляется только при отсутствии error.
 */
export function validateModule(
  input: ModuleInput,
  ctx: ContractContext,
  registry: SchemaRegistry,
): ValidationResult {
  const { manifest } = input;
  const issues: ValidationIssue[] = [];

  // 1. Базовая schema конверта (тип/обяз. поля/enum/additionalProperties) → schema_invalid.
  for (const e of registry.validateCore('module-manifest', manifest)) {
    issues.push(makeIssue('schema_invalid', e.message ?? 'нарушение схемы манифеста', jsonPointerOf(e)));
  }

  // 2. Версия контракта в поддерживаемом наборе (D12).
  const cv: unknown = manifest.contractVersion;
  if (typeof cv === 'string' && !ctx.supportedContractVersions.includes(cv)) {
    issues.push(
      makeIssue(
        'unsupported_contract_version',
        `contractVersion "${cv}" вне поддерживаемого набора`,
        '/contractVersion',
      ),
    );
  }

  // 3. Submit-инвариант: статус всегда research_only (FR-030).
  if (manifest.status !== undefined && manifest.status !== 'research_only') {
    issues.push(
      makeIssue('schema_invalid', 'submit-статус модуля должен быть research_only (FR-030)', '/status'),
    );
  }

  // 4. Хуки и kind-специфичные правила.
  const hooks = Array.isArray(manifest.hooks) ? manifest.hooks : [];
  if (manifest.kind === 'strategy') {
    // Обязательность onBarClose для strategy (минимальный alpha-хук, FR-004).
    if (!hooks.includes('onBarClose')) {
      issues.push(
        makeIssue('schema_invalid', 'strategy-модуль обязан объявлять хук onBarClose (FR-004)', '/hooks'),
      );
    }
  } else if (manifest.kind === 'overlay') {
    // Overlay вмешивается в РОВНО ОДНОЙ точке перехвата (FR-002, US2-AC2).
    if (hooks.length > 1) {
      issues.push(
        makeIssue('multi_hook_overlay', 'overlay объявляет более одной точки перехвата (FR-002)', '/hooks'),
      );
    }
    if (!hooks.includes('apply')) {
      issues.push(
        makeIssue('schema_invalid', 'overlay обязан объявлять единственный хук apply (FR-004)', '/hooks'),
      );
    }
    // Целевая стратегия должна быть известна каталогу (FR-002, US2-AC4).
    const tsr: unknown = manifest.targetStrategyRef;
    if (typeof tsr !== 'string' || tsr.length === 0) {
      issues.push(makeIssue('schema_invalid', 'overlay обязан указывать targetStrategyRef', '/targetStrategyRef'));
    } else if (!ctx.knownStrategyRefs.includes(tsr)) {
      issues.push(makeIssue('unknown_strategy_ref', `целевая стратегия "${tsr}" неизвестна`, '/targetStrategyRef'));
    }
    if (typeof manifest.interceptionPoint !== 'string' || manifest.interceptionPoint.length === 0) {
      issues.push(makeIssue('schema_invalid', 'overlay обязан указывать interceptionPoint', '/interceptionPoint'));
    }
  }

  // 5. params против author-supplied paramsSchema (FR-034). Отсутствие paramsSchema ловит шаг 1.
  const paramsSchema: unknown = manifest.paramsSchema;
  if (paramsSchema !== undefined && paramsSchema !== null) {
    const compiled = registry.compileParams(paramsSchema as object);
    if (!compiled.ok) {
      issues.push(
        makeIssue(
          'params_schema_invalid',
          `paramsSchema не является валидной JSON Schema: ${compiled.error}`,
          '/paramsSchema',
        ),
      );
    } else if (manifest.params !== undefined) {
      compiled.validate(manifest.params);
      for (const e of compiled.validate.errors ?? []) {
        issues.push(
          makeIssue('params_schema_invalid', e.message ?? 'нарушение схемы параметров', `/params${jsonPointerOf(e)}`),
        );
      }
    }
  }

  // 5b. Разделение ответственности: params не несут sizing/exposure/exec (FR-015, SC-006).
  const paramsRec = asRecord(manifest.params);
  if (paramsRec) scanSeparation(paramsRec, '/params', issues);

  // 5c. No-lookahead и детерминизм: ОБЪЯВЛЕННАЯ потребность отклоняется до прогона (FR-012/FR-019,
  // data-model §13.4). Структурная гарантия (нет forward-API в контексте) — отдельно, в типах.
  const dataNeeds = asRecord(manifest.dataNeeds);
  if (dataNeeds) {
    for (const need of LOOKAHEAD_NEEDS) {
      if (dataNeeds[need] === true) {
        issues.push(
          makeIssue(
            'lookahead_violation',
            `объявлена потребность в будущих/oracle/post-trade данных: ${need}`,
            `/dataNeeds/${need}`,
          ),
        );
      }
    }
    for (const need of NONDETERMINISM_NEEDS) {
      if (dataNeeds[need] === true) {
        issues.push(
          makeIssue(
            'nondeterminism_violation',
            `объявлена потребность в wall-clock/неуправляемой случайности: ${need}`,
            `/dataNeeds/${need}`,
          ),
        );
      }
    }
    // 023: любой объявленный-`true` ключ вне замкнутого объединения каталогов → unsupported_market_data_kind
    // (fail-closed; зеркало unknown_metric, research R4/R5). openInterest/liquidations входят в каталог →
    // принимаются как легитимные point-in-time потребности. Структурные/lookahead/nondeterminism — свои коды.
    const recognizedNeeds = new Set<string>([
      ...STRUCTURAL_NEEDS,
      ...ctx.supportedMarketDataKinds,
      ...LOOKAHEAD_NEEDS,
      ...NONDETERMINISM_NEEDS,
    ]);
    for (const key of Object.keys(dataNeeds)) {
      if (dataNeeds[key] === true && !recognizedNeeds.has(key)) {
        issues.push(
          makeIssue(
            'unsupported_market_data_kind',
            `объявлена неподдержанная потребность в рыночных данных: ${key}`,
            `/dataNeeds/${key}`,
          ),
        );
      }
    }
  }

  // 5d. Capability-граница: объявленная запрещённая возможность → forbidden_capability
  // (FR-017/018, data-model §13.3). Закрытый набор задаётся contractContext. Разрешён только
  // platformSdk + read-only контекст.
  const capabilities = asRecord(manifest.capabilities);
  if (capabilities) {
    for (const cap of ctx.forbiddenCapabilities) {
      if (capabilities[cap] === true) {
        issues.push(
          makeIssue('forbidden_capability', `объявлена запрещённая возможность: ${cap}`, `/capabilities/${cap}`),
        );
      }
    }
  }

  // 6. Author-supplied sample-решения против decision-схемы (017 не исполняет тело модуля).
  if (Array.isArray(input.sampleDecisions)) {
    validateSampleDecisions(manifest, input.sampleDecisions, registry, issues);
  }

  const hasError = issues.some((i) => i.severity === 'error');
  return assemble(issues, hasError ? undefined : normalizeManifest(manifest));
}
