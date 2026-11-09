import { BlockList, isIP } from 'node:net';

function familyOf(address) {
  const family = isIP(address);
  return family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null;
}

const MAPPED_IPV4 = new BlockList();
MAPPED_IPV4.addSubnet('::ffff:0:0', 96, 'ipv6');

function overlapsMappedIpv4(address, prefix) {
  if (MAPPED_IPV4.check(address, 'ipv6')) return true;
  const range = new BlockList();
  range.addSubnet(address, prefix, 'ipv6');
  return range.check('::ffff:0:0', 'ipv6');
}

export function parseTrustProxyHost(value) {
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`TRUST_PROXY_HOST debe ser true o false: ${value}`);
}

export function parseTrustedProxies(value) {
  const list = new BlockList();
  let count = 0;
  for (const entry of (value ?? '').split(',').map((item) => item.trim())) {
    if (!entry) continue;
    const [address, prefix, extra] = entry.split('/');
    const type = familyOf(address);
    const max = type === 'ipv4' ? 32 : 128;
    const bits =
      prefix === undefined ? max : /^(0|[1-9]\d{0,2})$/.test(prefix) ? Number(prefix) : NaN;
    if (
      !type ||
      extra !== undefined ||
      !(bits >= 0 && bits <= max) ||
      (type === 'ipv6' && overlapsMappedIpv4(address, bits))
    ) {
      throw new Error(`TRUST_PROXY tiene una entrada inválida: ${entry}`);
    }
    list.addSubnet(address, bits, type);
    count++;
  }
  return (peer) => {
    if (count === 0 || typeof peer !== 'string') return false;
    const address = peer.startsWith('::ffff:') && isIP(peer.slice(7)) === 4 ? peer.slice(7) : peer;
    const type = familyOf(address);
    return type !== null && list.check(address, type);
  };
}
