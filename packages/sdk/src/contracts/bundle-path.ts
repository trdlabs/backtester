// Shared unsafe-bundle-path predicate — the SINGLE source of truth for BOTH the SDK preflight
// (preflightValidateBundle) and the service validator (apps/backtester/src/sandbox/bundle.ts), so the
// two can never drift (they previously did: the service used a naive `includes('..')` substring, which
// wrongly rejected `a..b.js` and wrongly ACCEPTED backslash / colon / NUL paths).
//
// A path is unsafe if it is absolute (POSIX `/…` or a Windows drive `C:/…`), empty, contains
// backslashes, a colon (drive letter / scheme), a NUL byte, or any `.` / `..` path segment. The
// segment-exact `.` / `..` check is intentional and narrower than a substring match — a filename like
// `a..b` is valid; do not "simplify" it back to `includes('..')`.
export function isUnsafeBundlePath(path: string): boolean {
  if (path.length === 0) return true;
  if (path.startsWith('/')) return true;
  if (path.includes('\\')) return true;
  if (path.includes('\0')) return true;
  if (path.includes(':')) return true;
  return path.split('/').some((seg) => seg === '..' || seg === '.');
}
