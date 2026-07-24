// TQ-1 (control-center `test-quality-hardening`) — машинная классификация skip-поверхности.
//
// Две половины:
//   1. юниты классификатора на синтетических исходниках — все четыре класса, вложенные скобки в
//      выражении гейта, прагма-аллоулист, ложные срабатывания в комментариях/строках;
//   2. репо-гейт: аудит реального дерева не находит ни `.only`, ни безусловных `.skip` без прагмы.
//      Именно он не даёт skip-поверхности молча разъехаться после закрытия TQ-1.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditTree, classifyGate, isViolation, scanSource } from '../scripts/lib/skip-audit.js';

describe('classifyGate', () => {
  it('распознаёт канонические гейты', () => {
    expect(classifyGate('!DOCKER_AVAILABLE')).toBe('docker');
    expect(classifyGate('!PG_AVAILABLE')).toBe('postgres');
    expect(classifyGate('!factory.available')).toBe('store-factory');
    expect(classifyGate('!existsSync(VERIFIER_PATH)')).toBe('fixture-file');
    expect(classifyGate("process.env.RUN_BENCH !== '1'")).toBe('env-opt-in');
    expect(classifyGate('!enabled')).toBe('other');
  });

  it('составной гейт классифицируется по первому известному признаку', () => {
    expect(classifyGate('!DOCKER_AVAILABLE || !PG_AVAILABLE')).toBe('docker');
    expect(classifyGate('!PG_AVAILABLE || !DOCKER_AVAILABLE')).toBe('docker');
  });
});

describe('scanSource', () => {
  it('классифицирует skipIf как gated с выражением гейта', () => {
    const [site] = scanSource("describe.skipIf(!DOCKER_AVAILABLE)('x', () => {});", 'a.test.ts');
    expect(site).toMatchObject({
      file: 'a.test.ts',
      block: 'describe',
      modifier: 'skipIf',
      cls: 'gated',
      gateKind: 'docker',
      gate: '!DOCKER_AVAILABLE',
      line: 1,
    });
  });

  it('вложенные скобки в гейте не рвут разбор', () => {
    const [site] = scanSource("it.skipIf(!existsSync(join(a, 'b')))('x', () => {});", 'a.test.ts');
    expect(site.gate).toBe("!existsSync(join(a, 'b'))");
    expect(site.cls).toBe('gated');
    expect(site.gateKind).toBe('fixture-file');
  });

  it('безусловный skip без прагмы — unconditional и нарушение', () => {
    const [site] = scanSource("it.skip('x', () => {});", 'a.test.ts');
    expect(site.cls).toBe('unconditional');
    expect(isViolation(site)).toBe(true);
  });

  it('прагма строкой выше делает skip allowed и сохраняет причину', () => {
    const [site] = scanSource("// skip-audit:allow — ждём фикса платформы\nit.skip('x', () => {});", 'a.test.ts');
    expect(site.cls).toBe('allowed');
    expect(site.reason).toBe('ждём фикса платформы');
    expect(isViolation(site)).toBe(false);
  });

  it('.only — нарушение даже с прагмой', () => {
    const [site] = scanSource("// skip-audit:allow — нет\nit.only('x', () => {});", 'a.test.ts');
    expect(site.cls).toBe('focused');
    expect(isViolation(site)).toBe(true);
  });

  it('ссылочная форма без вызова тоже сайт', () => {
    const [site] = scanSource('const t = ok ? it : it.skip;', 'a.test.ts');
    expect(site.cls).toBe('unconditional');
    expect(site.modifier).toBe('skip');
  });

  it('упоминания внутри комментариев и строк игнорируются', () => {
    expect(scanSource('// it.skip(\'x\')\nconst s = "describe.only(";', 'a.test.ts')).toEqual([]);
  });

  it('номера строк считаются по исходнику, а не по очищенному тексту', () => {
    const src = "/* c\nc */\n\nit.skip('x', () => {});";
    expect(scanSource(src, 'a.test.ts')[0].line).toBe(4);
  });

  it('todo без прагмы — тоже unconditional', () => {
    const [site] = scanSource("it.todo('когда-нибудь');", 'a.test.ts');
    expect(site.modifier).toBe('todo');
    expect(site.cls).toBe('unconditional');
  });
});

// ---------------------------------------------------------------------------------------------
// Репо-гейт
// ---------------------------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('репо-гейт: skip-поверхность backtester', () => {
  it('не содержит .only и безусловных .skip без прагмы', () => {
    const violations = auditTree(REPO_ROOT).filter(isViolation);
    expect(violations.map((v) => `${v.file}:${v.line} ${v.block}.${v.modifier}`)).toEqual([]);
  });

  it('находит непустую условную поверхность (сканер реально дошёл до файлов)', () => {
    expect(auditTree(REPO_ROOT).filter((s) => s.cls === 'gated').length).toBeGreaterThan(20);
  });
});
