import { timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

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

export function parseCidr(entry) {
  const match = /^([^/]+)\/(\d{1,3})$/.exec(entry);
  const family = match ? isIP(match[1]) : 0;
  const prefix = match ? Number(match[2]) : NaN;
  if (!family || prefix > (family === 4 ? 32 : 128)) return null;
  return { address: match[1], prefix, type: family === 4 ? 'ipv4' : 'ipv6' };
}

export function parseAllowedHosts(value) {
  const names = [];
  const ranges = new BlockList();
  let rangeCount = 0;
  for (const entry of (value ?? '').split(',').map((host) => host.trim().toLowerCase())) {
    if (!entry) continue;
    if (!entry.includes('/')) {
      names.push(entry);
      continue;
    }
    const cidr = parseCidr(entry);
    if (!cidr) throw new Error(`PUBLIC_HOSTS_ALLOWED tiene un rango inválido: ${entry}`);
    ranges.addSubnet(cidr.address, cidr.prefix, cidr.type);
    rangeCount++;
  }
  return { names, ranges, empty: names.length === 0 && rangeCount === 0 };
}

const NO_RESTRICTION = parseAllowedHosts('');

function isAllowed(hostname, allowed) {
  if (allowed.empty) return true;
  if (allowed.names.includes(hostname)) return true;
  const ip = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  return family !== 0 && allowed.ranges.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function sameSecret(sent, expected) {
  if (typeof sent !== 'string' || !expected) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function publicBaseUrl(headers, { fallback, gatewaySecret, allowedHosts = NO_RESTRICTION }) {
  if (!sameSecret(headers[GATEWAY_SECRET_HEADER], gatewaySecret)) return fallback;
  const proto = headers['x-forwarded-proto'];
  if (proto !== 'http' && proto !== 'https') return fallback;
  const parsed = parseHost(headers['x-forwarded-host']);
  if (!parsed) return fallback;
  if (!isAllowed(parsed.hostname, allowedHosts)) return fallback;
  return `${proto}://${parsed.host}${API_PREFIX}`;
}
