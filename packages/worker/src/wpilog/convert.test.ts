import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { convertToBytes } from "./convert"
import { encodeValue, mapNt4Type } from "./types"

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function firstMismatch(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

describe("mapNt4Type", () => {
  it("promotes int → int64, float → double, int[]/float[] → double/int64 variants", () => {
    expect(mapNt4Type("int")).toBe("int64")
    expect(mapNt4Type("int[]")).toBe("int64[]")
    expect(mapNt4Type("float")).toBe("double")
    expect(mapNt4Type("float[]")).toBe("double[]")
    expect(mapNt4Type("boolean")).toBe("boolean")
    expect(mapNt4Type("struct:Pose2d")).toBe("struct:Pose2d")
  })
})

describe("encodeValue", () => {
  it("boolean: 0x00 / 0x01", () => {
    expect(Array.from(encodeValue("boolean", false))).toEqual([0x00])
    expect(Array.from(encodeValue("boolean", true))).toEqual([0x01])
  })

  it("double: 8 bytes little-endian IEEE 754", () => {
    const b = encodeValue("double", 1.0)
    // 1.0 == 0x3FF0000000000000 LE → 00 00 00 00 00 00 F0 3F
    expect(Array.from(b)).toEqual([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f])
  })

  it("int: 8 bytes little-endian, truncated", () => {
    const b = encodeValue("int", 256)
    expect(Array.from(b)).toEqual([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  })

  it("double[]: 8 bytes per element", () => {
    const b = encodeValue("double[]", [0, 1])
    expect(b.length).toBe(16)
  })

  it("string[]: u32 count + (u32 len + utf8)*", () => {
    const b = encodeValue("string[]", ["ab", "cde"])
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    expect(view.getUint32(0, true)).toBe(2)
    expect(view.getUint32(4, true)).toBe(2)
    expect(String.fromCharCode(b[8]!, b[9]!)).toBe("ab")
    expect(view.getUint32(10, true)).toBe(3)
    expect(String.fromCharCode(b[14]!, b[15]!, b[16]!)).toBe("cde")
  })

  it("raw/struct types: base64 decode", () => {
    // base64(StdEncoding) of "hi" = "aGk="
    const b = encodeValue("raw", "aGk=")
    expect(Array.from(b)).toEqual([0x68, 0x69])
    const s = encodeValue("struct:Pose2d", "aGk=")
    expect(Array.from(s)).toEqual([0x68, 0x69])
  })

  it("rejects unsupported types", () => {
    expect(() => encodeValue("unknown-type", 0)).toThrow(/unsupported/)
  })
})

describe("convert: minimal inputs", () => {
  it("empty JSONL: header only + default extra header", async () => {
    const { bytes, totalKeys, dataRecords, markerRecords } = await convertToBytes(
      "",
      1310,
      "x",
    )
    // 6 magic + 2 version + 4 length + length(`{"team":1310,"source":"RavenLink","session":"x"}`) = 60 bytes.
    const eh = `{"team":1310,"source":"RavenLink","session":"x"}`
    expect(bytes.length).toBe(12 + eh.length)
    expect(totalKeys).toBe(0)
    expect(dataRecords).toBe(0)
    expect(markerRecords).toBe(0)
  })

  it("one data entry: header + 1 Start record + 1 data record", async () => {
    const jsonl = [
      `{"ts":1000.0,"type":"session_start","session_id":"s"}`,
      `{"ts":1001.0,"server_ts":1000000,"key":"/x","type":"double","value":3.14}`,
    ].join("\n")
    const { totalKeys, dataRecords } = await convertToBytes(jsonl, 1310, "s")
    expect(totalKeys).toBe(1)
    expect(dataRecords).toBe(1)
  })

  it("match markers emit a /RavenLink/MatchEvent Start + one data record per marker", async () => {
    const jsonl = [
      `{"ts":100.0,"type":"session_start","session_id":"s"}`,
      `{"ts":101.0,"type":"match_start","fms_raw":51}`,
      `{"ts":250.0,"type":"match_end"}`,
    ].join("\n")
    const { totalKeys, markerRecords } = await convertToBytes(jsonl, 1310, "s")
    expect(totalKeys).toBe(0) // no NT data topics
    expect(markerRecords).toBe(2)
  })

  it("malformed JSON lines are counted, not fatal", async () => {
    const jsonl = [
      `{"ts":1.0,"type":"session_start"}`,
      `{ not valid json`,
      `{"ts":2.0,"server_ts":1000,"key":"/k","type":"double","value":1.0}`,
    ].join("\n")
    const { malformedLines, dataRecords } = await convertToBytes(jsonl, 1310, "s")
    expect(malformedLines).toBe(1)
    expect(dataRecords).toBe(1)
  })
})

describe("convert: byte-compat with Go encoder (golden file)", () => {
  it("sample-session.jsonl → bytes byte-identical to sample-session.wpilog", async () => {
    const jsonl = base64ToBytes(env.FIXTURE_SAMPLE_JSONL_B64)
    const golden = base64ToBytes(env.FIXTURE_SAMPLE_WPILOG_B64)
    const { bytes } = await convertToBytes(jsonl, 1310, "5f2f31bb")

    if (bytes.length !== golden.length || !bytesEqual(bytes, golden)) {
      const at = firstMismatch(bytes, golden)
      const context = 16
      const start = Math.max(0, at - context)
      const end = Math.min(bytes.length, at + context)
      const hex = (u8: Uint8Array) =>
        Array.from(u8.slice(start, end))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ")
      const msg =
        `byte mismatch at offset ${at}. lengths ours=${bytes.length} golden=${golden.length}\n` +
        `ours:   ${hex(bytes)}\n` +
        `golden: ${hex(golden.subarray(0, bytes.length))}`
      expect.fail(msg)
    }
    expect(bytes.length).toBe(golden.length)
  })
})
