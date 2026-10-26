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
