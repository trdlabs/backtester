// 019 — redaction диагностики (US6; research R9, contracts/error-taxonomy-019; FR-026).
//
// Удаляет из строки диагностики потенциально чувствительное: (а) абсолютные host-пути, (б)
// KEY=VALUE env-фрагменты, (в) известные секрет-паттерны (api-key/token/secret/bearer/PEM-блоки).
// Второй рубеж: sandbox-env пуст (FR-017), сырых секретов там нет — но случайно залогированное
// (host-путь в stderr, и т.п.) НИКОГДА не должно попасть в артефакт (SC-011).

const REPLACEMENT = '[redacted]';

// Порядок важен: сначала многострочные PEM-блоки, затем key:value/env, затем пути.
const PEM_RE = /-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/\-]+=*/gi;
const SECRET_KV_RE = /\b(api[_-]?key|secret|token|password|passwd|credential|access[_-]?key)\b\s*[:=]\s*\S+/gi;
const ENV_KV_RE = /\b[A-Z][A-Z0-9_]{2,}=[^\s'"]+/g; // ENV_STYLE=value
const WIN_PATH_RE = /\b[A-Za-z]:\\[^\s'":]+/g;
const FILE_URL_RE = /file:\/\/[^\s'"]+/gi;
const UNIX_PATH_RE = /\/(?:home|root|app|sandbox|tmp|usr|var|opt|etc|mnt|media|proc|sys|dev)\/[^\s'":,)]*/g;

/**
 * Удалить чувствительные фрагменты из строки. Идемпотентна; не бросает. Возвращает ту же строку, если
 * чувствительного нет.
 */
export function redact(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  let s = input;
  s = s.replace(PEM_RE, `${REPLACEMENT}-key`);
  s = s.replace(BEARER_RE, `bearer ${REPLACEMENT}`);
  s = s.replace(SECRET_KV_RE, (_m, k) => `${k}: ${REPLACEMENT}`);
  s = s.replace(ENV_KV_RE, (m) => `${m.slice(0, m.indexOf('='))}=${REPLACEMENT}`);
  s = s.replace(FILE_URL_RE, `${REPLACEMENT}-path`);
  s = s.replace(WIN_PATH_RE, `${REPLACEMENT}-path`);
  s = s.replace(UNIX_PATH_RE, `${REPLACEMENT}-path`);
  return s;
}
