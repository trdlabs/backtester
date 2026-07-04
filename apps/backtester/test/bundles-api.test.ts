// Real app over the in-memory factory; drive the routes through the app's Fastify server (app.server).
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH, makeApp, makeBundle } from './helpers.js';
import { STORE_FACTORIES } from './store-factories.js';
import { bundleHash } from '../src/sandbox/bundle.js';

const memFactory = STORE_FACTORIES.find((f) => f.name === 'in-memory')!;
let teardown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await teardown?.();
  teardown = undefined;
});

async function server() {
  const { app, cleanup } = await makeApp(memFactory);
  teardown = cleanup;
  return app.server; // FastifyInstance (AppHandles.server)
}

describe('bundles API', () => {
  it('POST /v1/bundles stores a valid bundle (hash matches) and HEAD confirms it', async () => {
    const s = await server();
    const b = makeBundle();
    const res = await s.inject({ method: 'POST', url: '/v1/bundles', headers: AUTH, payload: b });
    expect(res.statusCode).toBe(200);
    expect(res.json().hash).toBe(bundleHash(b));
    expect(
      (await s.inject({ method: 'HEAD', url: `/v1/bundles/${bundleHash(b)}`, headers: AUTH })).statusCode,
    ).toBe(200);
  });
  it('POST /v1/bundles rejects an invalid bundle (400)', async () => {
    const s = await server();
    const res = await s.inject({ method: 'POST', url: '/v1/bundles', headers: AUTH, payload: { not: 'a bundle' } });
    expect(res.statusCode).toBe(400);
  });
  it('HEAD /v1/bundles/:hash — 404 absent, 400 malformed', async () => {
    const s = await server();
    expect(
      (await s.inject({ method: 'HEAD', url: `/v1/bundles/sha256:${'0'.repeat(64)}`, headers: AUTH })).statusCode,
    ).toBe(404);
    expect((await s.inject({ method: 'HEAD', url: '/v1/bundles/nope', headers: AUTH })).statusCode).toBe(400);
  });
});
