// Mount-source abstraction: one docker-run arg builder works in both bind (dev/host-process)
// and volume (demo/DooD) modes. A named volume is resolved by the daemon by name, regardless of
// the caller's filesystem — which removes the host↔container bind-mount path aliasing under DooD.

import { isAbsolute, relative } from 'node:path';

/** How a content dir reaches the sandbox container. */
export type MountSource =
  | { readonly kind: 'bind'; readonly hostPath: string }
  | { readonly kind: 'volume'; readonly volume: string; readonly subpath: string };

/** Selected mount mode for a sandbox run. */
export type MountConfig =
  | { readonly mode: 'bind' }
  | { readonly mode: 'volume'; readonly volume: string; readonly mountpoint: string };

/** Resolve the mount mode from optional volume + mountpoint (env-driven). Both or neither. */
export function mountConfigFor(volume: string | undefined, mountpoint: string | undefined): MountConfig {
  if (volume !== undefined && mountpoint !== undefined) {
    return { mode: 'volume', volume, mountpoint };
  }
  if (volume === undefined && mountpoint === undefined) {
    return { mode: 'bind' };
  }
  throw new Error(
    'sandbox volume config: set both BACKTESTER_SANDBOX_OVERLAY_VOLUME and ' +
      'BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT, or neither',
  );
}

/** Turn a dir on the backtester's filesystem into the MountSource for the sandbox `docker run`. */
export function toMountSource(cfg: MountConfig, dir: string): MountSource {
  if (cfg.mode === 'bind') return { kind: 'bind', hostPath: dir };
  if (!isAbsolute(cfg.mountpoint)) {
    throw new Error(`toMountSource: volume mountpoint must be an absolute path, got ${cfg.mountpoint}`);
  }
  const sub = relative(cfg.mountpoint, dir);
  if (sub === '' || sub.startsWith('..') || isAbsolute(sub)) {
    throw new Error(`toMountSource: ${dir} is not under the volume mountpoint ${cfg.mountpoint}`);
  }
  return { kind: 'volume', volume: cfg.volume, subpath: sub };
}
