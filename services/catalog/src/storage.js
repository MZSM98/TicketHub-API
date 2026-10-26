import { Client } from 'minio';
import { config } from './config.js';

const endpoint = new URL(config.minio.endpoint);
const client = new Client({
  endPoint: endpoint.hostname,
  port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
  useSSL: endpoint.protocol === 'https:',
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});
const { bucket } = config.minio;

let bucketReady = null;

function ensureBucket() {
  bucketReady ??= (async () => {
    if (!(await client.bucketExists(bucket))) await client.makeBucket(bucket);
  })().catch((err) => {
    bucketReady = null;
    throw err;
  });
  return bucketReady;
}

export async function putObject(key, buffer, contentType) {
  await ensureBucket();
  await client.putObject(bucket, key, buffer, buffer.length, { 'Content-Type': contentType });
}

export async function getObject(key) {
  try {
    const stat = await client.statObject(bucket, key);
    const stream = await client.getObject(bucket, key);
    return { stream, size: stat.size, contentType: stat.metaData?.['content-type'] };
  } catch (err) {
    if (err?.code === 'NoSuchKey' || err?.code === 'NotFound' || err?.code === 'NoSuchBucket') {
      return null;
    }
    throw err;
  }
}

export async function removeObject(key) {
  try {
    await client.removeObject(bucket, key);
  } catch (err) {
    console.error(`No se pudo borrar ${key} de MinIO: ${err.message}`);
  }
}
