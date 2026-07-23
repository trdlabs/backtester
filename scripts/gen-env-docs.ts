// `npm run env:docs` — перегенерирует ENV.md и .env.example из env-схемы (единственный
// источник правды — apps/backtester/src/env.ts). Дрейф диска с генератором пинует
// apps/backtester/test/env-schema.test.ts.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { envSchemaDocument } from '../apps/backtester/src/env';
import { renderEnvExample, renderEnvMd } from '../apps/backtester/src/env-docs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = envSchemaDocument();

writeFileSync(resolve(ROOT, 'ENV.md'), renderEnvMd(doc));
writeFileSync(resolve(ROOT, '.env.example'), renderEnvExample(doc));
// eslint-disable-next-line no-console
console.error(`env:docs — записаны ENV.md и .env.example (${doc.variables.length} переменных)`);
