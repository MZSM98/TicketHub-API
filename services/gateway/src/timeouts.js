const DEFAULT_REQUEST_TIMEOUT_SECONDS = 60;
const DEFAULT_HEADERS_TIMEOUT_SECONDS = 15;

function seconds(env, name, fallback) {
  const raw = env[name] || String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${name} debe ser un entero de segundos mayor o igual a 1`);
  }
  return Number(raw);
}

export function serverTimeouts(env) {
  const request = seconds(env, 'GATEWAY_REQUEST_TIMEOUT_SECONDS', DEFAULT_REQUEST_TIMEOUT_SECONDS);
  const headers = seconds(env, 'GATEWAY_HEADERS_TIMEOUT_SECONDS', DEFAULT_HEADERS_TIMEOUT_SECONDS);
  if (headers > request) {
    throw new Error(
      'GATEWAY_HEADERS_TIMEOUT_SECONDS no puede ser mayor que GATEWAY_REQUEST_TIMEOUT_SECONDS',
    );
  }
  return {
    requestTimeoutMs: request * 1000,
    headersTimeoutMs: headers * 1000,
    checkIntervalMs: Math.min(1000, headers * 1000),
  };
}
