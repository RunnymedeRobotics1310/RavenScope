#!/usr/bin/env node
/**
 * Build the AdvantageScope Lite bundle against a local AS clone,
 * apply RavenScope's patches, tar it up, and publish the result. Run
 * once per AS version bump; CI does not run this script.
 *
 * Prerequisites (one-time per dev machine):
 *   - AS_PATH env var pointing at a local AdvantageScope clone.
 *   - Emscripten 4.0.12 activated in the current shell
 *     (`source ~/src/emsdk/emsdk_env.sh`).
 *   - `gh` CLI authenticated to the RavenScope org (only needed for
 *     the actual `gh release upload` step, which this script will skip
 *     with a clear note until we start publishing releases).
 *
 * Steps:
 *   1. Checkout the AS tag from version.txt in AS_PATH.
 *   2. Ensure node_modules are installed (ignore-scripts respected --
 *      the user's global npmrc may set it; we run the postinstall
 *      chain manually to guarantee bundledAssets/ is populated).
 *   3. Apply main.ts.patch (the ?log= URL-param auto-open hook).
 *   4. npm run wasm:compile + ASCOPE_DISTRIBUTION=LITE npm run compile +
 *      npm run docs:build-embed.
 *   5. Tar `lite/static/**` into .advantagescope-cache/<bundle>.tar.gz.
 *   6. Compute SHA-256 and write advantagescope/checksums.txt.
 *   7. Print a done-summary and, if a GitHub release isn't already
 *      pinned, instruct the developer on the final `gh release` step.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = resolve(__dirname, "..")
const PIN_DIR = join(WEB_DIR, "advantagescope")
const CACHE_DIR = join(WEB_DIR, ".advantagescope-cache")
const PATCH_PATH = join(PIN_DIR, "main.ts.patch")

async function main() {
  const asPath = process.env.AS_PATH
  if (!asPath) fail("AS_PATH is not set; point it at a local AdvantageScope clone")
  if (!existsSync(asPath)) fail(`AS_PATH does not exist: ${asPath}`)
  if (!existsSync(join(asPath, "package.json"))) {
    fail(`AS_PATH does not look like an AS clone: ${asPath}`)
  }

  ensureEmcc()

  const pin = await readPin()
  log(`building ${pin.bundle} against AS tag ${pin.as}`)

  sh(asPath, "git", ["fetch", "--tags"])
  sh(asPath, "git", ["checkout", pin.as])

  // Reset any stale patch from a previous run so apply is clean.
  sh(asPath, "git", ["checkout", "--", "src/main/lite/main.ts"])

  // Run the postinstall chain explicitly (user's global npmrc may have
  // ignore-scripts=true, which would skip the chain under a plain
  // `npm ci`).
  sh(asPath, "npm", ["ci"])
  sh(asPath, "npm", ["run", "--ignore-scripts=false", "postinstall"])

  // Apply the RavenScope main.ts patch.
  if (existsSync(PATCH_PATH)) {
    sh(asPath, "git", ["apply", PATCH_PATH])
    log(`applied ${relPath(PATCH_PATH)}`)
  }

  sh(asPath, "npm", ["run", "wasm:compile"])
  sh(asPath, "npm", ["run", "compile"], { ASCOPE_DISTRIBUTION: "LITE" })
  sh(asPath, "npm", ["run", "docs:build-embed"])

  await mkdir(CACHE_DIR, { recursive: true })
  const tarballPath = join(CACHE_DIR, `${pin.bundle}.tar.gz`)
  const liteDir = join(asPath, "lite")
  // -h dereferences symlinks (AS's static/ has www and docs/build
  // symlinked to outside the static/ dir); without -h the extraction
  // target would have dangling symlinks that crash Vite's copyDir.
  sh(liteDir, "tar", ["-czhf", tarballPath, "static"])
  log(`tarball written to ${relPath(tarballPath)}`)

  const sha = await sha256(tarballPath)
  await writeFile(
    join(PIN_DIR, "checksums.txt"),
    `${sha}  ${pin.bundle}.tar.gz\n`,
  )
  log(`SHA-256: ${sha}`)
  log(`wrote ${relPath(join(PIN_DIR, "checksums.txt"))}`)

  // Restore the AS checkout so subsequent dev doesn't get surprised by
  // a patched working tree.
  sh(asPath, "git", ["checkout", "--", "src/main/lite/main.ts"])

  printNextSteps(pin, tarballPath)
}

function ensureEmcc() {
  const r = spawnSync("emcc", ["--version"], { stdio: "pipe" })
  if (r.status !== 0) {
    fail(
      `emcc not found on PATH.\n` +
        `Run: source ~/src/emsdk/emsdk_env.sh  (see packages/web/advantagescope/README for setup)`,
    )
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
  if (!pairs.as) fail("version.txt is missing `as=` line")
  if (!pairs.bundle) fail("version.txt is missing `bundle=` line")
  return { as: pairs.as, bundle: pairs.bundle, releaseUrl: pairs["release-url"] ?? null }
}

function sh(cwd, cmd, args, extraEnv = {}) {
  log(`$ ${cmd} ${args.join(" ")}  (in ${relPath(cwd)})`)
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  })
  if (r.status !== 0) fail(`${cmd} exited with status ${r.status}`)
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

function printNextSteps(pin, tarballPath) {
  const lines = [
    "",
    "Done.",
    "",
    "Next steps:",
    "  1. git add packages/web/advantagescope/checksums.txt",
    "  2. pnpm fetch:advantagescope  # sanity-check local cache",
    "  3. pnpm -F @ravenscope/web build  # verify bundle ends up in dist/",
    "",
  ]
  if (!pin.releaseUrl) {
    lines.push(
      "  4. (When publishing) Create a RavenScope GitHub release and attach",
      `     the tarball:`,
      `       gh release create ${pin.bundle} ${tarballPath} \\`,
      `         --title "${pin.bundle}" \\`,
      `         --notes "Lite bundle built from AS ${pin.as}"`,
      "     Then add a line to packages/web/advantagescope/version.txt:",
      `       release-url=https://github.com/<org>/<repo>/releases/download/${pin.bundle}/${pin.bundle}.tar.gz`,
      "",
    )
  }
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"))
}

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[publish-advantagescope-bundle] ${msg}`)
}

function fail(msg) {
  // eslint-disable-next-line no-console
  console.error(`[publish-advantagescope-bundle] ${msg}`)
  process.exit(1)
}

function relPath(p) {
  const root = resolve(WEB_DIR, "..", "..")
  if (p.startsWith(root + "/")) return p.slice(root.length + 1)
  return p
}

main().catch((err) => fail(String(err?.stack ?? err)))
