// Content-addressed bundle upload/lookup — lets a client upload once and submit runs by `bundleRef`
// (hash) instead of re-sending the full ModuleBundle on every /v1/runs call. See B1/B2 (submitRun
// bundleRef acceptance) — this is the HTTP surface over the same BundleStore.

import type { FastifyInstance } from 'fastify';
import type { ContentHash } from '@trading-backtester/sdk/artifacts';
import type { ModuleBundle } from '@trading-backtester/sdk/contracts';
import type { ServerDeps } from './server.js';
// The SAME one-arg structural validator /v1/modules/validate calls on body.moduleBundle.
// Signature: validateBundle(input: unknown): BundleIssue[]  where BundleIssue = { code: string; message: string }.
import { validateBundle } from '../sandbox/bundle.js';

const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function registerBundleRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post('/v1/bundles', async (req, reply) => {
    if (!deps.bundleStore) {
      return reply
        .code(400)
        .send({ category: 'validation_error', code: 'validation_error', message: 'bundle store not enabled' });
    }
    const issues = validateBundle(req.body); // structural; takes `unknown`, so a garbage body is safe
    if (issues.length > 0) {
      return reply
        .code(400)
        .send({ category: 'validation_error', code: 'bundle_invalid', message: issues[0].message, issues });
    }
    const hash = await deps.bundleStore.put(req.body as ModuleBundle);
    return reply.code(200).send({ hash });
  });

  app.head('/v1/bundles/:hash', async (req, reply) => {
    const { hash } = req.params as { hash: string };
    if (!CONTENT_HASH_RE.test(hash)) return reply.code(400).send();
    if (!deps.bundleStore) return reply.code(404).send();
    return reply.code((await deps.bundleStore.has(hash as ContentHash)) ? 200 : 404).send();
  });
}
