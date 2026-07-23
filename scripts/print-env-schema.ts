// `npm run env:schema` — печатает документ env-schema.1 в stdout (контракт: JSON, 2 пробела,
// variables отсортированы по name, завершающий перевод строки). Файл env-schema.json в репо
// НЕ коммитится — агрегатор control-center и CI-гейты захватывают stdout этой команды.
import { renderEnvSchemaJson } from '../apps/backtester/src/env';

process.stdout.write(renderEnvSchemaJson());
