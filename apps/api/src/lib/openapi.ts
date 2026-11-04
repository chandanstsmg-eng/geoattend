/** Builds an OpenAPI 3.1 document from the route registry (zod → JSON Schema). */
import { z } from 'zod';
import { registry } from './http.js';

function schema(s: z.ZodType | undefined) {
  if (!s) return undefined;
  try {
    return z.toJSONSchema(s, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' });
  } catch {
    return {};
  }
}

function params(s: z.ZodType | undefined, where: 'path' | 'query') {
  const js: any = schema(s);
  if (!js?.properties) return [];
  return Object.entries(js.properties).map(([name, sch]) => ({ name, in: where, required: where === 'path' || (js.required ?? []).includes(name), schema: sch }));
}

export function buildOpenApi() {
  const paths: Record<string, any> = {};
  for (const { tag, fullPath, def } of registry) {
    const p = fullPath.replace(/:(\w+)/g, '{$1}').replace(/\/$/, '') || '/';
    paths[p] ??= {};
    paths[p][def.method] = {
      tags: [tag],
      summary: def.summary,
      security: def.access === 'public' ? [] : [{ bearer: [] }, { cookie: [] }],
      'x-access': def.access,
      parameters: [...params(def.params, 'path'), ...params(def.query, 'query')],
      ...(def.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(def.body) } } } } : {}),
      responses: {
        '200': { description: 'Success' },
        '400': { description: 'Validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        ...(def.access === 'public' ? {} : { '401': { description: 'Not signed in' }, '403': { description: 'Wrong role or not your resource' } }),
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'GeoAttend API',
      version: '1.0.0',
      description:
        'Server-validated geofenced attendance and shift-scoped tracking. Mobile clients authenticate with Bearer tokens; the web dashboard uses httpOnly cookies plus an X-CSRF-Token header for state-changing requests. Client GPS readings are treated as untrusted evidence.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        cookie: { type: 'apiKey', in: 'cookie', name: 'ga_at' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} }, required: ['code', 'message'] } },
        },
      },
    },
    paths,
  };
}
