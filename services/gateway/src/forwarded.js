export const GATEWAY_SECRET_HEADER = 'x-tickethub-gateway';

const CLIENT_HEADERS = /^(forwarded|x-forwarded-.+|x-real-ip|x-tickethub-gateway)$/i;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_PATTERN = new RegExp(
  `^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]{2,45}\\])(?::(\\d{1,5}))?$`,
  'i',
);

export function validHost(value) {
  if (typeof value !== 'string' || value.length > 260) return false;
  const match = HOST_PATTERN.exec(value);
  if (!match) return false;
  return match[1] === undefined || (Number(match[1]) >= 1 && Number(match[1]) <= 65535);
}

const lastValue = (header) =>
  typeof header === 'string' ? (header.split(',').pop() ?? '').trim() : '';

function fromProxy(req) {
  const proto = lastValue(req.headers['x-forwarded-proto']).toLowerCase();
  const host = lastValue(req.headers['x-forwarded-host']);
  return {
    proto: proto === 'http' || proto === 'https' ? proto : null,
    host: validHost(host) ? host : null,
  };
}

export function rewriteForwarded(req, { secret, sendSecret, isTrustedProxy }) {
  const proxy = isTrustedProxy(req.socket.remoteAddress) ? fromProxy(req) : {};
  for (const name of Object.keys(req.headers)) {
    if (CLIENT_HEADERS.test(name)) delete req.headers[name];
  }
  req.headers['x-forwarded-host'] = proxy.host ?? req.headers.host ?? '';
  req.headers['x-forwarded-proto'] = proxy.proto ?? (req.socket.encrypted ? 'https' : 'http');
  if (sendSecret) req.headers[GATEWAY_SECRET_HEADER] = secret;
}
