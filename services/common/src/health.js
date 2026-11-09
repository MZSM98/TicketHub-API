const CHECK_TIMEOUT_MS = 1000;

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function healthHandler(service, checks = []) {
  return async (_req, res) => {
    const results = await Promise.allSettled(
      checks.map((check) => withTimeout(Promise.resolve().then(check))),
    );
    const up = results.every((result) => result.status === 'fulfilled');
    res.status(up ? 200 : 503).json({ status: up ? 'UP' : 'DOWN', service });
  };
}
