# Saathi server

Backend for Saathi, a diet/routine companion Android app with a dietitian marketplace.
Node 22, TypeScript (strict), Express, Mongoose/MongoDB, zod, vitest. The server is the source of truth; the phone keeps a local copy and syncs.

```
npm install
cp .env.example .env      # edit; needs a MongoDB (local or Atlas)
npm run seed:dev          # default fees, packages, region packs (idempotent, never overwrites admin edits)
npm run dev
npm run typecheck && npm test
```

Scripts: `dev`, `build`, `start`, `test`, `typecheck`, `seed` (compiled), `seed:dev` (tsx).

## Layout

```
src/
  index.ts  app.ts  seed.ts
  config/env.ts            zod-validated env; strict checks in production
  interfaces/index.ts      Mailer, SmsProvider, IdTokenVerifier, PlayBilling, AiPlanReader
  stubs/index.ts           stub/console implementations (+ TODOs for real ones)
  middleware/              auth (requireAuth/requireRole/requirePremium), rateLimit, error
  models/                  Mongoose models
  routes/                  one router per area
  schemas/plan.ts          zod schema for plan-as-data
  services/                PURE logic (money, planCheck, planDiff, otpLogic, syncLogic, orderState,
                           entitlement, pricing, verification, partnerLogic, serializers, configCache)
                           and DB services (otp, tokens, feeConfig, users)
  utils/                   errors, http helpers, crypto, time, logger
tests/                     vitest: pure logic + HTTP wiring that needs no database
```

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `NODE_ENV` | development | `production` enforces the checks below |
| `PORT` | 3000 | Heroku sets it |
| `MONGODB_URI` | local | required in production |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OTP_PEPPER` | dev values | required in production, >= 32 chars; access and refresh must differ |
| `ACCESS_TOKEN_TTL_MIN` / `REFRESH_TOKEN_TTL_DAYS` | 15 / 30 | |
| `ADMIN_EMAILS` | empty | comma list; these emails get the `admin` role on sign-in |
| `CORS_ORIGINS` | empty (CORS off) | comma list; the Android app does not need CORS |
| `APP_LINK_BASE` | https://saathi.example | base of partner invite links |
| `CONFIG_CACHE_TTL_SECONDS` | 60 | fee/package cache TTL |
| `ALLOW_STUB_PROVIDERS` | false | in production, stub SMS/Google/Apple/Play/AI are refused (HTTP 501) unless `true`. Never set it in a real launch |
| `GOOGLE_CLIENT_IDS`, `APPLE_CLIENT_ID`, `PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `ANTHROPIC_API_KEY` | | reserved for the real providers (see "Stubs") |

## Conventions

- Errors: `{ "error": { "code", "message", "details?" } }`. Validation failures are 400 `validation_error`.
- Auth: `Authorization: Bearer <accessToken>`. Roles: `client`, `dietitian`, `partner`, `admin`. `dietitian` is granted on approval, `partner` on accepting an invite, `admin` from `ADMIN_EMAILS`.
- Money is always integer minor units. Dates are ISO 8601.
- Logs are JSON on stdout. Request logs hold method/path/status only. OTPs and tokens are never logged; the console mailer prints message bodies only outside production.

## Endpoints (all under `/v1` unless noted)

Public: `GET /health` (also `/v1/health`), `GET /region/:country`, `GET /packages`, `GET /dietitians`, `GET /dietitians/:id`.

**Auth** (`/auth`, rate limited, 30 req / 15 min / IP)
- `POST /auth/otp/request {email}` and `POST /auth/otp/verify {email, code, signup?}`: 6 digits, 10 min expiry, 5 wrong tries then a 10 min lock, 60 s resend cooldown. Failed-attempt counters carry over resends. Only a peppered HMAC of the code is stored.
  - Verify returns `{user, tokens, isNewUser}`. `signup {displayName?, phone?, acceptTerms?, termsVersion?}` is applied only when the request creates the account; an existing account is never changed by it. `user.needsProfile` is true until the account has a name and accepted terms.
  - Error codes the apps switch on: `otp_incorrect` (400, `details.attemptsLeft`), `otp_expired` (400), `otp_no_code` (400), `otp_locked` (429, `details.retryAfterSeconds`), `otp_cooldown` (429, `details.retryAfterSeconds`), `account_deleted` (403). The per-IP limiter keeps `too_many_requests`.
- `POST /auth/google {idToken}`, `POST /auth/apple {idToken}`
- `POST /auth/refresh {refreshToken}` (rotation; re-use of a rotated token revokes the whole family), `POST /auth/logout {refreshToken}`
- `POST /auth/phone/request {phone}` and `POST /auth/phone/verify {phone, code}` (auth required, E.164, lazy: only call it when a feature needs a verified phone)

**Account**: `GET /me`, `PATCH /me {displayName,country,timezone,phone,acceptTerms,termsVersion}` (phone is E.164 or null; a changed number becomes unverified; `acceptTerms: true` records the consent time and version), `GET /me/export`, `DELETE /me` (blocked with 409 while an order is paid/in progress/delivered; financial order rows are retained).

**Sync**: `POST /sync/push`, `GET /sync/pull?since=ISO&collections=a,b`
- Collections: `planItems, logs, metrics, sleepLogs, stepDays, cycleRecords, settings, answers`. `answers` (onboarding/settings answers: `clientId` = dataset key, payload `{optionIds, datasetVersion}`) is private: never shown to dietitians or partners.
- Push body: `{records:[{collection, clientId, updatedAt, deleted, payload}]}` (max 500). Response `{accepted, stale:[{collection,clientId}], serverTime}`.
- Last-write-wins per record by `updatedAt`; ties keep the server copy; a client clock more than 5 min ahead is clamped. Stale means a newer copy exists on the server; the client picks it up on its next pull.
- Pull returns records whose server receipt time is after `since` (so offline pushes from another device are still delivered), max 500 per page: `{records, nextSince, hasMore, serverTime}`. Loop with `since=nextSince` while `hasMore`; for the first call omit `since`. Deleted records come back as tombstones with an empty payload.
- `settings` records: use the setting key as `clientId`.

**Datasets** (onboarding / settings questions; screens render from these, never hard-coded lists)
- `GET /datasets?country=PK&since=ISO`: public; region-filtered options; merges the caller's own custom options when a token is sent. Seeded from `src/data/datasets-seed.json` (31 datasets) by `npm run seed:dev`, insert-only per key so admin edits survive.
- `POST /datasets/:key/options {label}`: auth; adds the caller's own option (`u_xxxxxx`), max 20 per dataset, 40 chars, case-insensitive de-dupe, only where `allowCustom`. A label matching a shared option returns that option.
- Admin: `GET /admin/datasets`, `PUT /admin/datasets/:key` (bumps `version`), `GET /admin/datasets/:key/custom?min=5` (entries typed by >= N users), `POST /admin/datasets/:key/promote {label}`.
- `showIf` rule (`services/datasetLogic.ts`, mirrored in the app): a dataset shows when ANY listed answer is selected in a referenced dataset that is itself visible.

**Subscription (Premium)**: `GET /subscription`, `POST /subscription/google-play/verify {productId, purchaseToken}`. Entitlement lives on the user: `status (none|trialing|active|expired|canceled), plan (monthly|yearly), trialEndsAt, expiresAt, source=google_play`. `requirePremium` reads it from the database on every call.

**Plans**
- `POST /plans/import-ai {text | fileRef}`: Premium only. Calls `AiPlanReader`, returns `{draft, saved:false, requiresReview:true}`; it never saves.
- `POST /plans/check {items, waterTargetMl?, country?, proteinKeywords?, day?}` returns `{verdict: good|tweaks|needs_work, tweaks:[{id,title,detail,suggestion}], good:[]}`. Pure structural checks: meal count (3 to 6), longest gap between meals (5 h), protein keyword at each main meal (every A/B/C option is checked), tea vs iron spacing (30 min), dinner to sleep (2 h), water target (1500 ml). No calories, no nutrition DB. Keywords come from `proteinKeywords`, else default list plus the region pack of `country`.
- `POST /plans`, `GET /plans`, `GET /plans/:id`, `POST /plans/:id/versions` (new version, returns diff).
- Plan items carry a stable `key`; diffs match items, rules and recipes by key/id.

**Marketplace**
- Dietitian: `PUT /dietitians/me`, `POST /dietitians/me/documents {kind, ref}` (references only), `POST /dietitians/me/submit`, `GET /dietitians/me`, `GET /dietitians/me/earnings`.
- Admin review: `GET /admin/dietitians?status=`, `POST /admin/dietitians/:id/review {decision: in_review|approved|rejected, note}`. Government-ID references are flagged for deletion (7 days) on approve/reject; `POST /admin/jobs/purge-flagged-documents` marks them purged.
- Orders: `POST /orders {dietitianId, bandId}`, `GET /orders`, `GET /orders/:id`, then `POST /orders/:id/{pay,start,deliver,release,refund,publish-plan}`. Lifecycle `requested -> paid -> in_progress -> delivered -> released | refunded`. A client refund is allowed only if nothing was delivered `refundWindowHours` (72) after payment; admins can refund any non-final order.
- `POST /orders/:id/publish-plan` (dietitian): creates a new plan version for the client with a diff (added/changed/removed vs previous) and posts a `plan_update` chat card.
- `GET /orders/:id/client-data` (dietitian): the client's plan and logs, serialized without cycle data.
- Chat: `POST/GET /orders/:id/messages` (types `text`, `photo` ref, and server-created `plan_update`).
- Calls: `POST /orders/:id/calls {slotStart, slotEnd}` (client), `GET /orders/:id/calls`, `PATCH /orders/:id/calls/:callId {status: confirmed, joinLink|phone}` (dietitian provides link or phone), `cancelled`, `completed`.
- Pricing at order creation (server side, from `PackageConfig`): follow-up price if the client already has a delivered/released order with that dietitian, else the Premium price if the client is Premium, else full price. Needs the user's `country` (set via `PATCH /me`).

**Partner sharing** (`/partner`)
- Owner: `POST /invites {permissions}` (token shown once, valid 48 h, hashed at rest), `GET /shares`, `PATCH /shares/:id {permissions}`, `DELETE /shares/:id` (revoke), `GET /cheers`.
- Partner: `POST /invites/accept {token}`, `GET /shared-with-me`, `GET /shares/:id/view?date=YYYY-MM-DD`, `POST /shares/:id/cheer` (once per UTC day).
- Permissions: `effortRing, mealsLogged, waterWalk, weight, togetherNudgesOnly`. `togetherNudgesOnly` overrides the rest: the partner then sees only shared nudges.
- The partner view is built from synced records using these conventions (the phone must write them): `metrics {type:'effort', date, ring, streak}`, `metrics {type:'weight', date, kg}`, `logs {kind:'meal'|'water', date, amountMl?}`, `stepDays {date, steps}`, `settings` record with `clientId: "together_nudges"` and `{items: string[]}`.
- Privacy: cycle dates and symptoms are never exposed to dietitians or partners. Views are whitelist serializers (`src/services/serializers.ts`); dietitians additionally never get the `cycleRecords` or `settings` collections, `cycle` plan items, or any key that looks cycle-related. Covered by `tests/privacy.test.ts`.

**Admin** (`/admin`, role admin)
- `GET/PUT /admin/fee-config`
- `GET/POST /admin/packages`, `PUT/DELETE /admin/packages/:id`, `POST /admin/packages/:id/derive-variants`
- `POST /admin/jobs/settle-orders` (auto-refund eligible orders; auto-release delivered orders after `payoutDelayHours`). Run it from Heroku Scheduler (for example hourly with `curl` and an admin token, or move the body into a script).

## Fees and packages configuration

Nothing about money is hardcoded. Two collections, both seeded by `npm run seed` only where missing, then editable through the admin API:

**`FeeConfig`** (one document) with defaults: `playFeePercent 15`, `platformFeePercent 20`, `payoutDelayHours 24`, `refundWindowHours 72`, `premiumDiscountPercent 30`, `followUpDiscountPercent 50`. `PUT /admin/fee-config` accepts any subset. Reads are cached per process for `CONFIG_CACHE_TTL_SECONDS` and the cache is invalidated on every write; other dynos converge within the TTL.

**`PackageConfig`**
- `kind: "dietitian_plan"`: a price band (`bandId`) with variants `full`, `premium`, `followUp`. Each variant has a Google Play `productId` and `prices: [{country, currency, amountMinor}]` (`country: "*"` is a fallback).
- `kind: "premium"`: variants `monthly`, `yearly` (each with `productId` and prices) and `trialDays` (30).
- `POST /admin/packages/:id/derive-variants` recomputes the `premium` and `followUp` prices of a band from its `full` prices using the current discount percentages. Premium and follow-up are just lower price points, so the platform never pays out of pocket.
- Seeded prices are illustrative placeholders. Set real ones, and create the matching products in Play Console.

**Settlement** (`computeSettlement`, `src/services/money.ts`): `net = pricePaid - round(pricePaid * playFee)`, `platform = round(net * platformFee)`, `dietitian = net - platform`. Integer minor units, half-up rounding, never negative, and `playFee + platform + dietitian === pricePaid` exactly. The result and the fee percentages used are snapshotted on the order when it is paid, so later config changes never alter history.

## Deploy to Heroku

```
heroku create saathi-api
heroku stack:set heroku-24              # or the current default
# MongoDB: create an Atlas cluster (via the Atlas dashboard, or an Atlas add-on if your Heroku account offers one)
# and allow Heroku's egress (Atlas network access; a static-IP add-on or 0.0.0.0/0 with strong credentials)
heroku config:set NODE_ENV=production \
  MONGODB_URI='mongodb+srv://USER:PASS@cluster.mongodb.net/saathi' \
  JWT_ACCESS_SECRET=$(openssl rand -hex 32) \
  JWT_REFRESH_SECRET=$(openssl rand -hex 32) \
  OTP_PEPPER=$(openssl rand -hex 32) \
  ADMIN_EMAILS=you@example.com \
  APP_LINK_BASE=https://your-domain
git push heroku main
heroku run npm run seed                  # once; safe to re-run
heroku logs --tail
```

The Node buildpack runs `npm run build`; `Procfile` is `web: node dist/index.js`; `engines.node` is `22.x`; the app listens on `$PORT` and keeps no local-disk state (documents, photos and plan files are references to external object storage).
Until the real mailer is wired in, no one can receive OTP emails in production: see "Stubs".

**AWS later**: same container-friendly process. Config via env (SSM/Secrets Manager), logs to stdout, health check at `GET /health`, `trust proxy` already set for a load balancer, and `settle-orders` can move to EventBridge.

## Stubs and TODOs (all behind interfaces in `src/interfaces`)

| Interface | Stub | Needed for production |
|---|---|---|
| `Mailer` | console (suppresses bodies in production) | real sender (SES/SendGrid/Postmark) |
| `SmsProvider` | console | Twilio/Unifonic/SNS |
| `IdTokenVerifier` (Google, Apple) | accepts `stub:<subject>:<email>` | verify signature/iss/aud/exp against Google and Apple JWKS |
| `PlayBilling` | tokens `stub_valid*`, `stub_trial*` | Play Developer API: subscriptionsv2 / products get, acknowledge, voided purchases/refund |
| `AiPlanReader` | canned `[SAMPLE]` plan, `isSample: true` | Anthropic Messages API: JSON matching `planContentSchema`, validated with zod |

Wire real providers in `src/index.ts` where `createStubServices` is called. In production the stubs (except the console mailer) answer 501 unless `ALLOW_STUB_PROVIDERS=true`.

## Testing

`npm test` runs vitest on pure logic (settlement, plan check, plan diff, OTP state machine, LWW sync rules, order/refund rules, entitlement, pricing, verification flow, privacy serializers, cache, env) plus HTTP wiring tests that need no database. Database-backed paths (Mongoose queries) are typechecked but not exercised here because there is no MongoDB in this environment.

## Deploy to Heroku
Needs the production config to pass `loadEnv` (the app refuses to start otherwise). Heroku runs `npm run build` itself and the `release` process in `Procfile` seeds datasets/packages/regions (insert-only, safe to repeat).

```bash
heroku create saathi-api
heroku config:set \
  NODE_ENV=production \
  MONGODB_URI='<connection string>' \
  JWT_ACCESS_SECRET=$(openssl rand -hex 32) \
  JWT_REFRESH_SECRET=$(openssl rand -hex 32) \
  OTP_PEPPER=$(openssl rand -hex 32) \
  ADMIN_EMAILS=you@example.com \
  RESEND_API_KEY=<key> MAIL_FROM='Saathi <no-reply@yourdomain.com>'
git push heroku main
curl https://saathi-api.herokuapp.com/health
```
- **No mail provider yet?** On a private staging app only, set `LOG_OTP=true` and read sign-in codes with `heroku logs --tail`. Never on a public app.
- Billing, Google/Apple sign-in and AI plan reading stay refused in production until real providers exist (do NOT set `ALLOW_STUB_PROVIDERS=true`: it would let anyone mint Premium with a fake purchase token).
- MongoDB must accept connections from Heroku. Heroku IPs change, so either use Atlas (allow 0.0.0.0/0 with a strong password, or a static-IP add-on), or put a static-IP add-on (Fixie / QuotaGuard Static) in front and allow only that IP.
