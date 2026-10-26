import { timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const unauthorized = () =>
  new HttpError(401, 'UNAUTHORIZED', 'Sesión no válida o expirada, inicie sesión de nuevo');
export const forbidden = () =>
  new HttpError(403, 'FORBIDDEN', 'No tiene permisos para realizar esta acción');
export const notFound = () => new HttpError(404, 'NOT_FOUND', 'Recurso no encontrado');
export const serviceUnavailable = () =>
  new HttpError(503, 'SERVICE_UNAVAILABLE', 'Servicio temporalmente inactivo');

function validationError(fields, customMessage) {
  const onlyMissing = fields.every((f) => f.issue === 'required');
  const message = onlyMissing
    ? 'Por favor llene todos los campos requeridos'
    : (customMessage ?? 'Algunos datos no son válidos, revise los campos marcados');
  return new HttpError(400, 'VALIDATION_ERROR', message, { fields });
}

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

export function parseDateTime(value) {
  if (typeof value !== 'string' || !DATE_TIME_RE.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function validate(source, rules) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw validationError([{ field: 'body', issue: 'required' }]);
  }
  const values = {};
  const fields = [];
  for (const [field, rule] of Object.entries(rules)) {
    const raw = source[field];
    if (raw === undefined || raw === null || raw === '') {
      if (rule.required) fields.push({ field, issue: 'required' });
      continue;
    }
    const result = checkValue(raw, rule);
    if (result.issue) fields.push({ field, issue: result.issue });
    else values[field] = result.value;
  }
  if (fields.length > 0) {
    const custom =
      fields.length === 1 ? rules[fields[0].field]?.messages?.[fields[0].issue] : undefined;
    throw validationError(fields, custom);
  }
  return values;
}

function checkValue(raw, rule) {
  switch (rule.type) {
    case 'string': {
      if (typeof raw !== 'string') return { issue: 'invalid_type' };
      const value = rule.trim ? raw.trim() : raw;
      if (rule.minLength && value.length < rule.minLength) return { issue: 'too_short' };
      if (rule.maxLength && value.length > rule.maxLength) return { issue: 'too_long' };
      if (rule.enum && !rule.enum.includes(value)) return { issue: 'invalid_value' };
      return { value };
    }
    case 'id':
      if (typeof raw !== 'number') return { issue: 'invalid_type' };
      if (!Number.isSafeInteger(raw) || raw < 1) return { issue: 'invalid_value' };
      return { value: raw };
    case 'date-time': {
      if (typeof raw !== 'string') return { issue: 'invalid_type' };
      const date = parseDateTime(raw);
      if (!date) return { issue: 'invalid_format' };
      if (rule.future && date.getTime() <= Date.now()) return { issue: 'not_in_future' };
      return { value: date };
    }
    default:
      return { value: raw };
  }
}

export function parseQuery(query, rules) {
  const values = {};
  const fields = [];
  for (const [field, rule] of Object.entries(rules)) {
    const raw = query[field];
    if (raw === undefined || raw === '') {
      if (rule.default !== undefined) values[field] = rule.default;
      continue;
    }
    if (typeof raw !== 'string') {
      fields.push({ field, issue: 'invalid_type' });
    } else if (rule.type === 'integer') {
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n < rule.minimum || n > rule.maximum) {
        fields.push({ field, issue: 'invalid_value' });
      } else values[field] = n;
    } else if (rule.type === 'date-time') {
      const date = parseDateTime(raw);
      if (!date) fields.push({ field, issue: 'invalid_format' });
      else values[field] = date;
    } else if (rule.enum && !rule.enum.includes(raw)) {
      fields.push({ field, issue: 'invalid_value' });
    } else values[field] = raw;
  }
  if (fields.length > 0) throw validationError(fields);
  return values;
}

const ID_RULE = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
export const QUERY_ID_RULE = ID_RULE;

export const PAGE_RULES = {
  page: { ...ID_RULE, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
};

export function parseIdList(raw, field, max) {
  if (raw === undefined || raw === '') throw validationError([{ field, issue: 'required' }]);
  if (typeof raw !== 'string') throw validationError([{ field, issue: 'invalid_type' }]);
  const parts = raw.split(',');
  if (parts.length > max) throw validationError([{ field, issue: 'too_many' }]);
  if (!parts.every((p) => /^\d{1,15}$/.test(p) && Number(p) >= 1)) {
    throw validationError([{ field, issue: 'invalid_value' }]);
  }
  return [...new Set(parts.map(Number))];
}

export function pageOf(items, total, { page, pageSize }) {
  return { items, page, pageSize, totalItems: total, totalPages: Math.ceil(total / pageSize) };
}

export function parseId(raw, error = notFound) {
  if (!/^\d{1,15}$/.test(raw) || Number(raw) < 1) throw error();
  return Number(raw);
}

function readToken(req) {
  const header = req.get('authorization');
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) throw unauthorized();
  try {
    const payload = jwt.verify(match[1], config.jwtSecret, { algorithms: ['HS256'] });
    return {
      userId: Number(payload.sub),
      role: payload.role,
      employerId: payload.employerId ?? null,
    };
  } catch {
    throw unauthorized();
  }
}

export function authenticate(req, _res, next) {
  req.auth = readToken(req);
  if (!req.auth) throw unauthorized();
  next();
}

export function optionalAuth(req, _res, next) {
  req.auth = readToken(req);
  next();
}

export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!roles.includes(req.auth?.role)) throw forbidden();
    next();
  };

export function requireInternal(req, _res, next) {
  const sent = Buffer.from(req.get('x-internal-token') ?? '');
  const expected = Buffer.from(config.internalToken);
  if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) throw unauthorized();
  next();
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    const body = { code: err.code, message: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'El cuerpo de la petición no es JSON válido',
      details: { fields: [{ field: 'body', issue: 'invalid_json' }] },
    });
  }
  console.error(err);
  return res
    .status(500)
    .json({ code: 'INTERNAL_ERROR', message: 'Error interno, intente más tarde' });
}
