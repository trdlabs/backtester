/**
 * 026 Long OI StrategyModule — 017 манифест (contracts/module-interface.md, §2 data-model).
 *
 * Форма зеркалит вывод `buildStrategyManifest` (021): `kind:'strategy'`, `status:'research_only'`,
 * `capabilities:{platformSdk:true}`, `contractVersion=CONTRACT_VERSION`. Собран как литерал, чтобы
 * модуль импортировал ТОЛЬКО `@trdlabs/sdk/research-contract` (forbidden-boundary; не тянет builder-sdk).
 * `dataNeeds` несёт closed/oi/liq и НЕ несёт lookahead/nondeterminism-флагов (long_oi rule-based,
 * `asOfIndicators:false` — без TA, R4).
 */

import { CONTRACT_VERSION } from '@trdlabs/sdk/research-contract';
import type { ModuleManifest } from '@trdlabs/sdk/research-contract';
import { DEFAULT_PARAMS, paramsSchema } from './params.js';

export const LONG_OI_MANIFEST: ModuleManifest = {
  id: 'long_oi',
  version: '1.0.0',
  kind: 'strategy',
  name: 'Long OI',
  summary: 'Единый long-only модуль long_oi: вход после dump c восстановлением OI/ликвидациями, DCA, TP-ладдер, BE.',
  rationale:
    'Унификация legacy dump_long как одного 017 StrategyModule для бэктест- и live-хостов (026); ' +
    'detect dump → watch → confirm (OI-recovery + bounce + long-liq) → enter; in-position TP1/TP2/BE/DCA/fail_fast.',
  author: 'human',
  contractVersion: CONTRACT_VERSION, // '017.1' — НЕ бампится (FR-022)
  status: 'research_only',
  paramsSchema,
  params: DEFAULT_PARAMS,
  capabilities: { platformSdk: true },
  dataNeeds: {
    closedCandlesUpToCurrent: true,
    openInterest: true,
    liquidations: true,
    asOfIndicators: false,
  },
  hooks: ['onBarClose', 'onPositionBar'],
};
