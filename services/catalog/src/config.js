function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3002),
  internalToken: required('INTERNAL_TOKEN'),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080/api/v1').replace(/\/$/, ''),
  internalTimeoutMs: Number(process.env.INTERNAL_TIMEOUT_MS ?? 3000),
  minio: {
    endpoint: required('MINIO_ENDPOINT'),
    accessKey: required('MINIO_ROOT_USER'),
    secretKey: required('MINIO_ROOT_PASSWORD'),
    bucket: required('MINIO_BUCKET_POSTERS'),
  },
  services: {
    identity: process.env.IDENTITY_SERVICE_URL ?? 'http://identity-service:3001',
    inventory: process.env.INVENTORY_SERVICE_URL ?? 'http://inventory-service:3003',
    purchase: process.env.PURCHASE_SERVICE_URL ?? 'http://purchase-service:3004',
  },
};
