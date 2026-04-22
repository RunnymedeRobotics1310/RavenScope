import { describe, expect, it } from "vitest"
import {
  BufferedWpilogWriter,
  minBytes,
  putVarInt,
  writeDataRecord,
  writeHeader,
  writeStartRecord,
} from "./encoder"

async function collect(fn: (w: BufferedWpilogWriter) => Promise<void>): Promise<Uint8Array> {
  const w = new BufferedWpilogWriter()
  await fn(w)
  return w.toUint8Array()
}

describe("minBytes", () => {
  it("returns 1 for zero and small values, grows with magnitude", () => {
    expect(minBytes(0n, 4)).toBe(1)
    expect(minBytes(1n, 4)).toBe(1)
    expect(minBytes(0xffn, 4)).toBe(1)
    expect(minBytes(0x100n, 4)).toBe(2)
    expect(minBytes(0xffffn, 4)).toBe(2)
    expect(minBytes(0x10000n, 4)).toBe(3)
    expect(minBytes(0xffffffn, 4)).toBe(3)
    expect(minBytes(0x1000000n, 4)).toBe(4)
    expect(minBytes(0xffffffffn, 4)).toBe(4)
    expect(minBytes(0x100000000n, 8)).toBe(5)
    expect(minBytes((1n << 56n) - 1n, 8)).toBe(7)
    expect(minBytes(1n << 56n, 8)).toBe(8)
  })
})

describe("putVarInt", () => {
  it("writes little-endian bytes", () => {
    const buf = new Uint8Array(8)
    putVarInt(buf, 0, 0x1234n, 2)
    expect(Array.from(buf.slice(0, 2))).toEqual([0x34, 0x12])

    buf.fill(0)
    putVarInt(buf, 1, 0xdeadbeefn, 4)
    expect(Array.from(buf.slice(0, 5))).toEqual([0x00, 0xef, 0xbe, 0xad, 0xde])
  })
})

describe("writeHeader", () => {
  it("empty extra header: 12 bytes", async () => {
    const got = await collect((w) => writeHeader(w, ""))
    expect(Array.from(got)).toEqual([
      0x57, 0x50, 0x49, 0x4c, 0x4f, 0x47, // "WPILOG"
      0x00, 0x01, // version 0x0100 LE
      0x00, 0x00, 0x00, 0x00, // extra header length = 0
    ])
  })

  it("with extra header: prefixed by its byte length", async () => {
    const got = await collect((w) => writeHeader(w, `{"team":1310}`))
    // 6 magic + 2 version + 4 length + 13 text = 25 bytes
    expect(got.length).toBe(25)
    expect(new DataView(got.buffer, got.byteOffset).getUint32(8, true)).toBe(13)
    expect(new TextDecoder().decode(got.slice(12))).toBe(`{"team":1310}`)
  })
})

describe("writeStartRecord", () => {
  it("encodes small-field Start record with entryBytes=1, sizeBytes=1, tsBytes=1", async () => {
    const got = await collect((w) => writeStartRecord(w, 1, "x", "int64", "", 0n))
    // Payload: 1 (type) + 4 (entryID=1) + 4 (nameLen=1) + 1 ("x")
    //        + 4 (typeLen=5) + 5 ("int64") + 4 (metaLen=0) = 23 bytes.
    // Header: entryID=0 (1B), size=23 (1B), ts=0 (1B) → headerByte=0
    //         followed by entryID(1B)=0, size(1B)=23, ts(1B)=0.
    expect(got[0]).toBe(0x00) // header bitfield
    expect(got[1]).toBe(0x00) // entry id = 0 (control record)
    expect(got[2]).toBe(23) // payload size
    expect(got[3]).toBe(0x00) // timestamp

    // First byte of payload is the Start control tag.
    expect(got[4]).toBe(0x00)
    // entry id in payload = 1
    const view = new DataView(got.buffer, got.byteOffset)
    expect(view.getUint32(5, true)).toBe(1)
    // name length, then bytes
    expect(view.getUint32(9, true)).toBe(1)
    expect(String.fromCharCode(got[13]!)).toBe("x")
  })

  it("bumps the ts byte count when the control-record timestamp is wide", async () => {
    // Start records are control records — the record header's entryID is
    // always 0 (the real entryID lives in the payload). So only the ts
    // + size bit-fields of the header can grow.
    const got = await collect((w) =>
      writeStartRecord(w, 0x123456, "/big/topic", "double", "", 0x123456789an),
    )
    const headerByte = got[0]!
    // entryBytes - 1: control-record entryID=0 → always 0
    expect(headerByte & 0b11).toBe(0)
    // tsBytes - 1: 0x123456789A needs 5 bytes → bits 6-4 = 4
    expect((headerByte >> 4) & 0b111).toBe(4)
  })
})

describe("writeDataRecord", () => {
  it("writes payload bytes verbatim after the compact header", async () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc])
    const got = await collect((w) => writeDataRecord(w, 5, 1_000_000n, payload))
    // header(1) + entryID(1=1B) + size(1=3→1B) + ts(1_000_000=3B) = 6 header bytes
    // total = 6 + 3 payload
    expect(got.length).toBe(9)
    expect(got[1]).toBe(5) // entryID
    expect(got[2]).toBe(3) // size
    // Last 3 bytes should be the payload.
    expect(Array.from(got.slice(-3))).toEqual([0xaa, 0xbb, 0xcc])
  })
})
