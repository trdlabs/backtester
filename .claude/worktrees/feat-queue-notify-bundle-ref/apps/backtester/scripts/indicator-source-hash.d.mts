// Slice 6b-A — type surface for the shared drift-hash module (the impl is plain ESM .mjs so the build
// script can run it with bare `node`, no tsx). Lets the TS drift-guard test import it without `any`.

/** sha256 (hex) over the canonical, sorted file map of src/engine/indicators/**. */
export function computeIndicatorSourceHash(): string;
