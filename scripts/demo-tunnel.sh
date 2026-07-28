#!/usr/bin/env bash
#
# Publishes the local stack on two temporary HTTPS URLs, for a demo.
#
#   ./scripts/demo-tunnel.sh
#
# Both URLs live only as long as this script runs. Ctrl-C tears the tunnels down and restores the
# stack to localhost.
#
# ## Why two tunnels
#
# The dashboard calls the API from the *browser*, not server-side, so the API needs its own public
# origin — one tunnel in front of the web container is not enough. That creates a circular
# dependency, which is the whole reason this script exists rather than a couple of manual commands:
#
#   · the web bundle needs the API's public URL, because `NEXT_PUBLIC_API_URL` is inlined by Next at
#     **build** time and cannot be supplied at runtime, and
#   · the API needs the dashboard's public URL in `CORS_ORIGINS`, or it rejects every request.
#
# Neither URL exists until its tunnel is up. So: start both tunnels, harvest both URLs, then
# reconfigure and rebuild both containers. Doing it in any other order gives you a dashboard that
# loads and cannot talk to anything.
#
# ## Before sharing the link
#
# `docs/04-bank-deployment-readiness.md` §2 lists what this deployment does *not* have: no WAF, no
# TLS-terminating ingress you control, secrets in environment variables. Acceptable for a short demo
# over synthetic data. Not acceptable for real applicant documents. Take it down when you are done.

set -euo pipefail

cd "$(dirname "$0")/.."

readonly LOG_DIR="${TMPDIR:-/tmp}/aics-tunnel-$$"
readonly API_LOG="$LOG_DIR/api.log"
readonly WEB_LOG="$LOG_DIR/web.log"
mkdir -p "$LOG_DIR"

API_TUNNEL_PID=""
WEB_TUNNEL_PID=""

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m  %s\033[0m\n' "$1"; }
fail() { printf '\033[31m  %s\033[0m\n' "$1" >&2; exit 1; }

readonly RESTORE_CMD="CORS_ORIGINS='http://localhost:3000' NEXT_PUBLIC_API_URL='http://localhost:4000' docker compose up -d --build api web"

CLEANED_UP=0

cleanup() {
  # EXIT fires after INT/TERM have already run this, so guard against doing it twice.
  [ "$CLEANED_UP" -eq 1 ] && return 0
  CLEANED_UP=1

  printf '\n'
  bold 'Shutting down'

  for pid in "$API_TUNNEL_PID" "$WEB_TUNNEL_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Belt and braces: a cloudflared that outlives this script leaves a public URL pointing at a
  # stack that has been reconfigured out from under it.
  pkill -f 'cloudflared tunnel --url http://localhost:4000' 2>/dev/null || true
  pkill -f 'cloudflared tunnel --url http://localhost:3000' 2>/dev/null || true
  info 'Tunnels closed.'

  # Put the stack back on localhost. Without this the containers keep a bundle baked against a
  # tunnel URL that no longer resolves, and local development silently stops working — the
  # dashboard loads and every request fails.
  info 'Restoring the stack to localhost (this rebuilds the dashboard, ~30s)...'
  if CORS_ORIGINS='http://localhost:3000' NEXT_PUBLIC_API_URL='http://localhost:4000' \
       docker compose up -d --build api web >/dev/null 2>&1; then
    info 'Done. http://localhost:3000 works again.'
  else
    warn 'Restore failed. Interrupting a rebuild can leave a half-created container behind.'
    warn 'Recover with:'
    warn "  docker compose rm -sf api web && $RESTORE_CMD"
  fi

  rm -rf "$LOG_DIR"
}

# INT and TERM re-raise so the exit status reflects the signal, and EXIT is what actually guarantees
# the restore runs however the script ends — including on `set -e` aborting midway.
trap cleanup EXIT
trap 'cleanup; trap - INT; kill -INT $$' INT
trap 'cleanup; trap - TERM; kill -TERM $$' TERM

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

bold 'Preflight'

command -v docker >/dev/null || fail 'docker is not installed.'

if ! command -v cloudflared >/dev/null; then
  warn 'cloudflared is not installed.'
  if command -v brew >/dev/null; then
    info 'Install it with:  brew install cloudflared'
  else
    info 'Install it from:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
  fi
  exit 1
fi
info "cloudflared $(cloudflared --version 2>&1 | awk '{print $3}')"

if [ ! -f .env ]; then
  fail '.env is missing. Copy .env.example and generate the keys (see README Quick start).'
fi
grep -q '^JWT_SECRET=.\{64,\}' .env || fail 'JWT_SECRET is missing or too short in .env.'
info '.env looks usable'

# The stack must already be running: this script republishes it, it does not provision it.
if ! docker compose ps --status running --services 2>/dev/null | grep -q '^api$'; then
  warn 'The api container is not running. Starting the stack...'
  docker compose up -d >/dev/null
  sleep 12
fi

curl -sf --max-time 5 http://localhost:4000/healthz >/dev/null \
  || fail 'The API is not answering on localhost:4000. Check: docker compose logs api'
info 'API healthy on localhost:4000'

# ---------------------------------------------------------------------------
# Tunnels
# ---------------------------------------------------------------------------

# Harvests the assigned hostname out of cloudflared's log. Quick tunnels print it once, on stderr,
# a second or two after start.
wait_for_url() {
  local log_file=$1 label=$2 url=''
  for _ in $(seq 1 60); do
    url=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$log_file" 2>/dev/null | head -1 || true)
    if [ -n "$url" ]; then
      printf '%s' "$url"
      return 0
    fi
    sleep 1
  done
  warn "Timed out waiting for the $label tunnel. Log follows:"
  tail -20 "$log_file" >&2
  return 1
}

printf '\n'
bold 'Opening tunnels'

cloudflared tunnel --url http://localhost:4000 --no-autoupdate >"$API_LOG" 2>&1 &
API_TUNNEL_PID=$!
API_URL=$(wait_for_url "$API_LOG" 'API') || fail 'Could not open the API tunnel.'
info "API      $API_URL"

cloudflared tunnel --url http://localhost:3000 --no-autoupdate >"$WEB_LOG" 2>&1 &
WEB_TUNNEL_PID=$!
WEB_URL=$(wait_for_url "$WEB_LOG" 'dashboard') || fail 'Could not open the dashboard tunnel.'
info "Dashboard $WEB_URL"

# ---------------------------------------------------------------------------
# Reconfigure for the public origins
# ---------------------------------------------------------------------------

printf '\n'
bold 'Rebuilding against the public URLs'
info 'The dashboard bundle inlines the API URL at build time, so this step is a real rebuild.'

# Both containers in one invocation: the API needs the dashboard's origin for CORS, the dashboard
# needs the API's origin baked in. Localhost stays allowed so you can keep using it yourself.
CORS_ORIGINS="$WEB_URL,http://localhost:3000" \
NEXT_PUBLIC_API_URL="$API_URL" \
  docker compose up -d --build api web

info 'Waiting for the dashboard to come up...'
for _ in $(seq 1 40); do
  if curl -sf --max-time 5 -o /dev/null "$WEB_URL"; then break; fi
  sleep 2
done

# ---------------------------------------------------------------------------
# Verify through the tunnel, not just locally
# ---------------------------------------------------------------------------

printf '\n'
bold 'Checking the public URLs'

if curl -sf --max-time 10 "$API_URL/healthz" | grep -q '"status":"ok"'; then
  info 'API reachable through the tunnel'
else
  warn "API tunnel is not answering yet — give it a few seconds, then retry $API_URL/healthz"
fi

if curl -sf --max-time 10 -o /dev/null -w '%{http_code}' "$WEB_URL" | grep -q '200'; then
  info 'Dashboard reachable through the tunnel'
else
  warn "Dashboard tunnel is not answering yet — try $WEB_URL in a browser"
fi

# A cross-origin preflight is the thing that actually breaks a tunnelled SPA, so check it directly
# rather than inferring it from the two 200s above.
CORS_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X OPTIONS "$API_URL/api/auth/login" \
  -H "Origin: $WEB_URL" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' || echo '000')

case "$CORS_STATUS" in
  200|204) info "CORS preflight accepted from the dashboard origin ($CORS_STATUS)" ;;
  *)       warn "CORS preflight returned $CORS_STATUS — sign-in will fail. Check: docker compose logs api" ;;
esac

# ---------------------------------------------------------------------------
# Hand over
# ---------------------------------------------------------------------------

printf '\n'
bold '───────────────────────────────────────────────────────────────'
bold "  Share this link:  $WEB_URL"
bold '───────────────────────────────────────────────────────────────'
printf '\n'
info 'Sign-in is required. If you have not made a demo account yet:'
info '  1. sign in as your administrator'
info '  2. Staff → New staff account → role Underwriter'
info '  3. give your supervisor that email and its temporary password'
info '     (they will be asked to set their own on first sign-in)'
printf '\n'
info 'Both URLs stop working the moment this script exits.'
warn 'Synthetic data only. No WAF, no ingress you control — see docs/04 §2.'
printf '\n'
bold 'Press Ctrl-C to close the tunnels and restore localhost.'

# Surface a tunnel that dies rather than leaving a dead link up.
while true; do
  if ! kill -0 "$API_TUNNEL_PID" 2>/dev/null; then
    warn 'The API tunnel died. Log:'; tail -20 "$API_LOG" >&2; exit 1
  fi
  if ! kill -0 "$WEB_TUNNEL_PID" 2>/dev/null; then
    warn 'The dashboard tunnel died. Log:'; tail -20 "$WEB_LOG" >&2; exit 1
  fi
  sleep 5
done
