#!/usr/bin/env node
/**
 * Fetch the pinned AdvantageScope Lite bundle into
 * packages/web/public/advantagescope/ so Vite's build can copy it into
 * dist/ and the Worker's Workers Static Assets can serve it under
 * /advantagescope/**.
 *
 * Input: packages/web/advantagescope/version.txt + checksums.txt (both
 * committed). version.txt pins the bundle tag; checksums.txt pins the
 * SHA-256 of the tarball.
 *
 * Sources, in priority order:
 *   1. packages/web/.advantagescope-cache/<bundle>.tar.gz (local cache,
 *      populated by publish-advantagescope-bundle.mjs or a previous
 *      fetch). Used when the SHA matches.
 *   2. GitHub release download (when present). URL lives in version.txt
 *      as `release-url=...`; left empty while bundles are produced
 *      locally only.
 *
 * Safety: checksum is verified before extraction. A matching SHA is
 * how we trust the tarball's contents, so aggressive path-filtering on
 * extraction is redundant.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = resolve(__dirname, "..")
const REPO_ROOT = resolve(WEB_DIR, "..", "..")
const PIN_DIR = join(WEB_DIR, "advantagescope")
const CACHE_DIR = join(WEB_DIR, ".advantagescope-cache")
const TARGET_DIR = join(WEB_DIR, "public", "advantagescope")

async function main() {
  const pin = await readPin()
  const expectedSha = await readChecksum(`${pin.bundle}.tar.gz`)
  const tarballPath = join(CACHE_DIR, `${pin.bundle}.tar.gz`)

  if (!existsSync(tarballPath)) {
    if (!pin.releaseUrl) {
      fail(
        `Bundle tarball not in cache and no release-url is pinned.\n` +
          `Run: AS_PATH=~/src/1310/AdvantageScope pnpm publish:advantagescope-bundle`,
      )
    }
    await downloadTarball(pin.releaseUrl, tarballPath)
  }

  const gotSha = await sha256(tarballPath)
  if (gotSha !== expectedSha) {
    fail(
      `Tarball checksum mismatch for ${pin.bundle}\n` +
        `  expected ${expectedSha}\n` +
        `  got      ${gotSha}`,
    )
  }

  await rm(TARGET_DIR, { recursive: true, force: true })
  await mkdir(TARGET_DIR, { recursive: true })

  // --strip-components=1 drops the top-level `static/` directory inside
  // the tarball so files land at TARGET_DIR/index.html, bundles/, etc.
  const result = spawnSync(
    "tar",
    ["-xzf", tarballPath, "-C", TARGET_DIR, "--strip-components=1"],
    { stdio: "inherit" },
  )
  if (result.status !== 0) {
    fail(`tar extract exited with status ${result.status}`)
  }

  log(`extracted ${pin.bundle} into ${relPath(TARGET_DIR)}`)

  await writeAssetsManifest(TARGET_DIR)
  log(`wrote assets-manifest.json`)
}

/**
 * Generate assets-manifest.json mirroring AS Lite's Python server
 * /assets response shape: { "<relative-path>": <config.json contents or null> }.
 * Served verbatim by the Worker's /v/:id/assets route.
 */
async function writeAssetsManifest(root) {
  const bundledDir = join(root, "bundledAssets")
  const manifest = {}
  if (existsSync(bundledDir)) {
    for await (const filePath of walk(bundledDir)) {
      const rel = relative(bundledDir, filePath).split("\\").join("/")
      if (rel.startsWith(".") || rel.includes("/.")) continue
      let contents = null
      if (rel.endsWith("/config.json") || rel === "config.json") {
        try {
          contents = JSON.parse(await readFile(filePath, "utf8"))
        } catch {
          contents = null
        }
      }
      manifest[rel] = contents
    }
  }
  await writeFile(
    join(root, "assets-manifest.json"),
    JSON.stringify(manifest),
  )
}

async function* walk(dir) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry)
    const s = await stat(full)
    if (s.isDirectory()) yield* walk(full)
    else if (s.isFile()) yield full
  }
}

async function readPin() {
  const text = await readFile(join(PIN_DIR, "version.txt"), "utf8")
  const pairs = Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=")
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )
  if (!pairs.bundle) fail("version.txt is missing `bundle=` line")
  return {
    as: pairs.as ?? "unknown",
    bundle: pairs.bundle,
    releaseUrl: pairs["release-url"] ?? null,
  }
}

async function readChecksum(filename) {
  const text = await readFile(join(PIN_DIR, "checksums.txt"), "utf8")
  for (const line of text.split("\n")) {
    const m = line.match(/^([0-9a-f]{64})\s+(\S+)$/i)
    if (m && m[2] === filename) return m[1].toLowerCase()
  }
  fail(`checksums.txt has no entry for ${filename}`)
}

async function sha256(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256")
    createReadStream(path)
      .on("error", rejectHash)
      .on("data", (c) => hash.update(c))
      .on("end", () => resolveHash(hash.digest("hex")))
  })
}

async function downloadTarball(url, dest) {
  log(`downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) fail(`GET ${url} -> ${res.status}`)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
}

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[fetch-advantagescope] ${msg}`)
}

function fail(msg) {
  // eslint-disable-next-line no-console
  console.error(`[fetch-advantagescope] ${msg}`)
  process.exit(1)
}

function relPath(p) {
  if (p.startsWith(REPO_ROOT + "/")) return p.slice(REPO_ROOT.length + 1)
  return p
}

main().catch((err) => fail(String(err?.stack ?? err)))
