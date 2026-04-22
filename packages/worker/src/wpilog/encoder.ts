/**
 * Low-level WPILog record writer. Ports RavenLink's internal/wpilog/encoder.go
 * byte-for-byte. All multi-byte integers are little-endian. Timestamps are
 * unsigned 64-bit microseconds. Records use a compact variable-length header
 * to minimise file size.
 *
 * Specification: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/datalog.adoc
 */

const HEADER_MAGIC = new Uint8Array([0x57, 0x50, 0x49, 0x4c, 0x4f, 0x47]) // "WPILOG"
const HEADER_VERSION = 0x0100 // v1.0: minor=0x00, major=0x01

const CONTROL_START = 0x00
const CONTROL_FINISH = 0x01
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _CONTROL_SET_METADATA = 0x02 // reserved — never written in v1

/** Minimal sink interface that both a memory buffer and an R2 multipart
 *  writer can satisfy. See Unit 8 for the streaming wrapper. */
export interface WpilogWriter {
  write(bytes: Uint8Array): Promise<void>
}

/** In-memory WpilogWriter. Concatenates chunks on `toUint8Array()`. */
export class BufferedWpilogWriter implements WpilogWriter {
  private chunks: Uint8Array[] = []
  private total = 0

  async write(b: Uint8Array): Promise<void> {
    if (b.length === 0) return
    this.chunks.push(b)
    this.total += b.length
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.total)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  }
}

const UTF8 = new TextEncoder()

export async function writeHeader(w: WpilogWriter, extraHeader: string): Promise<void> {
  const ehBytes = UTF8.encode(extraHeader)
  const buf = new Uint8Array(6 + 2 + 4 + ehBytes.length)
  buf.set(HEADER_MAGIC, 0)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  view.setUint16(6, HEADER_VERSION, true)
  view.setUint32(8, ehBytes.length, true)
  if (ehBytes.length > 0) buf.set(ehBytes, 12)
  await w.write(buf)
}

export async function writeStartRecord(
  w: WpilogWriter,
  entryID: number,
  name: string,
  typeName: string,
  metadata: string,
  timestamp: bigint,
): Promise<void> {
  const nameBytes = UTF8.encode(name)
  const typeBytes = UTF8.encode(typeName)
  const metaBytes = UTF8.encode(metadata)

  // Payload: type(1) + entryID(4) + nameLen(4) + name + typeLen(4) + type + metaLen(4) + meta
  const payloadLen = 1 + 4 + 4 + nameBytes.length + 4 + typeBytes.length + 4 + metaBytes.length
  const payload = new Uint8Array(payloadLen)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)

  let off = 0
  payload[off] = CONTROL_START
  off += 1
  view.setUint32(off, entryID, true)
  off += 4
  view.setUint32(off, nameBytes.length, true)
  off += 4
  payload.set(nameBytes, off)
  off += nameBytes.length
  view.setUint32(off, typeBytes.length, true)
  off += 4
  payload.set(typeBytes, off)
  off += typeBytes.length
  view.setUint32(off, metaBytes.length, true)
  off += 4
  payload.set(metaBytes, off)

  await writeRecord(w, 0, timestamp, payload)
}

export async function writeFinishRecord(
  w: WpilogWriter,
  entryID: number,
  timestamp: bigint,
): Promise<void> {
  const payload = new Uint8Array(5)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  payload[0] = CONTROL_FINISH
  view.setUint32(1, entryID, true)
  await writeRecord(w, 0, timestamp, payload)
}

export async function writeDataRecord(
  w: WpilogWriter,
  entryID: number,
  timestamp: bigint,
  payload: Uint8Array,
): Promise<void> {
  await writeRecord(w, entryID, timestamp, payload)
}

/**
 * Writes one record (control or data) with the compact variable-length header.
 *
 * Header bitfield (1 byte):
 *   bits 1-0: entry ID byte count - 1    (0..3 → 1..4 bytes)
 *   bits 3-2: payload size byte count - 1 (0..3 → 1..4 bytes)
 *   bits 6-4: timestamp byte count - 1    (0..7 → 1..8 bytes)
 *   bit 7:    spare (0)
 */
async function writeRecord(
  w: WpilogWriter,
  entryID: number,
  timestamp: bigint,
  payload: Uint8Array,
): Promise<void> {
  const entryBytes = minBytes(BigInt(entryID >>> 0), 4)
  const sizeBytes = minBytes(BigInt(payload.length), 4)
  const tsBytes = minBytes(timestamp, 8)

  const headerByte = (entryBytes - 1) | ((sizeBytes - 1) << 2) | ((tsBytes - 1) << 4)

  // Max header: 1 + 4 + 4 + 8 = 17 bytes.
  const head = new Uint8Array(1 + entryBytes + sizeBytes + tsBytes)
  head[0] = headerByte
  let off = 1
  off += putVarInt(head, off, BigInt(entryID >>> 0), entryBytes)
  off += putVarInt(head, off, BigInt(payload.length), sizeBytes)
  off += putVarInt(head, off, timestamp, tsBytes)

  await w.write(head)
  if (payload.length > 0) await w.write(payload)
}

/** Minimum byte count (1..max) needed to represent v little-endian. */
export function minBytes(v: bigint, max: number): number {
  if (v === 0n) return 1
  let n = 1
  while (n < max && v >= 1n << BigInt(8 * n)) n++
  return n
}

/** Write v as a little-endian integer using exactly numBytes. */
export function putVarInt(
  buf: Uint8Array,
  offset: number,
  v: bigint,
  numBytes: number,
): number {
  for (let i = 0; i < numBytes; i++) {
    buf[offset + i] = Number((v >> BigInt(8 * i)) & 0xffn)
  }
  return numBytes
}
