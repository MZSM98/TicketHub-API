// Valida respuestas contra los schemas de los contratos. Usa mock/tickethub.openapi.json, que es
// la versión ya resuelta (sin $ref) de contracts/*.yaml. Además de tipos, required, enum, nullable
// y formatos, marca como error cualquier propiedad que el schema no define.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const spec = JSON.parse(
  readFileSync(new URL('../mock/tickethub.openapi.json', import.meta.url), 'utf8'),
);

const FORMATS = {
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

function mergeAllOf(schema) {
  if (!schema.allOf) return schema;
  const merged = { ...schema, type: 'object', properties: { ...schema.properties }, required: [] };
  delete merged.allOf;
  for (const part of schema.allOf.map(mergeAllOf)) {
    Object.assign(merged.properties, part.properties);
    merged.required.push(...(part.required ?? []));
  }
  merged.required.push(...(schema.required ?? []));
  return merged;
}

function check(rawSchema, value, at, errors) {
  const schema = mergeAllOf(rawSchema);
  if (value === null) {
    if (!schema.nullable) errors.push(`${at}: null no permitido`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} no está en ${JSON.stringify(schema.enum)}`);
  }
  const type = schema.type ?? (schema.properties ? 'object' : undefined);
  switch (type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${at}: se esperaba objeto`);
        return;
      }
      for (const key of schema.required ?? []) {
        if (!(key in value)) errors.push(`${at}.${key}: falta (required)`);
      }
      for (const [key, child] of Object.entries(value)) {
        const childSchema = schema.properties?.[key];
        if (childSchema) check(childSchema, child, `${at}.${key}`, errors);
        else if (schema.properties && !schema.additionalProperties) {
          errors.push(`${at}.${key}: propiedad no definida en el contrato`);
        }
      }
      return;
    }
    case 'array':
      if (!Array.isArray(value)) errors.push(`${at}: se esperaba arreglo`);
      else value.forEach((item, i) => check(schema.items ?? {}, item, `${at}[${i}]`, errors));
      return;
    case 'string':
      if (typeof value !== 'string') return void errors.push(`${at}: se esperaba string`);
      if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format].test(value)) {
        errors.push(`${at}: no cumple el formato ${schema.format}`);
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errors.push(`${at}: no cumple el patrón ${schema.pattern}`);
      }
      if (schema.minLength && value.length < schema.minLength) errors.push(`${at}: muy corto`);
      if (schema.maxLength && value.length > schema.maxLength) errors.push(`${at}: muy largo`);
      return;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || (type === 'integer' && !Number.isInteger(value))) {
        errors.push(`${at}: se esperaba ${type}`);
      } else {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: < minimum`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: > maximum`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${at}: se esperaba boolean`);
      return;
    default:
  }
}

/** Schema JSON de la respuesta `status` de `METHOD /api/v1/...` en el contrato. */
export function responseSchema(method, path, status) {
  const response = spec.paths[path]?.[method.toLowerCase()]?.responses?.[String(status)];
  assert.ok(response, `El contrato no define ${status} para ${method} ${path}`);
  return response.content?.['application/json']?.schema ?? null;
}

/** Afirma que status y cuerpo coinciden con el contrato (204 sin cuerpo). */
export function assertContract(res, body, method, path, expectedStatus) {
  assert.equal(res.status, expectedStatus, `${method} ${path}: ${JSON.stringify(body)}`);
  const schema = responseSchema(method, path, expectedStatus);
  if (!schema) {
    assert.equal(body, null, `${method} ${path} ${expectedStatus} no debe traer cuerpo`);
    return;
  }
  assertSchema(schema, body, `${method} ${path} ${expectedStatus}`);
}

export function assertSchema(schema, value, label) {
  const errors = [];
  check(schema, value, 'body', errors);
  assert.deepEqual(errors, [], `${label} no coincide con el contrato`);
}

/** Operaciones del spec con su seguridad: 'public' | 'optional' | 'required'. */
export function contractSecurity() {
  const result = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!op.responses) continue;
      const security = op.security ?? [];
      let mode = 'required';
      if (security.length === 0) mode = 'public';
      else if (security.some((s) => Object.keys(s).length === 0)) mode = 'optional';
      result.push({ method: method.toUpperCase(), path, mode });
    }
  }
  return result;
}
