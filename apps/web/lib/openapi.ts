import { API_ENDPOINTS, API_GROUPS, type ApiEndpoint, type ApiParam } from './api-reference';

/**
 * The API reference as an OpenAPI 3.1 document, built from the same list as the /docs/api page, so a
 * tool (Swagger, Postman, a code generator, an AI agent) reads exactly what a person reads.
 */

type Schema = Record<string, unknown>;

/** The contract this document describes; bump it when a route's shape changes. */
export const API_CONTRACT_VERSION = '2026-09-30';

function schemaOf(param: ApiParam): Schema {
  const base: Schema = { description: param.description };
  switch (param.type) {
    case 'address':
      return { ...base, type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' };
    case 'bytes32':
      return { ...base, type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' };
    case 'uint':
      return { ...base, type: 'string', pattern: '^[1-9][0-9]*$', description: `${param.description} An integer string.` };
    case 'integer':
      return { ...base, type: 'integer', ...(param.min !== undefined ? { minimum: param.min } : {}), ...(param.max !== undefined ? { maximum: param.max } : {}), ...(param.default !== undefined ? { default: Number(param.default) } : {}) };
    case 'boolean':
      return { ...base, type: 'boolean', ...(param.default !== undefined ? { default: param.default === 'true' } : {}) };
    case 'enum':
      return { ...base, type: 'string', enum: [...(param.enum ?? [])], ...(param.default !== undefined ? { default: param.default } : {}) };
    case 'file':
      return { ...base, type: 'string', format: 'binary' };
    case 'object':
      return objectSchema(param.fields ?? [], param.description);
    default:
      return { ...base, type: 'string', ...(param.default !== undefined ? { default: param.default } : {}) };
  }
}

function objectSchema(fields: readonly ApiParam[], description?: string): Schema {
  const required = fields.filter((f) => f.required).map((f) => f.name);
  return {
    type: 'object',
    ...(description ? { description } : {}),
    properties: Object.fromEntries(fields.map((f) => [f.name, schemaOf(f)])),
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function operation(endpoint: ApiEndpoint, limits: Readonly<Record<string, number>>): Schema {
  const parameters = endpoint.params
    .filter((p) => p.in === 'path' || p.in === 'query')
    .map((p) => ({ name: p.name, in: p.in, required: p.in === 'path' ? true : p.required, schema: schemaOf(p), ...(p.example ? { example: p.example } : {}) }));
  const bodyFields = endpoint.params.filter((p) => p.in === 'body' || p.in === 'form');
  const requestBody =
    endpoint.method === 'POST'
      ? {
          required: bodyFields.some((p) => p.required),
          content: { [endpoint.body === 'multipart' ? 'multipart/form-data' : 'application/json']: { schema: objectSchema(bodyFields) } },
        }
      : undefined;
  const ok = endpoint.id === 'image' ? { 'image/*': { schema: { type: 'string', format: 'binary' } } } : { 'application/json': { schema: { type: 'object', description: endpoint.returns } } };
  return {
    operationId: endpoint.id.replace(/-(\w)/gu, (_, c: string) => c.toUpperCase()),
    summary: endpoint.summary,
    description: endpoint.description,
    tags: [API_GROUPS.find((g) => g.id === endpoint.group)!.title],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: {
      '200': { description: endpoint.returns, content: ok },
      ...(endpoint.errors.length > 0 ? { default: { description: endpoint.errors.join(' · '), content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } : {}),
    },
    'x-partner-cors': endpoint.partner,
    ...(endpoint.limit ? { 'x-rate-limit-per-minute': limits[endpoint.limit] } : {}),
    ...(endpoint.eligibility ? { 'x-eligibility': 'Answers 451 from a restricted country until the visitor confirms they are not a US person.' } : {}),
  };
}

export function buildOpenApi(appUrl: string, limits: Readonly<Record<string, number>>): Schema {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const endpoint of API_ENDPOINTS) {
    paths[endpoint.path] ??= {};
    paths[endpoint.path]![endpoint.method.toLowerCase()] = operation(endpoint, limits);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'BStocks Launchpad API',
      version: API_CONTRACT_VERSION,
      description:
        'Read the launchpad (tokens paired with Coinbase tokenized stocks on Base) and build the exact transactions to trade or launch. No key and no login. Nothing is signed on the server: /api/tx returns calls for the visitor\'s own wallet. Amounts are integer strings in the smallest unit (a stock has 8 decimals, a launched token 18).',
    },
    servers: [{ url: appUrl }],
    externalDocs: { description: 'API reference with examples and Try it', url: `${appUrl}/docs/api` },
    tags: API_GROUPS.map((g) => ({ name: g.title, description: g.intro })),
    paths,
    components: {
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' } },
            },
          },
        },
      },
    },
  };
}
