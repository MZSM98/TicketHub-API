export const GATEWAY_SECRET_HEADER = 'x-tickethub-gateway';

const CLIENT_HEADERS = /^(forwarded|x-forwarded-.+|x-real-ip|x-tickethub-gateway)$/i;

export function rewriteForwarded(req, secret) {
  for (const name of Object.keys(req.headers)) {
    if (CLIENT_HEADERS.test(name)) delete req.headers[name];
  }
  req.headers['x-forwarded-host'] = req.headers.host ?? '';
  req.headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
  req.headers[GATEWAY_SECRET_HEADER] = secret;
}
