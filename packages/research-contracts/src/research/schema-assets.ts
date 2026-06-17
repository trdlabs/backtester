import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Names of the 5 core 017 contract-envelope schemas (committed under schemas/017/). */
export type CoreSchemaName =
  | 'module-manifest'
  | 'strategy-decision'
  | 'overlay-decision'
  | 'backtest-run-request'
  | 'validation-result';

/** Core-schema name → committed JSON asset filename. Lifted verbatim from the platform registry. */
export const SCHEMA_FILES: Readonly<Record<CoreSchemaName, string>> = {
  'module-manifest': 'module-manifest.schema.json',
  'strategy-decision': 'strategy-decision.schema.json',
  'overlay-decision': 'overlay-decision.schema.json',
  'backtest-run-request': 'backtest-run-request.schema.json',
  'validation-result': 'validation-result.schema.json',
};

/** `$id` of each core schema (parity anchor — must match the platform `schemaId`). */
export const SCHEMA_IDS: Readonly<Record<CoreSchemaName, string>> = {
  'module-manifest': 'https://trading-platform/017/module-manifest.schema.json',
  'strategy-decision': 'https://trading-platform/017/strategy-decision.schema.json',
  'overlay-decision': 'https://trading-platform/017/overlay-decision.schema.json',
  'backtest-run-request': 'https://trading-platform/017/backtest-run-request.schema.json',
  'validation-result': 'https://trading-platform/017/validation-result.schema.json',
};

// This module runs from source (the package has no dist build), so the source dir
// IS the runtime dir: src/research → `..` src → `..` package root → schemas/017.
const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas', '017');

/** Parsed 017 core schema JSON, read from the package's committed assets. */
export function schemaAsset(name: CoreSchemaName): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, SCHEMA_FILES[name]), 'utf8')) as Record<string, unknown>;
}

/** All 5 core schema assets, in catalog order. Task 4 loads these into one ajv instance. */
export function allSchemaAssets(): readonly Record<string, unknown>[] {
  return (Object.keys(SCHEMA_FILES) as CoreSchemaName[]).map(schemaAsset);
}
