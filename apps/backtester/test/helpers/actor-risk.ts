// Привязка НАСТОЯЩЕГО зарегистрированного профиля к actor-раннеру для тестов.
//
// Профиль здесь один и берётся из `profiles.ts` — тот же объект, что стоит в
// `TRUSTED_REGISTRY_DEFINITION.riskProfiles`. Собственный «профиль для тестов» доказывал бы
// семантику на конфигурации, в которую прод попасть не может: ровно тот долг, который этот срез
// закрывает (см. `docs/superpowers/specs/2026-08-14-083-s3-actor-risk-design.md`).

import { DEFAULT_RISK } from '../../src/engine/profiles.js';
import { provenActorRiskProfile } from '../../src/engine/actor/production.js';
import type { ActorRiskBinding } from '../../src/engine/actor/engine-state.js';

/** `default_risk@1.0.0`, суженный до формы, применимой actor-путём. */
export const ACTOR_DEFAULT_RISK = provenActorRiskProfile(DEFAULT_RISK);

/**
 * Привязка профиля к прогону.
 *
 * `initialEquity` обязателен и совпадает с тем, что уехало в `costs`: долевые лимиты профиля
 * считаются от mark-to-market equity, и разойдись эти два числа — лимит считался бы от одного
 * капитала, а бухгалтерия велась от другого.
 */
export function riskBinding(initialEquity: number): ActorRiskBinding {
  return { profile: ACTOR_DEFAULT_RISK, initialEquity };
}
