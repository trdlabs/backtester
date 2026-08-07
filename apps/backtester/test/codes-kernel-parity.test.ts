// Дрейф-гейт: `CODE_SEVERITY` приложения против авторитетной карты ядра
// (`@trdlabs/sdk/validation`). Наша карта — ручное зеркало: тип
// `Record<ValidationCode, Severity>` заставляет дописать новый код ядра руками, но НЕ проверяет,
// что severity выбрана та же. Расхождение означало бы, что один и тот же отказ блокирует приём
// в ядре и не блокирует у нас — молча, до первого прогона, который проехал бы дальше, чем должен.
//
// Ловится ровно то, что не поймал бы typecheck: подъём `@trdlabs/sdk`, в котором severity
// существующего кода поменялась, и опечатка при досыпке новых кодов.

import { describe, expect, it } from 'vitest';
import { CODE_SEVERITY as KERNEL_CODE_SEVERITY } from '@trdlabs/sdk/validation';
import { ALL_VALIDATION_CODES, CODE_SEVERITY } from '../src/engine/validation/codes.js';

describe('017 CODE_SEVERITY ↔ kernel parity', () => {
  it('covers exactly the kernel taxonomy — no extra, no missing code', () => {
    expect([...ALL_VALIDATION_CODES].sort()).toEqual(Object.keys(KERNEL_CODE_SEVERITY).sort());
  });

  it('assigns every code the kernel severity', () => {
    expect(CODE_SEVERITY).toEqual(KERNEL_CODE_SEVERITY);
  });
});
