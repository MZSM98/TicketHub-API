// Errores con el formato de common.yaml (Error) y validación manual según los límites del contrato.
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

function validationError(fields) {
  const onlyMissing = fields.every((f) => f.issue === 'required');
  const message = onlyMissing
    ? 'Por favor llene todos los campos requeridos'
    : 'Algunos datos no son válidos, revise los campos marcados';
  return new HttpError(400, 'VALIDATION_ERROR', message, { fields });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Valida `source` contra `rules` ({ campo: { type, required, minLength, maxLength, format, enum } })
 * y regresa solo los campos conocidos. Lanza 400 VALIDATION_ERROR con todos los campos inválidos.
 */
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
    const issue = checkValue(raw, rule);
    if (issue) fields.push({ field, issue });
    else values[field] = rule.trim ? raw.trim() : raw;
  }
  if (fields.length > 0) throw validationError(fields);
  return values;
}

function checkValue(raw, rule) {
  if (rule.type === 'string') {
    if (typeof raw !== 'string') return 'invalid_type';
    const value = rule.trim ? raw.trim() : raw;
    if (rule.minLength && value.length < rule.minLength) return 'too_short';
    if (rule.maxLength && value.length > rule.maxLength) return 'too_long';
    if (rule.format === 'email' && !EMAIL_RE.test(value)) return 'invalid_format';
    if (rule.enum && !rule.enum.includes(value)) return 'invalid_value';
  }
  return null;
}

/** Valida y convierte query params de paginación y filtros (page, pageSize, enums, booleanos). */
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
    } else if (rule.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') fields.push({ field, issue: 'invalid_value' });
      else values[field] = raw === 'true';
    } else if (rule.enum && !rule.enum.includes(raw)) {
      fields.push({ field, issue: 'invalid_value' });
    } else values[field] = raw;
  }
  if (fields.length > 0) throw validationError(fields);
  return values;
}

export const PAGE_RULES = {
  page: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
};

/** Id de ruta (common.yaml Id: entero >= 1). Un id mal formado se trata como inexistente. */
export function parseId(raw) {
  if (!/^\d{1,18}$/.test(raw) || Number(raw) < 1) throw notFound();
  return Number(raw);
}

/** Verifica el access token (HS256, JWT_SECRET) y deja { userId, role, employerId } en req.auth. */
export function authenticate(req, _res, next) {
  const match = /^Bearer (.+)$/i.exec(req.get('authorization') ?? '');
  if (!match) throw unauthorized();
  try {
    const payload = jwt.verify(match[1], config.jwtSecret, { algorithms: ['HS256'] });
    req.auth = {
      userId: Number(payload.sub),
      role: payload.role,
      employerId: payload.employerId ?? null,
    };
  } catch {
    throw unauthorized();
  }
  next();
}

export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!roles.includes(req.auth?.role)) throw forbidden();
    next();
  };

/** /internal/**: header X-Internal-Token igual a INTERNAL_TOKEN. */
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
