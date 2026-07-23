// Генерация ENV.md и .env.example из env-схемы (env-catalog item 3).
// Оба артефакта ПРОИЗВОДЯТСЯ из схемы, не пишутся руками; дрейф пинует
// apps/backtester/test/env-schema.test.ts (сравнение диска с генератором).
// Запись на диск: npm run env:docs (scripts/gen-env-docs.ts).

import type { EnvSchemaDocument, EnvSchemaVariable } from './env';

const SECRET_COMMENT = '# secret — значение в SOPS/age-контуре, см. b2c-ops-hardening item 3';

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function flagCell(v: EnvSchemaVariable): string {
  if (!v.flag) return '';
  return `flag: ${v.flag_states!.join('/')}, default ${v.default_state!}`;
}

/** ENV.md: таблица имя/тип/required/default/secret/flag/описание. Детерминированно из схемы. */
export function renderEnvMd(doc: EnvSchemaDocument): string {
  const lines: string[] = [
    '<!-- GENERATED FILE — не редактировать руками. Источник: apps/backtester/src/env.ts;',
    '     перегенерация: npm run env:docs. Контракт: control-center docs/architecture/contracts/env-schema.md -->',
    '',
    '# Environment variables — trading-backtester',
    '',
    `Схема: \`${doc.generated_from}\` (контракт \`${doc.schema_version}\`). Машинный экспорт: \`npm run env:schema\`.`,
    '',
    'Секреты: в таблице и example-файлах — только имя и форма, значения живут в SOPS/age-контуре',
    '(b2c-ops-hardening item 3). Флаги — деплой-таймовые E4b-паттерна; `default` у флага в схеме',
    'пуст, фактическое состояние без переменной несёт `default_state` (`off` = выключен,',
    '`enforce` = включён).',
    '',
    '| Name | Type | Required | Default | Secret | Flag | Owner unit | Description |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const v of doc.variables) {
    const def = v.default === null ? '—' : `\`${v.default}\``;
    const type = v.type === 'enum' ? `enum(${v.enum_values!.join(', ')})` : v.type;
    lines.push(
      `| \`${v.name}\` | ${type} | ${v.required ? 'yes' : 'no'} | ${def} | ${v.secret ? 'yes' : ''} | ${flagCell(v)} | ${v.owner_unit} | ${mdEscape(v.description)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * .env.example: по строке на переменную в порядке схемы; каждой предшествует комментарий
 * из description. Правила контракта: NAME=default при дефолте; NAME= для required без дефолта
 * и для секретов (+ SOPS-комментарий); # NAME= для optional без дефолта.
 */
export function renderEnvExample(doc: EnvSchemaDocument): string {
  const lines: string[] = [
    '# GENERATED FILE — не редактировать руками. Источник: apps/backtester/src/env.ts;',
    '# перегенерация: npm run env:docs.',
    '',
  ];
  for (const v of doc.variables) {
    lines.push(`# ${v.description}`);
    if (v.flag) lines.push(`# flag [${v.flag_states!.join('|')}], default_state: ${v.default_state!}`);
    if (v.secret) {
      lines.push(SECRET_COMMENT);
      lines.push(`${v.name}=`);
    } else if (v.required && v.default === null) {
      lines.push(`${v.name}=`);
    } else if (v.default !== null) {
      lines.push(`${v.name}=${v.default}`);
    } else {
      lines.push(`# ${v.name}=`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
