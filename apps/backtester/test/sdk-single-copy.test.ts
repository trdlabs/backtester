// Страж ВРЕМЕННОГО override `@trdlabs/sdk`.
//
// Единственность копии и «приложение упирается в точный пин движка» уже проверяет
// `engine-pin-single-sdk.test.ts` (срез S3) — второй реализации тех же проверок
// здесь намеренно нет. Этот файл закрывает ровно то, чего там не было: если
// override когда-нибудь понадобится, он обязан исчезнуть в тот же день, когда
// перестанет быть нужным.
//
// Зачем страж. Движок — авторитет версии контракта: он пинит SDK точно, приложение
// обязано разрешиться в тот же пин. Если приложению понадобится SDK новее, чем
// пинит движок, единственный способ сохранить ОДНУ копию — override, потому что
// бренды `TimestampUs`/`DurationUs` номинальны и две копии это два разных типа.
// Но override молча пиннит SDK для всего дерева, и оставленный «на всякий случай»
// однажды удержит старую версию там, где ждут новую.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

describe('override @trdlabs/sdk — только пока движок требует несовместимую версию', () => {
  it('нужен override ⇔ установленный SDK не удовлетворяет требованию движка', () => {
    const enginePkgPath = join(ROOT, 'apps/backtester/node_modules/@trdlabs/engine/package.json');
    const sdkLink = join(ROOT, 'apps/backtester/node_modules/@trdlabs/sdk');
    if (!existsSync(enginePkgPath) || !existsSync(sdkLink)) return;

    const required = readJson<{ dependencies?: Record<string, string> }>(enginePkgPath)
      .dependencies?.['@trdlabs/sdk'];
    if (required === undefined) return;

    // Сравнивается УСТАНОВЛЕННАЯ версия с требованием движка, а не два диапазона:
    // `^0.15.0` и `0.15.0` — разные строки и одно и то же требование, и сравнение
    // строк дало бы ответ о синтаксисе, а не о совместимости.
    //
    // Точного равенства здесь достаточно, и это не упрощение: срез S3 отдельно
    // утверждает, что движок пинит SDK ТОЧНОЙ версией, а не диапазоном. Если это
    // однажды перестанет быть правдой, проверка ниже выйдет раньше и скажет об
    // этом, вместо того чтобы молча ответить «несовместимо».
    if (!/^\d+\.\d+\.\d+$/.test(required)) return;
    const installed = readJson<{ version: string }>(join(realpathSync(sdkLink), 'package.json')).version;
    const compatible = installed === required;

    const workspace = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
    const overrideIdx = workspace.indexOf('overrides:');
    const overridePresent = overrideIdx !== -1
      && /^\s+'@trdlabs\/sdk':/m.test(workspace.slice(overrideIdx));

    if (compatible) {
      expect(
        overridePresent,
        `установленный SDK ${installed} удовлетворяет требованию движка ${required} — `
          + 'override в pnpm-workspace.yaml не нужен и должен быть удалён',
      ).toBe(false);
    } else {
      expect(
        overridePresent,
        `движок требует ${required}, установлен ${installed} — без override в дереве будет две копии SDK`,
      ).toBe(true);
    }
  });
});
