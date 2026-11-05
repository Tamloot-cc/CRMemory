/**
 * CBOR (RFC 8949) for SurrealDB's `/rpc` endpoint (spec section 9). Every
 * caller value crosses as a CBOR parameter, so strings stay strings: JSON-RPC
 * would turn `INV:2026` into a record ID and `2026-11-05` into a datetime.
 *
 * SurrealDB's tags used here: 0 and 12 datetimes, 6 NONE, 7 table, 8 record
 * ID, 9 and 37 UUIDs, 10 decimal, 13 and 14 durations.
 */

/** A native record ID: `table:id`. Converted to a public ID at the boundary. */
export class RecordId {
  constructor(
    readonly table: string,
    readonly id: string | number | unknown[],
  ) {}

  toString(): string {
    return `${this.table}:${typeof this.id === 'string' ? `⟨${this.id}⟩` : JSON.stringify(this.id)}`;
  }

  equals(other: unknown): boolean {
    return (
      other instanceof RecordId &&
      other.table === this.table &&
      JSON.stringify(other.id) === JSON.stringify(this.id)
    );
  }
}

/** A table name passed as a value (e.g. to `type::table`). */
export class Table {
  constructor(readonly name: string) {}
}

/** An exact decimal, kept as text. */
export class Decimal {
  constructor(readonly value: string) {}
}

/** A tagged value this module does not interpret. */
export class Tagged {
  constructor(
    readonly tag: number,
    readonly value: unknown,
  ) {}
}

const TAG_DATETIME_STRING = 0;
const TAG_NONE = 6;
const TAG_TABLE = 7;
const TAG_RECORD_ID = 8;
const TAG_UUID_STRING = 9;
const TAG_DECIMAL = 10;
const TAG_DATETIME = 12;
const TAG_DURATION_STRING = 13;
const TAG_DURATION = 14;
const TAG_UUID = 37;

class Writer {
  private chunks: Buffer[] = [];
  private size = 0;

  push(buffer: Buffer): void {
    this.chunks.push(buffer);
    this.size += buffer.length;
  }

  head(major: number, n: number | bigint): void {
    const value = typeof n === 'bigint' ? n : BigInt(n);
    if (value < 24n) this.push(Buffer.from([(major << 5) | Number(value)]));
    else if (value < 0x100n) this.push(Buffer.from([(major << 5) | 24, Number(value)]));
    else if (value < 0x10000n) {
      const b = Buffer.alloc(3);
      b[0] = (major << 5) | 25;
      b.writeUInt16BE(Number(value), 1);
      this.push(b);
    } else if (value < 0x100000000n) {
      const b = Buffer.alloc(5);
      b[0] = (major << 5) | 26;
      b.writeUInt32BE(Number(value), 1);
      this.push(b);
    } else {
      const b = Buffer.alloc(9);
      b[0] = (major << 5) | 27;
      b.writeBigUInt64BE(value, 1);
      this.push(b);
    }
  }

  result(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

function writeValue(w: Writer, value: unknown): void {
  if (value === undefined) {
    w.head(6, TAG_NONE);
    w.push(Buffer.from([0xf6]));
    return;
  }
  if (value === null) return w.push(Buffer.from([0xf6]));
  if (value === true) return w.push(Buffer.from([0xf5]));
  if (value === false) return w.push(Buffer.from([0xf4]));
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
      if (value >= 0) w.head(0, value);
      else w.head(1, -1 - value);
      return;
    }
    const b = Buffer.alloc(9);
    b[0] = 0xfb;
    b.writeDoubleBE(value, 1);
    return w.push(b);
  }
  if (typeof value === 'bigint') {
    if (value >= 0n) w.head(0, value);
    else w.head(1, -1n - value);
    return;
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    w.head(3, bytes.length);
    return w.push(bytes);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('cannot encode an invalid date');
    const ms = value.getTime();
    const seconds = Math.floor(ms / 1000);
    const nanos = (ms - seconds * 1000) * 1_000_000;
    w.head(6, TAG_DATETIME);
    w.head(4, 2);
    writeValue(w, seconds);
    writeValue(w, nanos);
    return;
  }
  if (value instanceof RecordId) {
    w.head(6, TAG_RECORD_ID);
    w.head(4, 2);
    writeValue(w, value.table);
    writeValue(w, value.id);
    return;
  }
  if (value instanceof Table) {
    w.head(6, TAG_TABLE);
    return writeValue(w, value.name);
  }
  if (value instanceof Decimal) {
    w.head(6, TAG_DECIMAL);
    return writeValue(w, value.value);
  }
  if (value instanceof Tagged) {
    w.head(6, value.tag);
    return writeValue(w, value.value);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    w.head(2, value.length);
    return w.push(Buffer.from(value));
  }
  if (Array.isArray(value)) {
    w.head(4, value.length);
    for (const item of value) writeValue(w, item);
    return;
  }
  if (value instanceof Map) {
    w.head(5, value.size);
    for (const [k, v] of value) {
      writeValue(w, k);
      writeValue(w, v);
    }
    return;
  }
  if (typeof value === 'object') {
    // Like JSON: an undefined property is omitted, not sent as NONE.
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    w.head(5, entries.length);
    for (const [k, v] of entries) {
      writeValue(w, k);
      writeValue(w, v);
    }
    return;
  }
  throw new Error(`cannot encode a ${typeof value} as CBOR`);
}

export function encode(value: unknown): Buffer {
  const w = new Writer();
  writeValue(w, value);
  return w.result();
}

function uuidFromBytes(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function halfToNumber(half: number): number {
  const exp = (half >> 10) & 0x1f;
  const mant = half & 0x3ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 31) return mant ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

export function decode(buffer: Buffer): unknown {
  let offset = 0;
  const take = (bytes: number) => {
    const start = offset;
    offset += bytes;
    if (offset > buffer.length) throw new Error('truncated CBOR');
    return start;
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return buffer[take(1)] as number;
    if (info === 25) return buffer.readUInt16BE(take(2));
    if (info === 26) return buffer.readUInt32BE(take(4));
    if (info === 27) {
      const big = buffer.readBigUInt64BE(take(8));
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR integer exceeds 2^53');
      return Number(big);
    }
    throw new Error(`unsupported CBOR length ${info}`);
  };
  const tagged = (tag: number, value: unknown): unknown => {
    switch (tag) {
      case TAG_NONE:
        return undefined;
      case TAG_DATETIME_STRING:
        return new Date(value as string);
      case TAG_DATETIME: {
        const [seconds = 0, nanos = 0] = value as [number, number?];
        return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000));
      }
      case TAG_RECORD_ID: {
        const [table, id] = value as [string, unknown];
        return new RecordId(table, id as string);
      }
      case TAG_TABLE:
        return new Table(value as string);
      case TAG_UUID_STRING:
        return value as string;
      case TAG_UUID:
        return uuidFromBytes(Buffer.from(value as Uint8Array));
      case TAG_DECIMAL:
        return new Decimal(value as string);
      case TAG_DURATION_STRING:
        return value as string;
      case TAG_DURATION:
        return value;
      default:
        return new Tagged(tag, value);
    }
  };
  const item = (): unknown => {
    const initial = buffer[take(1)] as number;
    const major = initial >> 5;
    const info = initial & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info === 25) return halfToNumber(buffer.readUInt16BE(take(2)));
      if (info === 26) return buffer.readFloatBE(take(4));
      if (info === 27) return buffer.readDoubleBE(take(8));
      throw new Error(`unsupported CBOR simple value ${info}`);
    }
    const n = length(info);
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1 - n;
      case 2:
        return Buffer.from(buffer.subarray(take(n), offset));
      case 3:
        return buffer.toString('utf8', take(n), offset);
      case 4:
        return Array.from({ length: n }, item);
      case 5: {
        const object: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const key = item();
          const value = item();
          // NONE inside an object means the key is absent.
          if (value !== undefined) object[String(key)] = value;
        }
        return object;
      }
      default:
        return tagged(n, item());
    }
  };
  const value = item();
  if (offset !== buffer.length) throw new Error('trailing bytes after CBOR value');
  return value;
}
