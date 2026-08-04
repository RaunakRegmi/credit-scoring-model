# Hosting the Stack — Railway

**Purpose:** put the full stack on a permanent HTTPS URL that works when your laptop is closed.
`scripts/demo-tunnel.sh` covers the live-demo case; this covers the *leave it running* case.

This is a pilot deployment, not a bank deployment. `04-bank-deployment-readiness.md` §2 is still
the authority on the difference, and §6 below restates what this setup does and does not fix.

---

## 1. Why not Vercel

Worth recording, because it is the obvious first guess and the reasons are structural rather than
a matter of configuration.

| Service | Runs on Vercel? | Why |
|---|---|---|
| `web` | Yes | It is a Next.js app. This part Vercel does well. |
| `api` | No | Writes applicant documents to a persistent volume. Vercel's filesystem is ephemeral — every upload is lost on the next cold start. |
| `ml` | No | `xgboost + scikit-learn + shap + numba + pandas` exceeds Vercel's serverless function size limit, and `apps/ml/Dockerfile:37` trains the seed model during the image build. Vercel has no equivalent build step. |
| `postgres` | No | Vercel hosts no database; it resells a managed one. |

Vercel could take one of four services, leaving three to host elsewhere. That is more moving parts
than hosting all four in one place, not fewer.

**The deciding constraint is the ML service.** Every serverless platform has a bundle-size ceiling
and none of them will run `python -m train.train` at deploy time. Anything that keeps `ml` as a
container is a container platform, and once you are on one, the API and Postgres belong there too.

Railway is the recommendation because it consumes all three existing Dockerfiles unchanged. No
rewrite, no serverless port, no storage-layer replacement.

---

## 2. Shape of the deployment

Four services in one Railway project, mapped onto what `docker-compose.yml` already describes:

| Railway service | Source | Public? |
|---|---|---|
| `Postgres` | Railway's managed Postgres | No — private only |
| `ml` | `apps/ml/Dockerfile` | No — private only |
| `api` | `apps/api/Dockerfile` + a 1 GB volume at `/data/storage` | Yes |
| `web` | `apps/web/Dockerfile` | Yes |

`ml` gets no public domain. Nothing outside the project has business calling the scoring service
directly, and the API reaches it over Railway's private network. `api` must be public despite
being a backend, for the same reason `demo-tunnel.sh` needs two tunnels: the dashboard calls the
API from the **browser**, so the API needs an origin the browser can resolve.

### The build-time variable, resolved properly

`NEXT_PUBLIC_API_URL` is inlined by Next at build time and cannot be supplied at runtime. Locally
this forces the rebuild dance in `demo-tunnel.sh`. On Railway it disappears, because Railway
assigns each service a stable domain up front and exposes it as a reference variable:

```
NEXT_PUBLIC_API_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
```

Railway injects service variables as build arguments, and `apps/web/Dockerfile:23` already
declares `ARG NEXT_PUBLIC_API_URL`. The value resolves before the build runs, so the correct URL
is baked into the bundle on the first deploy. The mirror-image variable on the API —
`CORS_ORIGINS=https://${{web.RAILWAY_PUBLIC_DOMAIN}}` — closes the loop the same way.

No Dockerfile changes are required for any of this.

---

## 3. Setup

### 3.0 Push first

Railway builds from GitHub, so it can only build what is pushed.

```bash
git status                    # docker-compose.yml may still be modified
git add -A && git commit -m "…"
git push origin main
```

`.env`, `storage/`, `uploads/` and `export/` are gitignored and stay that way. Every secret below
is set in Railway's own variable store, never in the repo.

### 3.1 Generate the secrets

```bash
./scripts/railway-secrets.sh
```

This prints three ready-to-paste variable blocks and a bootstrap admin password. Keep the terminal
open until you have pasted them — nothing is written to disk.

The keys are new rather than copied from your local `.env`, deliberately: a JWT minted against
your laptop should not be a valid underwriter session on a public URL.

### 3.2 Create the project

1. [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** →
   `RaunakRegmi/credit-scoring-model`.
2. Railway creates one service and starts guessing at a build. Let it fail; the next step tells it
   what to build.
3. Rename that service to **`ml`**. Then **New** → **Database** → **Add PostgreSQL**, and
   **New** → **GitHub Repo** (same repo) twice more, naming them **`api`** and **`web`**.

Service names matter — `ml.railway.internal` and the `${{api.*}}` / `${{web.*}}` references in
§3.3 resolve by name.

### 3.3 Configure each service

For all three built services, leave **Root Directory** at the repository root. The Dockerfiles
`COPY packages/contracts` and `apps/api/…` from the repo root, so a narrower build context breaks
them. `RAILWAY_DOCKERFILE_PATH` is what distinguishes the three services, and it is included in
each variable block from §3.1.

Paste each block into **Variables → Raw Editor**, then set the service-specific settings:

**`ml`** — Settings → Networking → set the target port to **8000**. Do not add a public domain.

> First build takes several minutes: it installs the scientific Python stack and then trains the
> seed model on 24 000 rows. That is expected, and only happens again when `requirements.txt` or
> the training code changes.

**`api`**
- Settings → Networking → **Generate Domain**, target port **4000**.
- Settings → Deploy → **Pre-Deploy Command**: `npx prisma migrate deploy`
  Migrations ship inside the image for exactly this purpose, and a pre-deploy command runs against
  the release before it takes traffic — so a failed migration blocks the deploy rather than
  producing a running API pointed at a schema that does not match its code.
- **Add a Volume**, mount path `/data/storage`, 1 GB.
  The Dockerfile already creates that path and chowns it to the non-root `aics` user. Without the
  volume the API still runs, but uploaded documents vanish on every redeploy.

**`web`** — Settings → Networking → **Generate Domain**, target port **3000**.

### 3.4 Deploy

Deploy `ml` first, then `api`, then `web`. Nothing enforces this — the API is built to keep
deciding on the deterministic scorecard when the model is unreachable, which is the same reason
`ml` is not a hard `depends_on` in compose — but deploying in order means the first health check
you read is a real one.

---

## 4. Verifying

```bash
curl -s https://<api-domain>/healthz          # {"status":"ok",…}
curl -s -o /dev/null -w '%{http_code}\n' https://<web-domain>
```

Then the check that actually predicts whether sign-in works, because two 200s do not:

```bash
curl -s -o /dev/null -w 'CORS preflight: %{http_code}\n' \
  -X OPTIONS https://<api-domain>/api/auth/login \
  -H 'Origin: https://<web-domain>' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
```

`200` or `204` means the dashboard's origin is accepted. Anything else means `CORS_ORIGINS` did
not resolve to the web service's real domain, and every sign-in will fail with a browser error
that does not mention CORS.

Then open the dashboard, sign in as `BOOTSTRAP_ADMIN_EMAIL`, and upload one of the fixtures from
`samples/` end to end. A green health check only proves the API booted; it does not prove the API
can reach the ML service or write to the volume.

### Optional: seed the three reference applicants

The pre-deploy command migrates but does not seed, so the dashboard starts empty. Seeding scores
the three fixtures from the README end to end, which gives your supervisor something to look at
before he uploads anything himself:

```bash
npm i -g @railway/cli && railway login
railway link                                   # select the project, then the api service
railway ssh node dist/prisma/seed.js
```

`node dist/prisma/seed.js` directly, not `npm run db:seed` — the package script prefixes
`nest build`, and the runtime image has dev dependencies pruned out, so the Nest CLI is not there.
The compiled seed is present because the Dockerfile copies the whole `dist` tree.

---

## 5. Giving your supervisor access

Do not share the bootstrap admin account. Create him a real one, which also means he sees the
system as an actual user of it would:

1. Sign in as the administrator.
2. **Staff → New staff account → role Underwriter.**
3. Send him the email and its temporary password. He sets his own on first sign-in.

An `UNDERWRITER` account can work the referral queue, which is the part of §1 in
`04-bank-deployment-readiness.md` worth demonstrating. It cannot create staff or read the audit
configuration, so nothing he clicks can break the deployment.

---

## 6. What this deployment is, and is not

It fixes the availability problem and nothing else. Compared to the tunnel it gains a permanent
URL, managed Postgres with backups, TLS you did not have to arrange, and storage that survives a
restart.

Everything in `04-bank-deployment-readiness.md` §2 still applies. Specifically still absent:

- **No WAF.** The dashboard is on the public internet behind a login form and a rate limiter
  (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`) and nothing else.
- **Secrets live in environment variables**, not a secrets manager. Anyone with access to the
  Railway project can read the JWT signing key.
- **No ingress you control**, no IP allowlist, no audit of who reached the login page.

**Synthetic data only.** This is the operative rule and it is a stronger one here than for the
tunnel, because a permanent URL is permanently reachable. `samples/` is safe. Real applicant CVs
and bank statements are not, and the 5.3 MB currently in your local `storage/` must not be
uploaded to it.

Take the deployment down when the review is over — Settings → Danger → Delete Project. Cost
accrues per-minute against the $5 Hobby credit whether anyone is looking at it or not.

---

## 7. Troubleshooting

**`api` cannot reach `ml`.** Railway environments created before 16 October 2025 resolve
`*.railway.internal` to IPv6 only, and `apps/ml/Dockerfile:48` binds uvicorn to `0.0.0.0`, which
is IPv4-only. New environments are dual-stack, so a project created today is fine. If a private
call to `ml` times out, this is the reason — change the CMD to `--host ::`, which accepts both
families on Linux and is harmless under compose. The symptom is specific: scoring degrades to the
deterministic scorecard rather than erroring, so the dashboard keeps working and only the model
contribution disappears.

**Deploy fails on `prisma migrate deploy`.** Read the pre-deploy logs, not the build logs. Usually
`DATABASE_URL` did not resolve — confirm the Postgres service is named `Postgres`, since
`${{Postgres.DATABASE_URL}}` matches by name.

**API boots then exits immediately.** `apps/api/src/main.ts:50` exits non-zero when configuration
fails validation, which is correct for a credit engine. The log line names the offending variable.
The usual causes are a `JWT_SECRET` that is not at least 64 *hex* characters
(`configuration.ts:41` enforces the alphabet, not just the length), or `BOOTSTRAP_ADMIN_EMAIL` set
without `BOOTSTRAP_ADMIN_PASSWORD` — `configuration.ts:161` requires both or neither.

**TLS error connecting to Postgres.** Railway's private network is already encrypted and its
internal Postgres endpoint does not present a certificate the client will accept, which is why
`ALLOW_INSECURE_DB=true` is in the `api` block. It carries the same meaning as in
`docker-compose.yml:70` — the transport is trusted at the network boundary, not by the client.

**Web bundle calls `localhost:4000`.** `NEXT_PUBLIC_API_URL` was missing or unresolved at build
time and the Dockerfile's default applied. Fix the variable and trigger a fresh deploy — a restart
is not enough, the value is compiled into the bundle.

---

## 8. Cost

Hobby is $5/month including $5 of usage credit, capped at 8 vCPU / 8 GB RAM / 5 GB storage per
service. Four small services and a 1 GB volume sit inside that credit under demo load; the ML
service is the one to watch, since the SHAP explainer holds the model in memory.

Sources: [Railway pricing](https://docs.railway.com/pricing/plans) ·
[Volumes](https://docs.railway.com/volumes) ·
[Monorepo deploys](https://docs.railway.com/deployments/monorepo) ·
[Dockerfiles](https://docs.railway.com/builds/dockerfiles) ·
[Private networking](https://docs.railway.com/private-networking)
