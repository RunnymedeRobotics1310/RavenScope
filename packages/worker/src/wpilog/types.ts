/**
 * NT4 → WPILog type mapping and value encoding. Ports RavenLink's
 * internal/wpilog/types.go byte-for-byte.
 *
 * JSON numbers arrive as JS `number` (float64). int64 values above 2^53
 * lose precision — acceptable for v1 since robot NT int usage stays well
 * under uint32. If strict int64 round-tripping is ever needed, switch to
 * `JSON.parse` with a bigint reviver.
 */

/** Convert an NT4 type name to the corresponding WPILog type string. */
export function mapNt4Type(nt4Type: string): string {
  switch (nt4Type) {
    case "int":
      return "int64"
    case "int[]":
      return "int64[]"
    case "float":
      return "double" // promote float32 → float64
    case "float[]":
      return "double[]"
    default:
      // boolean, double, string, raw, json, msgpack, protobuf,
      // boolean[], double[], string[] — names are identical.
      return nt4Type
  }
}

/** Encode a JSON-deserialized value into the WPILog binary payload for
 *  the given NT4 type. Throws on type mismatch or unsupported type. */
export function encodeValue(nt4Type: string, v: unknown): Uint8Array {
  switch (nt4Type) {
    case "boolean":
      return encodeBoolean(v)
    case "double":
      return encodeDouble(v)
    case "int":
      return encodeInt64(v)
    case "float":
      return encodeDouble(v)
    case "string":
    case "json":
      return encodeString(v)
    case "raw":
    case "msgpack":
    case "protobuf":
    case "structschema":
      return encodeRaw(v)
    case "boolean[]":
      return encodeBooleanArray(v)
    case "double[]":
      return encodeDoubleArray(v)
    case "int[]":
      return encodeInt64Array(v)
    case "float[]":
      return encodeDoubleArray(v)
    case "string[]":
      return encodeStringArray(v)
    default:
      if (nt4Type.startsWith("struct:") || nt4Type.startsWith("structarray:")) {
        return encodeRaw(v)
      }
      throw new TypeError(`unsupported NT4 type: ${nt4Type}`)
  }
}

function encodeBoolean(v: unknown): Uint8Array {
  if (typeof v !== "boolean") throw new TypeError(`boolean: expected bool, got ${typeof v}`)
  return new Uint8Array([v ? 0x01 : 0x00])
}

function encodeDouble(v: unknown): Uint8Array {
  const f = toFloat64(v)
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setFloat64(0, f, true)
  return buf
}

function encodeInt64(v: unknown): Uint8Array {
  const f = toFloat64(v)
  const buf = new Uint8Array(8)
  // Go: uint64(int64(f)) — truncate to int64 with wrap, reinterpret as uint64.
  const i64 = BigInt.asIntN(64, BigInt(Math.trunc(f)))
  new DataView(buf.buffer).setBigUint64(0, BigInt.asUintN(64, i64), true)
  return buf
}

const UTF8 = new TextEncoder()

function encodeString(v: unknown): Uint8Array {
  if (typeof v !== "string") throw new TypeError(`string: expected string, got ${typeof v}`)
  return UTF8.encode(v)
}

function encodeRaw(v: unknown): Uint8Array {
  if (typeof v !== "string") {
    throw new TypeError(`raw: expected base64 string, got ${typeof v}`)
  }
  // Go uses encoding/base64 StdEncoding with padding. atob() accepts that.
  const bin = atob(v)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function encodeBooleanArray(v: unknown): Uint8Array {
  const arr = toArray(v)
  const buf = new Uint8Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i]
    if (typeof b !== "boolean") {
      throw new TypeError(`boolean[${i}]: expected bool, got ${typeof b}`)
    }
    buf[i] = b ? 0x01 : 0x00
  }
  return buf
}

function encodeDoubleArray(v: unknown): Uint8Array {
  const arr = toArray(v)
  const buf = new Uint8Array(8 * arr.length)
  const view = new DataView(buf.buffer)
  for (let i = 0; i < arr.length; i++) {
    view.setFloat64(i * 8, toFloat64(arr[i]), true)
  }
  return buf
}

function encodeInt64Array(v: unknown): Uint8Array {
  const arr = toArray(v)
  const buf = new Uint8Array(8 * arr.length)
  const view = new DataView(buf.buffer)
  for (let i = 0; i < arr.length; i++) {
    const i64 = BigInt.asIntN(64, BigInt(Math.trunc(toFloat64(arr[i]))))
    view.setBigUint64(i * 8, BigInt.asUintN(64, i64), true)
  }
  return buf
}

function encodeStringArray(v: unknown): Uint8Array {
  const arr = toArray(v)
  // WPILog string[]: u32 count, then (u32 len + UTF-8) per element.
  const encoded: Uint8Array[] = []
  let total = 4
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i]
    if (typeof s !== "string") {
      throw new TypeError(`string[${i}]: expected string, got ${typeof s}`)
    }
    const bytes = UTF8.encode(s)
    encoded.push(bytes)
    total += 4 + bytes.length
  }
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)
  view.setUint32(0, arr.length, true)
  let off = 4
  for (const bytes of encoded) {
    view.setUint32(off, bytes.length, true)
    off += 4
    buf.set(bytes, off)
    off += bytes.length
  }
  return buf
}

function toFloat64(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "bigint") return Number(v)
  throw new TypeError(`expected number, got ${typeof v}`)
}

function toArray(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new TypeError(`expected array, got ${typeof v}`)
  return v
}
