export const GATEWAY_SECRET_HEADER = 'x-tickethub-gateway';

const CLIENT_HEADERS = /^(forwarded|x-forwarded-.+|x-real-ip|x-tickethub-gateway)$/i;

const firstValue = (header) =>
  typeof header === 'string' ? header.split(',')[0].trim().toLowerCase() : '';

function fromProxy(req) {
  const proto = firstValue(req.headers['x-forwarded-proto']);
  const host =
    typeof req.headers['x-forwarded-host'] === 'string'
      ? req.headers['x-forwarded-host'].split(',')[0].trim()
      : '';
  return {
    proto: proto === 'http' || proto === 'https' ? proto : null,
    host: host || null,
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
