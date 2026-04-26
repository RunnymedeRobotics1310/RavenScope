#!/usr/bin/env bash
#
# One-shot Cloudflare bootstrap for a fresh RavenScope deployment.
# Idempotent: safe to re-run; only creates resources that don't exist.
#
# Prerequisites:
#   - Cloudflare account with Workers, D1, and R2 enabled (all on free tier)
#   - You've run `pnpm install` at the repo root (installs wrangler locally)
#   - You've run `pnpm --filter @ravenscope/worker exec wrangler login` once
#   - A Resend API key (https://resend.com/api-keys)
#   - jq installed (brew install jq / apt install jq / etc.)
#
# Usage (from repo root):
#   scripts/setup.sh
#
# After the script completes, run `pnpm build` then `pnpm -F
# @ravenscope/worker exec wrangler deploy` to push the Worker.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="${ROOT}/packages/worker"
WRANGLER_TOML="${WORKER_DIR}/wrangler.toml"
WRANGLER_TEMPLATE="${WORKER_DIR}/wrangler.toml.example"

# Colors — only when stderr is a tty.
if [[ -t 2 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; RESET=''
fi

log()  { printf "${BOLD}▸${RESET} %s\n" "$1" >&2; }
ok()   { printf "${GREEN}✓${RESET} %s\n" "$1" >&2; }
warn() { printf "${RED}!${RESET} %s\n" "$1" >&2; }
die()  { printf "${RED}✗${RESET} %s\n" "$1" >&2; exit 1; }

# Runs wrangler via the worker package's local install. Resolves
# wrangler.toml automatically because cwd is the worker package dir.
wrangler_cmd() { (cd "$WORKER_DIR" && pnpm exec wrangler "$@"); }

# --- pre-flight ------------------------------------------------------

command -v pnpm >/dev/null 2>&1 || die "pnpm not found — install pnpm first (https://pnpm.io/installation)."
command -v jq >/dev/null 2>&1 || die "jq not found — brew install jq (or the equivalent)."
command -v node >/dev/null 2>&1 || die "node not found — install Node 20+ first."

# Verify the local wrangler install is usable.
wrangler_cmd --version >/dev/null 2>&1 || die "wrangler not found locally. Run 'pnpm install' at the repo root first."

# Materialize wrangler.toml from the template if it's not already there.
# The real wrangler.toml is gitignored — each deployment owns its own
# database_id, EMAIL_FROM, and OPERATOR_EMAIL — so a fresh clone always
# starts from the template.
if [[ ! -f "$WRANGLER_TOML" ]]; then
  [[ -f "$WRANGLER_TEMPLATE" ]] || die "wrangler.toml.example missing at $WRANGLER_TEMPLATE — run from a fresh clone."
  cp "$WRANGLER_TEMPLATE" "$WRANGLER_TOML"
  ok "created wrangler.toml from template"
fi

wrangler_cmd whoami >/dev/null 2>&1 || die "wrangler not logged in. Run 'pnpm -F @ravenscope/worker exec wrangler login' and retry."

log "wrangler authenticated ($(wrangler_cmd whoami 2>&1 | grep -Eo 'email [^ ]+' | head -1 || echo 'account OK'))"

# --- D1 database -----------------------------------------------------

log "ensuring D1 database 'ravenscope' exists"
D1_JSON="$(wrangler_cmd d1 list --json 2>/dev/null || echo '[]')"
D1_ID="$(echo "$D1_JSON" | jq -r '.[] | select(.name=="ravenscope") | .uuid')"
if [[ -z "$D1_ID" ]]; then
  CREATE_OUT="$(wrangler_cmd d1 create ravenscope 2>&1 || true)"
  D1_ID="$(echo "$CREATE_OUT" | grep -Eo '"database_id":[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)".*/\1/')"
  [[ -n "$D1_ID" ]] || die "failed to create D1 database. Output:\n$CREATE_OUT"
  ok "created D1 database $D1_ID"
else
  ok "D1 database already exists ($D1_ID)"
fi

# Swap the database_id placeholder in wrangler.toml with the real ID.
# Preserves a backup at wrangler.toml.bak on the first successful run.
if grep -q 'REPLACE_ME_AFTER_wrangler_d1_create' "$WRANGLER_TOML"; then
  cp "$WRANGLER_TOML" "${WRANGLER_TOML}.bak"
  sed -i.tmp "s|REPLACE_ME_AFTER_wrangler_d1_create|${D1_ID}|" "$WRANGLER_TOML"
  rm "${WRANGLER_TOML}.tmp"
  ok "wrote D1 database_id into wrangler.toml"
else
  ok "wrangler.toml already references a concrete database_id"
fi

# --- R2 bucket -------------------------------------------------------

log "ensuring R2 bucket 'ravenscope-blobs' exists"
R2_JSON="$(wrangler_cmd r2 bucket list --json 2>/dev/null || echo '{}')"
R2_EXISTS="$(echo "$R2_JSON" | jq -r '.buckets[]?.name // empty' | grep -Fx "ravenscope-blobs" || true)"
if [[ -z "$R2_EXISTS" ]]; then
  wrangler_cmd r2 bucket create ravenscope-blobs >/dev/null
  ok "created R2 bucket ravenscope-blobs"
else
  ok "R2 bucket ravenscope-blobs already exists"
fi

# R2 privacy check: neither the r2.dev subdomain nor a custom domain
# should be enabled. wrangler's `r2 bucket domain list` subcommand
# reports both in wrangler v3/v4.
log "verifying R2 bucket has no public access"
DOMAIN_JSON="$(wrangler_cmd r2 bucket domain list ravenscope-blobs --json 2>/dev/null || echo '{}')"
R2_DEV_ENABLED="$(echo "$DOMAIN_JSON" | jq -r '.r2_dev?.enabled // false')"
CUSTOM_DOMAINS="$(echo "$DOMAIN_JSON" | jq -r '.domains[]?.domain // empty' | wc -l | tr -d ' ')"
if [[ "$R2_DEV_ENABLED" == "true" ]]; then
  die "R2 bucket has the r2.dev subdomain enabled — disable it in the dashboard before deploying (Settings → R2.dev subdomain)."
fi
if [[ "$CUSTOM_DOMAINS" != "0" ]]; then
  die "R2 bucket has $CUSTOM_DOMAINS custom domain(s) attached — remove them before deploying."
fi
ok "R2 bucket is private (no r2.dev, no custom domain)"

# --- D1 migrations ---------------------------------------------------

log "applying D1 migrations to remote"
wrangler_cmd d1 migrations apply DB --remote >/dev/null
ok "D1 migrations applied"

# --- SESSION_SECRET --------------------------------------------------

if wrangler_cmd secret list 2>/dev/null | grep -q SESSION_SECRET; then
  ok "SESSION_SECRET already set"
else
  log "generating 32-byte SESSION_SECRET"
  SECRET_VALUE="$(node -e "console.log(JSON.stringify({v1: require('crypto').randomBytes(32).toString('base64')}))")"
  echo "$SECRET_VALUE" | wrangler_cmd secret put SESSION_SECRET >/dev/null
  ok "SESSION_SECRET set (stored encrypted in Cloudflare — not shown)"
fi

# --- RESEND_API_KEY --------------------------------------------------

if wrangler_cmd secret list 2>/dev/null | grep -q RESEND_API_KEY; then
  ok "RESEND_API_KEY already set"
else
  printf "\n${DIM}Paste your Resend API key (https://resend.com/api-keys).${RESET}\n" >&2
  printf "Key: " >&2
  read -rs RESEND_KEY
  printf "\n" >&2
  [[ "$RESEND_KEY" =~ ^re_ ]] || warn "doesn't look like a Resend key (expected re_…) — continuing anyway"
  echo "$RESEND_KEY" | wrangler_cmd secret put RESEND_API_KEY >/dev/null
  ok "RESEND_API_KEY set"
fi

# --- EMAIL_FROM ------------------------------------------------------

CURRENT_FROM="$(grep -E '^EMAIL_FROM' "$WRANGLER_TOML" | sed -E 's/.*"([^"]*)".*/\1/' || true)"
if [[ "$CURRENT_FROM" == "no-reply@ravenscope.example.com" || -z "$CURRENT_FROM" ]]; then
  printf "\n${DIM}Enter the from-address for magic-link emails (must be a verified${RESET}\n" >&2
  printf "${DIM}sender in Resend). Example: no-reply@ravenscope.yourdomain.com${RESET}\n" >&2
  printf "From: " >&2
  read -r FROM_ADDR
  [[ -n "$FROM_ADDR" ]] || die "EMAIL_FROM is required."
  # Replace the existing EMAIL_FROM line in-place.
  sed -i.tmp "s|^EMAIL_FROM = \".*\"|EMAIL_FROM = \"${FROM_ADDR}\"|" "$WRANGLER_TOML"
  rm "${WRANGLER_TOML}.tmp"
  ok "EMAIL_FROM set to ${FROM_ADDR}"
else
  ok "EMAIL_FROM already set to ${CURRENT_FROM}"
fi

# --- OPERATOR_EMAIL --------------------------------------------------

CURRENT_OP="$(grep -E '^OPERATOR_EMAIL' "$WRANGLER_TOML" | sed -E 's/.*"([^"]*)".*/\1/' || true)"
if [[ -z "$CURRENT_OP" ]]; then
  printf "\n${DIM}Enter the operator email address that should receive daily-cap${RESET}\n" >&2
  printf "${DIM}breach alerts (one email per metric per day). Leave blank to${RESET}\n" >&2
  printf "${DIM}disable alerts entirely — 429 enforcement still fires either way.${RESET}\n" >&2
  printf "Operator email (blank = disabled): " >&2
  read -r OP_ADDR
  if [[ -n "$OP_ADDR" ]]; then
    sed -i.tmp "s|^OPERATOR_EMAIL = \".*\"|OPERATOR_EMAIL = \"${OP_ADDR}\"|" "$WRANGLER_TOML"
    rm "${WRANGLER_TOML}.tmp"
    ok "OPERATOR_EMAIL set to ${OP_ADDR}"
  else
    ok "OPERATOR_EMAIL left blank (alerts disabled)"
  fi
else
  ok "OPERATOR_EMAIL already set to ${CURRENT_OP}"
fi

# --- final summary ---------------------------------------------------

printf "\n${GREEN}${BOLD}Setup complete.${RESET}\n" >&2
printf "\nNext steps:\n" >&2
printf "  1. ${BOLD}pnpm build${RESET}\n" >&2
printf "  2. ${BOLD}pnpm -F @ravenscope/worker exec wrangler deploy${RESET}\n" >&2
printf "  3. Sign in at your Worker URL and mint an API key for RavenLink.\n" >&2
printf "\nSESSION_SECRET rotation (when needed): see README → 'Rotating SESSION_SECRET'.\n" >&2
