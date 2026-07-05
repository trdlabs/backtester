// 017 — реестр компиляции JSON Schema через ajv (research D2/D7).
//
// Источник истины — TS-типы контракта; схемы ГЕНЕРИРУЮТСЯ из них в
// schemas/017/*.schema.json (gen:research-schemas). Реестр компилирует эти core-схемы (кэш)
// и author-supplied paramsSchema. Сами JSON-ассеты теперь предоставляет публичный SDK
// (@trading-backtester/sdk/contracts) через schemaAsset/allSchemaAssets — этот файл больше
// не читает их с диска.
//
// Замечание о диалекте: ts-json-schema-generator (мандат D3) эмитит draft-07; поэтому реестр
// использует стандартный ajv (draft-07). Набор используемых ключевых слов (anyOf,
// additionalProperties:false, enum/const) идентичен 2020-12 — функциональной разницы для контракта
// нет. `instancePath` ajv — уже JSON Pointer (RFC 6901, D7) для поля `path` причины.

import { Ajv } from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';

import {
  SCHEMA_IDS,
  schemaAsset,
  type CoreSchemaName,
} from '@trading-backtester/sdk/contracts';

export { SCHEMA_IDS };
export type { CoreSchemaName };

/** Результат компиляции author-supplied paramsSchema. */
export type ParamsCompileResult =
  | { readonly ok: true; readonly validate: ValidateFunction }
  | { readonly ok: false; readonly error: string };

/** Реестр компилированных схем контракта. */
export interface SchemaRegistry {
  /** Провалидировать данные против core-схемы; `[]` — валидно, иначе список ajv-ошибок. */
  validateCore(name: CoreSchemaName, data: unknown): readonly ErrorObject[];
  /**
   * Провалидировать данные против конкретной ветки union по `$ref` (например
   * `…strategy-decision.schema.json#/definitions/EnterDecision`) — чистые ошибки одной ветки
   * вместо шумного `anyOf`. `[]` — валидно.
   */
  validateRef(refId: string, data: unknown): readonly ErrorObject[];
  /** Скомпилировать произвольную author-supplied JSON Schema параметров. */
  compileParams(paramsSchema: object): ParamsCompileResult;
}

/**
 * `instancePath` ajv-ошибки как JSON Pointer (RFC 6901); `""` — корень (D7).
 * Для `required` указывает на отсутствующее поле (`<instancePath>/<missingProperty>`).
 */
export function jsonPointerOf(err: ErrorObject): string {
  if (err.keyword === 'required') {
    const mp = (err.params as { missingProperty?: string }).missingProperty;
    if (mp !== undefined) return `${err.instancePath}/${mp}`;
  }
  return err.instancePath;
}

/**
 * Создать реестр: компилирует и кэширует core-схемы, компилирует author paramsSchema с мемоизацией.
 * Один ajv-инстанс (`allErrors:true` — полный набор причин, FR-022; `strict:false` — совместимость
 * с генерируемыми схемами). Core-схемы (с их `$id`) поставляет contracts-пакет, поэтому межсхемные
 * `$ref` и `validateRef` по `$id` резолвятся внутри одного инстанса.
 */
export function createSchemaRegistry(): SchemaRegistry {
  const ajv = new Ajv({ allErrors: true, strict: false });

  // Компиляция core-схемы регистрирует её по `$id` в инстансе ajv, поэтому межсхемные `$ref`
  // и `validateRef(refId)` (по `$id`-ветке) резолвятся внутри одного инстанса.
  const coreCache = new Map<CoreSchemaName, ValidateFunction>();
  for (const name of Object.keys(SCHEMA_IDS) as CoreSchemaName[]) {
    coreCache.set(name, ajv.compile(schemaAsset(name)));
  }

  const paramsCache = new Map<string, ParamsCompileResult>();

  return {
    validateCore(name, data) {
      const validate = coreCache.get(name);
      if (validate === undefined) {
        throw new Error(`schema-registry: unknown core schema "${name}"`);
      }
      validate(data);
      return validate.errors ?? [];
    },
    validateRef(refId, data) {
      const validate = ajv.getSchema(refId);
      if (validate === undefined) {
        throw new Error(`schema-registry: unknown ref "${refId}"`);
      }
      validate(data);
      return validate.errors ?? [];
    },
    compileParams(paramsSchema) {
      const key = JSON.stringify(paramsSchema);
      const cached = paramsCache.get(key);
      if (cached !== undefined) return cached;
      let result: ParamsCompileResult;
      try {
        result = { ok: true, validate: ajv.compile(paramsSchema) };
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      paramsCache.set(key, result);
      return result;
    },
  };
}
