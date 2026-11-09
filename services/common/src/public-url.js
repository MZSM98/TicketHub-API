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

const MAPPED_IPV4 = new BlockList();
MAPPED_IPV4.addSubnet('::ffff:0:0', 96, 'ipv6');

export const isMappedIpv4 = (address) => isIP(address) === 6 && MAPPED_IPV4.check(address, 'ipv6');

function overlapsMappedIpv4(address, prefix) {
  if (isMappedIpv4(address)) return true;
  const range = new BlockList();
  range.addSubnet(address, prefix, 'ipv6');
  return range.check('::ffff:0:0', 'ipv6');
}

export function parseCidr(entry) {
  const match = /^([^/]+)\/(0|[1-9]\d{0,2})$/.exec(entry);
  const family = match ? isIP(match[1]) : 0;
  const prefix = match ? Number(match[2]) : NaN;
  if (!family || prefix > (family === 4 ? 32 : 128)) return null;
  if (family === 6 && overlapsMappedIpv4(match[1], prefix)) return null;
  return { address: match[1], prefix, type: family === 4 ? 'ipv4' : 'ipv6' };
}

const BRACKETED_IPV6 = /^\[([0-9a-f:.]+)\]$/;

function validName(entry) {
  const bracketed = BRACKETED_IPV6.exec(entry);
  if (bracketed) return isIP(bracketed[1]) === 6 && !isMappedIpv4(bracketed[1]);
  return !entry.includes(':');
}

export function parseAllowedHosts(value) {
  const names = [];
  const ranges = new BlockList();
  let rangeCount = 0;
  for (const entry of (value ?? '').split(',').map((host) => host.trim().toLowerCase())) {
    if (!entry) continue;
    if (!entry.includes('/')) {
      if (!validName(entry)) {
        throw new Error(`PUBLIC_HOSTS_ALLOWED tiene una entrada inválida: ${entry}`);
      }
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
  if (family === 0 || isMappedIpv4(ip)) return false;
  return allowed.ranges.check(ip, family === 4 ? 'ipv4' : 'ipv6');
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
