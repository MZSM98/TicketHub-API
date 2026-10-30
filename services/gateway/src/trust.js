import { BlockList, isIP } from 'node:net';

function familyOf(address) {
  const family = isIP(address);
  return family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null;
}

export function parseTrustedProxies(value) {
  const list = new BlockList();
  let count = 0;
  for (const entry of (value ?? '').split(',').map((item) => item.trim())) {
    if (!entry) continue;
    const [address, prefix, extra] = entry.split('/');
    const type = familyOf(address);
    const max = type === 'ipv4' ? 32 : 128;
    const bits = prefix === undefined ? max : /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
    if (!type || extra !== undefined || !(bits >= 0 && bits <= max)) {
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
