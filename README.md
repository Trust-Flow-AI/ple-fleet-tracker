# Pure Light Electric — Fleet Tracker

Automated maintenance and compliance tracking for the company fleet.
Bouncie telematics in, Monday work orders out.

[![CI](https://github.com/Trust-Flow-AI/ple-fleet-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/Trust-Flow-AI/ple-fleet-tracker/actions/workflows/ci.yml)

Every truck schedules its own maintenance. Bouncie reports an odometer reading
each time a truck shuts off, Monday holds the service rulebook, and a Cloudflare
Worker does the arithmetic between them and opens the work order. Nobody has to
remember anything.

**Status:** boards live, code deployable, not yet in production. Runs at about
$1.17/month.

### Where to look

| | |
|---|---|
| **Why it's built this way** | [ARCHITECTURE.md](ARCHITECTURE.md) — read before changing scheduling logic |
| **Standing it up** | [Setup](#setup), below — nine steps, about an hour |
| **Operating it** | [docs/RUNBOOK.md](docs/RUNBOOK.md) — symptom → cause → fix |
| **Bouncie's sharp edges** | [docs/BOUNCIE-API.md](docs/BOUNCIE-API.md) — read before touching their API |
| **Board & column IDs** | [docs/MONDAY-BOARDS.md](docs/MONDAY-BOARDS.md) — read before changing a board |
| **Working on it** | [CONTRIBUTING.md](CONTRIBUTING.md) — house rules, the load-bearing bits |
| **What's in this version** | [CHANGELOG.md](CHANGELOG.md) |

> **Deploying this yourself?** Nothing here is specific to one company. Board
> IDs, your Monday account URL and notification addresses are all deployment
> secrets, so you can clone this, create the three boards, and point it at your
> own fleet. [docs/BOUNCIE-API.md](docs/BOUNCIE-API.md) is worth reading on its
> own if you are building anything against Bouncie — it records a lot of
> behaviour their documentation does not.

### The boards

Three boards do the work: **Vehicles**, **Service Intervals** and
**Maintenance & Renewals**. Their IDs and your Monday account URL are
deployment secrets rather than repo contents, so this repository can be public —
see [Setup](#setup).

---

## The one thing to understand first

**Bouncie has no maintenance API.** Their in-app "Care" reminders exist but are
not exposed to developers — no endpoint, no field, nothing. So the service
schedule cannot live in Bouncie. What Bouncie *does* give us is an authoritative,
unrounded odometer reading on every `tripEnd` webhook, which is all this system
actually needs. The schedule lives in Monday (editable by the office) and the
arithmetic lives in this Worker.

```
                     ┌──────────────────────────────────────┐
   Bouncie device    │  Cloudflare Worker                   │
   in each truck     │                                      │
        │            │   POST /bouncie/webhook              │
        │  tripEnd   │     tripEnd  → odometer → evaluate   │
        ├───────────▶│     mil      → fault-code work order │
        │  mil       │     battery  → battery work order    │
        │  battery   │     connect/disconnect → device state│
        │  connect   │                                      │      ┌──────────────┐
        │            │   cron 6am America/Chicago           │─────▶│ Fleet boards │
   Bouncie REST API  │     sync rules from Monday           │      │  · Vehicles  │
        │            │     sweep every vehicle              │◀─────│  · Intervals │
        └───────────▶│     email the digest                 │      │  · Work Ord. │
        (6-hourly    │                                      │      └──────────────┘
         safety net) │   cron every 6h                      │             │
                     │     poll odometers directly          │             │ status → Done
                     │     re-enable dead webhooks          │             ▼
                     │                                      │   POST /monday/webhook
                     │   D1: odometer, service clocks,      │◀────  resets that service's
                     │       open orders, trips, audit      │       clock from what the
                     └──────────────────────────────────────┘       tech actually entered
```

## The three boards

| Board | What it is | Who edits it |
|---|---|---|
| **Fleet — Vehicles** | One row per truck. Registry details plus live telematics. | Office fills in VIN / IMEI / plate / driver / expiry dates. The odometer, check-engine, battery and device-status columns are written by the Worker — don't type in those. |
| **Fleet — Service Intervals** | The rulebook. 22 services pre-loaded. | Office. Change an interval here and it takes effect on the next sweep — no deploy needed. |
| **Fleet — Maintenance & Renewals** | The working board. Work orders open themselves. | Everyone. Move to Done, fill in cost / vendor / odometer. |

### How a service gets scheduled

Two modes, and which one applies depends on whether **Watches Vehicle Date Column** is filled in on the interval:

- **Recurring** (blank) — due date is *last completion + interval*. Oil, tires,
  brakes, fluids. `Whichever First` means it fires as soon as either the mileage
  or the months are up, which is what you want: the shop truck that drives 1,000
  miles a year still needs its oil changed, and the rough-in van that drives
  24,000 miles needs five changes in the same period.
- **Fixed expiry** (a date column ID) — due date is read straight off the vehicle.
  Tag, insurance, safety inspection. When you renew, update the date on the
  vehicle row and the next one schedules itself.

`Fault Code` rules are never scheduled — they open the instant Bouncie reports a
check-engine light, with the actual DTCs in the work order.

---

## Setup

Nine steps. Budget an hour for the first pass, mostly waiting on Bouncie's portal.

### 1. Bouncie developer app

1. Sign in at **https://www.bouncie.dev/** with your normal Bouncie credentials.
2. Create an application. **You choose the `client_id` string yourself** — it is
   not generated for you. Use `ple-fleet-tracker`.
3. Set the redirect URI to `https://ple-fleet-tracker.<your-subdomain>.workers.dev/oauth/callback`.
   Nothing actually serves that path; it only has to match.
4. Copy the **client secret**.
5. Go to the **Users & Devices** tab → **Authorize My Devices** → Yes.
6. Your account appears in the list. Expand the row and copy the **Authorization Code**.

> That authorization code **never expires**, which is what makes a headless
> integration possible — the Worker re-exchanges it for a fresh access token
> whenever the old one 401s. But **re-running the authorize flow invalidates the
> previous code**. If someone clicks "Authorize My Devices" again six months from
> now, the integration goes dark until you update the secret. Worth writing on a
> sticky note.

### 2. Monday API token

Monday → your avatar → **Developers** → **My Access Tokens** → copy the v2 token.

### 3. Cloudflare D1 + deploy

```bash
cd fleet-tracker
npm install

npx wrangler d1 create ple-fleet
# paste the returned database_id into wrangler.toml

npm run db:init          # creates the tables
npm run deploy
```

### 4. Secrets

```bash
npx wrangler secret put BOUNCIE_CLIENT_ID        # ple-fleet-tracker
npx wrangler secret put BOUNCIE_CLIENT_SECRET
npx wrangler secret put BOUNCIE_REDIRECT_URI
npx wrangler secret put BOUNCIE_AUTH_CODE
npx wrangler secret put BOUNCIE_WEBHOOK_KEY      # invent a long random string
npx wrangler secret put MONDAY_API_TOKEN
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM              # +1512...
npx wrangler secret put ADMIN_KEY                # invent another long random string
```

Generate the two random strings with `openssl rand -hex 32`.

### 5. Register the Bouncie webhook

Either in the portal's Webhooks tab, or via their API:

```bash
curl -X POST https://api.bouncie.dev/v1/webhooks \
  -H "Authorization: $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "PLE Fleet Tracker",
    "url": "https://ple-fleet-tracker.<subdomain>.workers.dev/bouncie/webhook",
    "authKey": "<the BOUNCIE_WEBHOOK_KEY you just set>",
    "events": ["tripStart","tripEnd","tripMetrics","mil","battery","connect","disconnect","vinChange"],
    "active": true
  }'
```

**Do not subscribe to `tripData`.** It streams continuously for the whole
duration of every trip and would be the overwhelming majority of your data
volume, for information the maintenance schedule does not use.

Note the `Authorization` header takes the **raw** token with **no `Bearer `
prefix** — this is Bouncie's most common gotcha and it 401s silently if you add it.

### 6. Monday webhook — closing the loop

On **Fleet — Maintenance & Renewals** → Integrate → Webhooks → add:

- URL: `https://ple-fleet-tracker.<subdomain>.workers.dev/monday/webhook?key=<ADMIN_KEY>`
- Event: **When a column changes** → **Work Order Status**

Monday sends a challenge to verify the URL; the Worker answers it automatically.
This is what resets the service clock when someone marks a job Done.

### 7. Email + SMS

- **Resend** (https://resend.com) — verify your own domain as a sending
  domain, then create an API key. Free tier is 3,000 emails/month, far more than
  this needs. Set `MAIL_FROM` to an address on the verified domain.
- **Twilio** — buy a number, grab the SID and auth token. Roughly $1/month plus
  ~$0.008 per text. By default SMS goes out only for `Critical — Do Not Drive`;
  widen it with the `SMS_PRIORITIES` var if you want more.

Both are optional. Leave the secrets unset and the Worker logs a warning and
carries on — Monday assignments and notifications still work.

### 8. Fill in the Vehicles board

One row per truck. The fields that matter:

- **Bouncie IMEI** — 15 digits, from the device. **This is the join key.** Get it
  wrong or leave it blank and that truck receives no telematics at all.
- **Status** — `Active`. Anything marked `Sold` or `Out of Service` is skipped.
- **Assigned Driver** and **Driver Phone** — who gets the work order and the text.
- **Tag Expires / Insurance Expires / Annual Inspection Due** — from the paperwork.

Then:

```bash
curl -X POST "https://ple-fleet-tracker.<subdomain>.workers.dev/admin/sweep?key=$ADMIN_KEY"
```

### 9. Baseline the service clocks — don't skip this

On first sync, every vehicle gets a service baseline of "as of right now." That
keeps the board from exploding into 20 work orders per truck on day one, but it
also means the first oil change is scheduled 5,000 miles from today regardless of
when it was actually last done.

For anything you have records for, correct it:

```bash
curl -X POST "https://.../admin/baseline?key=$ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"imei":"<15-digit IMEI>","intervalId":"<rule item id>","odometer":66100,"date":"2026-06-14"}'
```

`intervalId` is the Monday item ID of the rule on the Service Intervals board —
open the item and it is the last number in the URL. `imei` is from the vehicle's
Bouncie IMEI column.

The lazy alternative that also works: open a work order manually, set it to Done
with the real last-service odometer and date, and the clock resets from that.

### Verify

```bash
curl "https://.../admin/verify?key=$ADMIN_KEY"
```

Confirms every column this code expects still exists, reports how many vehicles
and rules are loaded, and lists your Bouncie webhooks with their active state.
Run it after any board surgery.

---

## Day to day

Nobody has to do anything for the system to work. What people *do*:

- **A work order appears** — assigned to the driver, in Overdue or Due Soon,
  with an explanation of why in the item's updates.
- **Schedule it** — set *Scheduled For*, move to Scheduled, then In Shop.
- **Close it out** — set status to **Done**, fill in **Completed Date**,
  **Odometer at Service**, **Cost**, **Vendor**, attach the receipt. The clock
  resets from what you entered. Leave the odometer blank and it uses the live
  Bouncie reading and says so in the updates.
- **Skip one** — status **Skipped**. Resets the clock without recording a service,
  so it re-arms for next interval instead of nagging.
- **6am every morning** — digest email: everything overdue, everything coming due.
  Silent "all clear" email when there's nothing, so you know it's alive.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No odometer updates on any truck | Bouncie deactivated the webhook. This happens spontaneously and is well documented by other developers. | The 6-hourly cron detects and re-enables it, and emails you. To check now: `GET /admin/verify`. |
| One truck never updates | IMEI mismatch. | `GET /admin/verify` reports unmatched vehicles; fix the IMEI on the Monday row. |
| Everything 401s after months of working | Someone re-ran "Authorize My Devices" in the Bouncie portal, invalidating the stored auth code. | Copy the new code, `wrangler secret put BOUNCIE_AUTH_CODE`. |
| A service opened way too early | Its baseline is "as of first sync," not the real last service. | `POST /admin/baseline` with the real numbers. |
| Duplicate work orders | Shouldn't happen — a partial unique index on `(imei, interval_id) WHERE state='open'` prevents it, and the D1 claim is written *before* the Monday item is created. | If you see one, check `GET /admin/audit`. |
| Odometer went backwards | Bouncie delivers webhooks out of order. | Handled: `applyOdometer` ignores any reading below the stored one and logs it to the audit table. |
| Work order didn't reset the clock | The Monday webhook isn't firing. | Re-add it on the board; confirm the `?key=` matches `ADMIN_KEY`. |

`GET /admin/audit?key=...` is the first place to look for anything unexplained —
every work order, sweep, odometer anomaly and VIN change is logged there.

## Running cost

| | |
|---|---|
| Cloudflare Workers + D1 | $0 — nowhere near the free tier limits |
| Resend | $0 — ~35 emails/month against a 3,000 free tier |
| Twilio | ~$1.15/month — number rental plus a handful of texts |
| **Total** | **~$1.15/month** |

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # 31 tests over the due engine and notifications
npm run dev         # local wrangler
npm run tail        # live production logs
```

The due engine (`src/engine.ts`) is deliberately pure — no database, no network,
no clock of its own. Everything it needs is passed in, which is why the whole
schedule is unit-testable and why "why did this open?" is answerable without
replaying a webhook.

## Things worth knowing about the Bouncie API

Learned the hard way; all of these are handled in the code but will confuse you
if you go poking at the API yourself.

- `Authorization` takes the **raw token, no `Bearer ` prefix**.
- `startOdometer` is rounded to the whole mile, `endOdometer` is not. **Never
  derive distance by differencing odometer readings across trips** — the seams
  disagree. Use the per-trip `distance` field.
- Trip queries are capped at a **1-week window**, and the earliest supported date
  is 2020-05-21.
- `gps-format` is documented as optional but is **actually required** — omitting
  it returns a 400.
- Everything under `stats` is routinely missing (`mil`, `battery`, `location`,
  `fuelLevel`, `nickName`), and `location` sometimes comes back as a bare address
  string instead of an object.
- Field names differ between the webhook and REST representations of the same
  data: `hardBrakingCounts` vs `hardBrakingCount`, `totalIdlingTime` vs
  `totalIdleDuration`, `value`+`codes` vs `milOn`+`qualifiedDtcList`.
- `tripStart` / `tripEnd` carry **no GPS coordinates**. Webhook-as-trigger, then
  call the REST API — that's the intended architecture.
- A **4xx response from you triggers retries**, so always return 200 on receipt
  and process asynchronously. Which is what the Worker does.
- Webhook auth is a **shared secret echoed in a header**, not an HMAC signature.
  It arrives in both `Authorization` and `X-Bouncie-Authorization`.
- Rate limits exist but are undocumented. Nothing here comes close.

## License

MIT — see [LICENSE](LICENSE).
