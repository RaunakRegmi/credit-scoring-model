#!/usr/bin/env bash
#
# Generates the three secrets the API refuses to boot without, formatted for pasting into
# Railway's raw-editor variable box.
#
#   ./scripts/railway-secrets.sh
#
# These are *new* keys, deliberately not the ones in your local .env. The local stack and the
# hosted one should not share a JWT signing key: a token minted against your laptop must not be
# a valid underwriter session in the deployment your supervisor is looking at.
#
# ## Consequence of rotating FIELD_ENCRYPTION_KEY
#
# Encrypted applicant fields are unreadable without the key that wrote them. A fresh key on
# Railway therefore means the hosted deployment starts with an empty database — which is what you
# want here, since the local storage/ directory holds documents that should not be uploaded
# anywhere. Do not later swap this key on a Railway deployment that has data in it; the rows do
# not re-encrypt themselves and the API will fail to decrypt them.
#
# FIELD_HASH_KEY has the same property for the blind-index lookups: change it and existing
# hashed lookups stop matching.

set -euo pipefail

command -v openssl >/dev/null || { echo 'openssl is not installed.' >&2; exit 1; }

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

# 32 bytes of entropy, hex-encoded to 64 characters. The API validates the length of JWT_SECRET,
# and the two key-derivation inputs are read as hex.
gen() { openssl rand -hex 32; }

ADMIN_PASSWORD="$(openssl rand -base64 18)"

printf '\n'
bold '─── api service ───────────────────────────────────────────────'
printf '\n'
cat <<EOF
NODE_ENV=production
API_PORT=4000
DATABASE_URL=\${{Postgres.DATABASE_URL}}
ALLOW_INSECURE_DB=true
FIELD_ENCRYPTION_KEY=$(gen)
FIELD_HASH_KEY=$(gen)
JWT_SECRET=$(gen)
ML_SERVICE_URL=http://ml.railway.internal:8000
CORS_ORIGINS=https://\${{web.RAILWAY_PUBLIC_DOMAIN}}
STORAGE_ROOT=/data/storage
BOOTSTRAP_ADMIN_EMAIL=admin@fintara.com.np
BOOTSTRAP_ADMIN_PASSWORD=$ADMIN_PASSWORD
RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile
EOF

printf '\n'
bold '─── web service ───────────────────────────────────────────────'
printf '\n'
cat <<'EOF'
NEXT_PUBLIC_API_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
RAILWAY_DOCKERFILE_PATH=apps/web/Dockerfile
EOF

printf '\n'
bold '─── ml service ────────────────────────────────────────────────'
printf '\n'
cat <<'EOF'
RAILWAY_DOCKERFILE_PATH=apps/ml/Dockerfile
EOF

printf '\n'
bold '───────────────────────────────────────────────────────────────'
printf '\n'
printf '  Sign in at the dashboard with:\n\n'
printf '    %s\n    %s\n\n' 'admin@fintara.com.np' "$ADMIN_PASSWORD"
printf '\033[33m  %s\033[0m\n' 'Save that password now — it is not stored anywhere and is not'
printf '\033[33m  %s\033[0m\n' 'recoverable from the running system once the admin row exists.'
printf '\n'
printf '  These secrets are printed to your terminal and nowhere else. They are\n'
printf '  deliberately not written to a file — .env is gitignored, but scrollback\n'
printf '  is not a place a signing key should live either. Paste them into Railway,\n'
printf '  then clear your terminal.\n\n'
