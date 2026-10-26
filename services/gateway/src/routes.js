// Tabla de ruteo de contracts/gateway.yaml. El orden importa: la primera regla que coincide gana,
// por eso las subrutas de /events que pertenecen a Inventory y Purchase van antes que Catalog.
const ID = '[^/]+';

export const routes = [
  { service: 'inventory', pattern: new RegExp(`^/events/${ID}/(availability|zones)(/|$)`) },
  { service: 'purchase', pattern: new RegExp(`^/events/${ID}/sales(/|$)`) },
  { service: 'identity', pattern: /^\/(auth|users|admin\/users)(\/|$)/ },
  { service: 'identity', pattern: /^\/(admin\/organizers|organizer\/staff)\/?$/ },
  { service: 'catalog', pattern: /^\/(events|organizer\/events|venues|staff\/events)(\/|$)/ },
  { service: 'catalog', pattern: /^\/admin\/summary\/?$/ },
  { service: 'inventory', pattern: /^\/(zones|reservations)(\/|$)/ },
  { service: 'purchase', pattern: /^\/purchases(\/|$)/ },
  { service: 'ticket', pattern: /^\/tickets(\/|$)/ },
];

/** Servicio dueño de una ruta relativa a /api/v1, o null si ninguno (incluye /internal/**). */
export function resolveService(path) {
  if (/^\/internal(\/|$)/.test(path)) return null;
  return routes.find((route) => route.pattern.test(path))?.service ?? null;
}

// Seguridad por operación según los contratos (security: [] o [{}, bearerAuth]).
// Todo lo que no aparece aquí requiere un access token válido.
const PUBLIC = [
  ['GET', /^\/health\/?$/],
  ['POST', /^\/auth\/(register|login|refresh|logout)\/?$/],
  ['GET', /^\/events\/?$/],
  ['GET', new RegExp(`^/events/${ID}/availability/?$`)],
  ['GET', new RegExp(`^/zones/${ID}/seats/?$`)],
];
// Token opcional: sin token se responde como público; si viene, debe ser válido.
const OPTIONAL = [
  ['GET', new RegExp(`^/events/${ID}/?$`)],
  ['GET', new RegExp(`^/events/${ID}/poster/?$`)],
];

/** 'public' | 'optional' | 'required' para un método y una ruta relativa a /api/v1. */
export function authMode(method, path) {
  const matches = ([m, pattern]) => m === method && pattern.test(path);
  if (PUBLIC.some(matches)) return 'public';
  if (OPTIONAL.some(matches)) return 'optional';
  return 'required';
}
