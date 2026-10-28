import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { bearerTokenValid, isAllowedWebSocketOrigin, normalizeHostname } from '../wsAuth.js';
import { FLEET_MAX_PROMPT } from './profiles.js';
import type { FleetService } from './service.js';

export function registerFleetRoutes(
  app: FastifyInstance,
  fleet: FleetService,
  token: string,
  hosts: ReadonlySet<string>,
): void {
  const authorize = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!bearerTokenValid(req.headers.authorization, token))
      return reply.code(401).send({ error: 'Open the tokened URL printed by the server' });
    const host = normalizeHostname(req.headers.host);
    if (
      !host ||
      !hosts.has(host) ||
      !isAllowedWebSocketOrigin(req.headers.origin, req.headers.host)
    )
      return reply.code(403).send({ error: 'Untrusted origin or host' });
  };
  app.post<{ Params: { id: string } }>(
    '/api/fleet/profiles/:id/diagnose',
    { preHandler: authorize },
    async (req, reply) => {
      try {
        return await fleet.diagnose(req.params.id);
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : 'Diagnostic failed' });
      }
    },
  );
  app.get('/api/fleet', { preHandler: authorize }, async () => fleet.snapshot());
  app.get('/api/fleet/timeline', { preHandler: authorize }, async () => fleet.timeline.snapshot());
  app.get<{ Params: { id: string } }>(
    '/api/fleet/conversations/:id',
    { preHandler: authorize },
    async (req, reply) =>
      fleet.getConversation(Number(req.params.id)) ??
      reply.code(404).send({ error: 'Unknown conversation' }),
  );
  app.post<{ Params: { id: string }; Body: { visible: boolean } }>(
    '/api/fleet/conversations/:id/visibility',
    {
      preHandler: authorize,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['visible'],
          properties: { visible: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      if (!fleet.getConversation(Number(req.params.id)))
        return reply.code(404).send({ error: 'Unknown conversation' });
      fleet.setConversationVisible(Number(req.params.id), req.body.visible);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/fleet/runs/:id/events',
    {
      preHandler: authorize,
      bodyLimit: 64 * 1024,
      schema: { body: { type: 'object' } },
    },
    async (req, reply) => {
      if (!fleet.get(Number(req.params.id))) return reply.code(404).send({ error: 'Unknown run' });
      try {
        return { conversationId: fleet.ingest(Number(req.params.id), req.body) };
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : 'Invalid event' });
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/fleet/runs/:id',
    { preHandler: authorize },
    async (req, reply) => {
      const run = fleet.get(Number(req.params.id));
      return run ?? reply.code(404).send({ error: 'Unknown run' });
    },
  );
  app.post<{ Body: { profileId: string; prompt?: string } }>(
    '/api/fleet/runs',
    {
      preHandler: authorize,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['profileId'],
          properties: {
            profileId: { type: 'string', minLength: 1 },
            prompt: { type: 'string', maxLength: FLEET_MAX_PROMPT },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return reply
          .code(201)
          .send({ id: fleet.launch(req.body.profileId, req.body.prompt ?? '') });
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : 'Launch failed' });
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/fleet/runs/:id/stop',
    { preHandler: authorize },
    async (req, reply) => {
      if (!fleet.get(Number(req.params.id))) return reply.code(404).send({ error: 'Unknown run' });
      fleet.stop(Number(req.params.id));
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/fleet/runs/:id',
    { preHandler: authorize },
    async (req, reply) => {
      if (!fleet.get(Number(req.params.id))) return reply.code(404).send({ error: 'Unknown run' });
      fleet.dismiss(Number(req.params.id));
      return { ok: true };
    },
  );
}
