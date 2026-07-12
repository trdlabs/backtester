import { describe, expect, it } from 'vitest';
import { parseResponseLine } from '../src/engine/sandbox/async-ipc-channel.js';

describe('okBarMajor response parse', () => {
  it('parses a well-formed tagged per-entry okBarMajor', () => {
    const line = JSON.stringify({ t: 'okBarMajor', seq: 5, results: [
      { ok: true, decisions: ['SIG'] },
      { ok: false, error: { code: 'sandbox_crashed', detail: 'boom' } },
    ]});
    expect(parseResponseLine(line)).toEqual({
      kind: 'okBarMajor', seq: 5, results: [
        { ok: true, decisions: ['SIG'] },
        { ok: false, error: { code: 'sandbox_crashed', detail: 'boom' } },
      ],
    });
  });

  it('rejects results that is not an array → malformed', () => {
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: 'x' })).kind).toBe('malformed');
  });

  it('rejects an entry that is neither a valid ok nor a valid err variant → malformed', () => {
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ ok: true }] })).kind).toBe('malformed');
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ nope: 1 }] })).kind).toBe('malformed');
  });

  it('rejects a false entry whose error lacks string code/detail → malformed (no defaulting)', () => {
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ ok: false, error: { code: 'x' } }] })).kind).toBe('malformed');
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ ok: false, error: {} }] })).kind).toBe('malformed');
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ ok: false }] })).kind).toBe('malformed');
  });
});
