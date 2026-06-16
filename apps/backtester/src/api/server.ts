// HTTP API (Fastify) — the service-to-service surface. Renders the 031 gateway operations as REST.
// Bearer auth on every /v1 route, fail-closed. See docs/ARCHITECTURE.md §4.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type {
  ArtifactPage,
  CapabilityDescriptor,
  RunSubmitRequest,
  ValidationIssue,
  ValidationReport,
} from '@trading/research-contracts';
import { ARTIFACT_CONTRACT_VERSION, CONTRACT_VERSION, METRIC_CATALOG } from '@trading/research-contracts';
import type { BacktesterDataPort } from '../data/reader';
import type { ArtifactStore } from '../artifacts/store';
import { toStatusView, type JobStore } from '../jobs/job-store';
import { isTerminal } from '../jobs/lifecycle';
import { publishCompletion, reapAndPublish, type CompletionDeps } from '../jobs/completion';
import { submitRun, SubmitError, type SubmitDeps } from '../jobs/submit';

export interface ServerDeps extends SubmitDeps, CompletionDeps {
  store: JobStore;
  dataPort: BacktesterDataPort;
  artifactStore: ArtifactStore;
  authToken: string;
  maxConcurrency: number;
  /** Schedules a worker drain after a run is enqueued (noop in tests that drain manually). */
  kick: () => void;
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .send({ category: 'validation_error', code: 'unauthorized', message: 'missing or invalid bearer token' });
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/v1/')) return;
    const header = req.headers.authorization;
    if (header !== `Bearer ${deps.authToken}`) {
      return unauthorized(reply);
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/v1/capabilities', async (): Promise<CapabilityDescriptor> => ({
    contractVersion: CONTRACT_VERSION,
    artifactContractVersion: ARTIFACT_CONTRACT_VERSION,
    supportedMetrics: [...METRIC_CATALOG],
    supportedModes: ['research', 'review', 'promotion'],
    maxConcurrency: deps.maxConcurrency,
  }));

  app.get('/v1/datasets', async () => ({ datasets: await deps.dataPort.listDatasets() }));

  app.post('/v1/modules/validate', async (req): Promise<ValidationReport> => {
    const body = req.body as Partial<RunSubmitRequest> | undefined;
    const issues: ValidationIssue[] = [];
    if (!body || typeof body !== 'object') {
      issues.push({ code: 'schema_invalid', severity: 'error', message: 'body must be an object' });
    }
    return { status: issues.length > 0 ? 'rejected' : 'accepted', issues, executed: false };
  });

  app.post('/v1/runs', async (req, reply) => {
    try {
      const outcome = await submitRun(deps, req.body as RunSubmitRequest);
      if (outcome.created) deps.kick();
      return reply.code(202).send(outcome.handle);
    } catch (err) {
      if (err instanceof SubmitError) {
        return reply.code(err.statusCode).send({ category: 'validation_error', code: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/v1/runs', async (req) => {
    const q = req.query as { status?: string; correlationId?: string; workflowId?: string };
    const jobs = await deps.store.list({
      status: q.status as never,
      correlationId: q.correlationId,
      workflowId: q.workflowId,
    });
    return { runs: jobs.map(toStatusView) };
  });

  app.get('/v1/runs/:runId/status', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    await reapAndPublish(deps);
    const job = await deps.store.get(runId);
    if (!job) return reply.code(404).send({ category: 'validation_error', code: 'run_not_found', message: runId });
    return toStatusView(job);
  });

  app.get('/v1/runs/:runId/result', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    await reapAndPublish(deps);
    const job = await deps.store.get(runId);
    if (!job) return reply.code(404).send({ category: 'validation_error', code: 'run_not_found', message: runId });
    if (job.resultSummary) return job.resultSummary;
    return reply.code(409).send({
      runId,
      status: job.status,
      ...(job.terminalCode !== undefined ? { terminalCode: job.terminalCode } : {}),
      message: isTerminal(job.status) ? 'run produced no result summary' : 'run not complete',
    });
  });

  app.get('/v1/runs/:runId/artifacts', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const job = await deps.store.get(runId);
    if (!job?.artifactManifest) {
      return reply.code(404).send({ category: 'validation_error', code: 'manifest_not_found', message: runId });
    }
    return job.artifactManifest;
  });

  app.get('/v1/runs/:runId/artifacts/:artifactId', async (req, reply) => {
    const { runId, artifactId } = req.params as { runId: string; artifactId: string };
    const q = req.query as { offset?: string; limit?: string };
    const job = await deps.store.get(runId);
    const descriptor = job?.artifactManifest?.descriptors.find((d) => d.contentHash === artifactId);
    if (!job || !descriptor) {
      return reply.code(404).send({ category: 'validation_error', code: 'artifact_not_found', message: artifactId });
    }
    const payload = await deps.artifactStore.read(descriptor.contentHash);
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.max(1, Number(q.limit ?? 100) || 100);
    const items = Array.isArray(payload) ? payload : [payload];
    const pageItems = items.slice(offset, offset + limit);
    const page: ArtifactPage = {
      artifactId: descriptor.contentHash,
      artifactType: descriptor.artifactType,
      page: pageItems,
      total: items.length,
      offset,
      ...(offset + limit < items.length ? { nextCursor: String(offset + limit) } : {}),
    };
    return page;
  });

  app.post('/v1/runs/:runId/cancel', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const job = await deps.store.get(runId);
    if (!job) return reply.code(404).send({ category: 'validation_error', code: 'run_not_found', message: runId });
    if (!isTerminal(job.status)) {
      const now = deps.clock();
      await deps.store.transition(runId, job.status, 'canceled', {
        atMs: now,
        terminalAtMs: now,
        terminalCode: 'canceled',
      });
      const canceled = await deps.store.get(runId);
      if (canceled) await publishCompletion(deps, canceled);
    }
    const updated = await deps.store.get(runId);
    return toStatusView(updated!);
  });

  return app;
}
