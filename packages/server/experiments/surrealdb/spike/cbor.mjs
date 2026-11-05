// A minimal CBOR (RFC 8949) encoder and decoder for the spike's /rpc checks.
// Tagged values are written and read as { $tag, value }. Not a reusable client.

function head(major, n) {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function enc(value) {
  if (value === null) return Buffer.from([0xf6]);
  if (value === undefined) return Buffer.from([0xf7]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === false) return Buffer.from([0xf4]);
  if (typeof value === 'number' && Number.isInteger(value)) {
    return Buffer.from(value >= 0 ? head(0, value) : head(1, -1 - value));
  }
  if (typeof value === 'number') {
    const buffer = Buffer.alloc(9);
    buffer[0] = 0xfb;
    buffer.writeDoubleBE(value, 1);
    return buffer;
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from(head(3, bytes.length)), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from(head(4, value.length)), ...value.map(enc)]);
  }
  if (value.$tag !== undefined) {
    return Buffer.concat([Buffer.from(head(6, value.$tag)), enc(value.value)]);
  }
  const entries = Object.entries(value);
  return Buffer.concat([
    Buffer.from(head(5, entries.length)),
    ...entries.flatMap(([key, item]) => [enc(key), enc(item)]),
  ]);
}

export function dec(buffer) {
  let offset = 0;
  const take = (bytes) => {
    const start = offset;
    offset += bytes;
    return start;
  };
  const length = (info) => {
    if (info < 24) return info;
    if (info === 24) return buffer[take(1)];
    if (info === 25) return buffer.readUInt16BE(take(2));
    if (info === 26) return buffer.readUInt32BE(take(4));
    return Number(buffer.readBigUInt64BE(take(8)));
  };
  const simple = (info) => {
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22) return null;
    if (info === 23) return undefined;
    if (info === 26) return buffer.readFloatBE(take(4));
    if (info === 27) return buffer.readDoubleBE(take(8));
    throw new Error(`Unsupported CBOR simple value ${info}`);
  };
  const item = () => {
    const initial = buffer[take(1)];
    const major = initial >> 5;
    const info = initial & 0x1f;
    if (major === 7) return simple(info);
    const n = length(info);
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1 - n;
      case 2:
        return { $bytes: buffer.subarray(take(n), offset).toString('hex') };
      case 3:
        return buffer.toString('utf8', take(n), offset);
      case 4:
        return Array.from({ length: n }, item);
      case 5: {
        const object = {};
        for (let i = 0; i < n; i++) {
          const key = item();
          object[typeof key === 'string' ? key : JSON.stringify(key)] = item();
        }
        return object;
      }
      default:
        return { $tag: n, value: item() };
    }
  };
  return item();
}
