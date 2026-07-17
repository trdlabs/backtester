// Fail-closed pre-publish gate: proceed ONLY when a package@version is *confirmably*
// absent from npm (a genuine E404). A version that already exists must stop the
// release, and — crucially — so must any indeterminate outcome (registry 5xx, DNS,
// auth, rate-limit, timeout), which a naive `if npm view … ; then exit 1` would
// misread as "absent → safe to publish".
//
// Usage: tsx scripts/assert-version-publishable.ts <pkg> <version>
// Exit:  0 = publishable (confirmed absent) · 1 = already-published OR indeterminate.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface NpmViewResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type Publishability = 'publishable' | 'already-published' | 'indeterminate';

/** Pure classifier over an `npm view <pkg>@<version> version` invocation. */
export function classifyNpmView(r: NpmViewResult): Publishability {
  const out = r.stdout.trim();
  // A clean success with a version string printed means the version exists.
  if (r.status === 0 && out.length > 0) return 'already-published';

  const combined = `${r.stdout}\n${r.stderr}`;
  // npm reports a missing package OR missing exact version with an E404 / 404.
  const isE404 =
    /\bE404\b/.test(combined) ||
    /npm error 404/i.test(combined) ||
    /No match found for version/i.test(combined) ||
    /is not in this registry|could not be found/i.test(combined);
  if (isE404) return 'publishable';

  // status 0 but empty output, or any other non-zero (network / DNS / auth / 5xx /
  // rate limit): we cannot confirm absence — fail closed.
  return 'indeterminate';
}

export function runNpmView(spec: string): NpmViewResult {
  const r = spawnSync('npm', ['view', spec, 'version'], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function main(argv: readonly string[]): number {
  const [pkg, version] = argv;
  if (!pkg || !version) {
    console.error('Usage: tsx scripts/assert-version-publishable.ts <pkg> <version>');
    return 1;
  }
  const spec = `${pkg}@${version}`;
  const decision = classifyNpmView(runNpmView(spec));
  switch (decision) {
    case 'publishable':
      console.log(`OK   ${spec} is not published — publishable.`);
      return 0;
    case 'already-published':
      console.error(`::error::${spec} already exists on npm — refusing to republish.`);
      return 1;
    case 'indeterminate':
      console.error(
        `::error::Could not confirm ${spec} is absent from npm (registry/network/auth error). ` +
          `Failing closed instead of publishing on an unverified state.`,
      );
      return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
