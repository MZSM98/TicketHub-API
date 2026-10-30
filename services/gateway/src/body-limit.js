export const BODY_LIMIT_BYTES = 100 * 1024;

const hasBody = (req) =>
  req.headers['transfer-encoding'] !== undefined ||
  (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');

const isMultipart = (req) => /^multipart\/form-data/i.test(req.headers['content-type'] ?? '');

function tooLarge(req, res) {
  if (!res.headersSent) {
    res.writeHead(413, {
      'Content-Type': 'application/json; charset=utf-8',
      Connection: 'close',
    });
    res.end(
      JSON.stringify({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'El cuerpo de la petición es demasiado grande',
        details: { limit: BODY_LIMIT_BYTES },
      }),
    );
  }
  res.once('finish', () => req.destroy());
}

export function limitBody(req, res, next) {
  if (!hasBody(req) || isMultipart(req)) return next();
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) return tooLarge(req, res);
  const chunks = [];
  let received = 0;
  const onData = (chunk) => {
    received += chunk.length;
    if (received > BODY_LIMIT_BYTES) {
      req.off('data', onData);
      req.off('end', onEnd);
      chunks.length = 0;
      return tooLarge(req, res);
    }
    chunks.push(chunk);
  };
  const onEnd = () => {
    req.rawBody = Buffer.concat(chunks, received);
    next();
  };
  req.on('data', onData);
  req.on('end', onEnd);
}

export function forwardBody(proxyReq, req) {
  if (!req.rawBody) return;
  proxyReq.removeHeader('transfer-encoding');
  proxyReq.setHeader('content-length', req.rawBody.length);
  proxyReq.write(req.rawBody);
}
