import { timingSafeEqual } from 'node:crypto';

export const GATEWAY_SECRET_HEADER = 'x-tickethub-gateway';
const API_PREFIX = '/api/v1';
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = `${LABEL}(?:\\.${LABEL})*`;
const IPV6 = '\\[[0-9a-f:.]{2,45}\\]';
const HOST_PATTERN = new RegExp(`^(${HOSTNAME}|${IPV6})(?::(\\d{1,5}))?$`, 'i');

export function parseHost(value) {
  if (typeof value !== 'string' || value.length > 260) return null;
  const match = HOST_PATTERN.exec(value);
  if (!match) return null;
  if (match[2] !== undefined) {
    const port = Number(match[2]);
    if (port < 1 || port > 65535) return null;
  }
  return { host: value.toLowerCase(), hostname: match[1].toLowerCase() };
}

export function parseAllowedHosts(value) {
  return (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function sameSecret(sent, expected) {
  if (typeof sent !== 'string' || !expected) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function publicBaseUrl(headers, { fallback, gatewaySecret, allowedHosts = [] }) {
  if (!sameSecret(headers[GATEWAY_SECRET_HEADER], gatewaySecret)) return fallback;
  const proto = headers['x-forwarded-proto'];
  if (proto !== 'http' && proto !== 'https') return fallback;
  const parsed = parseHost(headers['x-forwarded-host']);
  if (!parsed) return fallback;
  if (allowedHosts.length > 0 && !allowedHosts.includes(parsed.hostname)) return fallback;
  return `${proto}://${parsed.host}${API_PREFIX}`;
}
