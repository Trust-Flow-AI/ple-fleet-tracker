# Runbook

Operating the fleet tracker. Written for whoever is on the hook when something
looks wrong — including future us.

## Is it alive?

Three signals, cheapest first:

1. **The 6am digest arrived.** It sends even when nothing is due ("Fleet: all
   clear"), specifically so that silence means broken rather than fine. No email
   by 7am Central is the first symptom of anything.
2. **Odometer Updated on Fleet — Vehicles is recent.** Any truck that drove
   yesterday should show yesterday or today. All trucks stale at once = webhook
   problem. One truck stale = that device.
3. **`GET /admin/verify`** — the full picture.

```bash
export W=https://ple-fleet-tracker.<subdomain>.workers.dev
export ADMIN_KEY=...   # from your password manager, not from here

curl -s "$W/admin/verify?key=$ADMIN_KEY" | jq
```

Returns: missing columns (should be `[]`), vehicle / active-rule / open-order /
service-clock counts, and every Bouncie webhook with its `active` flag.

## Admin endpoints

All require `?key=$ADMIN_KEY`.

| Endpoint | Method | What it does |
|---|---|---|
| `/health` | GET | Liveness. No auth needed |
| `/admin/verify` | GET | Schema + data + webhook health |
| `/admin/audit` | GET | Last 100 decisions, newest first |
| `/admin/sweep` | POST | Force a full sweep now |
| `/admin/digest` | POST | Send the digest now |
| `/admin/baseline` | POST | Set a service's real last-completion |

```bash
# Force a sweep (safe to run any time; idempotent)
curl -X POST "$W/admin/sweep?key=$ADMIN_KEY"

# What has the system been deciding?
curl -s "$W/admin/audit?key=$ADMIN_KEY" | jq -r '.[] | "\(.at)  \(.kind)  \(.detail)"'

# Correct a service clock
curl -X POST "$W/admin/baseline?key=$ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"imei":"<15-digit IMEI>","intervalId":"<rule item id>","odometer":66100,"date":"2026-06-14"}'
```

`intervalId` is the rule's Monday item ID; see
[MONDAY-BOARDS.md](MONDAY-BOARDS.md#pre-loaded-rules) for how to list them.

## Live logs

```bash
npx wrangler tail                              # everything
npx wrangler tail --status error               # errors only
npx wrangler tail --search "Bouncie"           # one subsystem
```

## Symptom → cause → fix

### No odometer updates on *any* truck

**Almost always a deactivated Bouncie webhook.** Bouncie does this
spontaneously; it is well documented by other developers and gives no warning.

```bash
curl -s "$W/admin/verify?key=$ADMIN_KEY" | jq '.bouncieWebhooks'
```

The 6-hourly cron detects and re-enables this automatically and emails you, so
usually you'll hear about it before you notice. To force it now, run
`/admin/sweep` — or just wait for the next 6-hourly firing, since that cron also
polls odometers directly and nothing is actually missed while the webhook is
down.

If `bouncieWebhooks` reports "could not reach Bouncie", it's an auth problem —
see below.

### One truck never updates

IMEI mismatch. `/admin/verify` lists unmatched vehicles by name with the reason.
Fix the **Bouncie IMEI** on that Monday row (15 digits, no spaces) and run
`/admin/sweep`.

If the IMEI is right and it still doesn't match, the device may have been moved
to a different vehicle — check `/admin/audit` for a `vin_change` entry.

### Everything 401s after months of working fine

Someone re-ran **Authorize My Devices** in the Bouncie portal, which
invalidates the previously issued authorization code. The thrown error says so
explicitly.

```bash
# Copy the new code from the portal's Users & Devices tab, then:
npx wrangler secret put BOUNCIE_AUTH_CODE
```

No redeploy needed; secrets take effect immediately.

### A service opened way too early

Its baseline is "as of first sync," not the real last service. Correct it with
`/admin/baseline`, or open a work order manually and mark it Done with the real
odometer and date — both reset the clock identically.

### A service never opens

Check, in order:

1. Is the rule's **Active** checkbox ticked?
2. Is **Applies To** empty (= all vehicles), or does it actually list this truck?
3. Is the vehicle's **Status** `Active` or `In Shop`? `Sold` and
   `Out of Service` are skipped entirely.
4. For a compliance rule — is there a date in the vehicle's expiry column? No
   date means no work order, deliberately, rather than a guessed one.
5. `/admin/audit` will show `work_order_opened` entries with the reason.

### Duplicate work orders

Shouldn't be possible — a partial unique index plus claim-before-create
prevents it. If you see one, it's a bug worth an issue. Include the
`/admin/audit` output.

### Marking Done didn't reset the clock

The Monday webhook isn't firing. Re-add it on the Maintenance & Renewals board
(Integrate → Webhooks → when a column changes → Work Order Status), and confirm
the `?key=` in the URL matches `ADMIN_KEY`.

Monday sends a challenge when you save the webhook; the Worker answers it
automatically, so if it saves successfully the URL is reachable.

### Odometer looks wrong / went backwards

Bouncie delivers webhooks out of order; readings below the stored value are
rejected and logged as `odometer_out_of_order`. If the *stored* value is wrong,
the 6-hourly poll will correct it from `GET /v1/vehicles` — or force it with
`/admin/sweep`.

Remember `startOdometer` is rounded and `endOdometer` isn't; we only ever use
`tripEnd`. See [BOUNCIE-API.md](BOUNCIE-API.md#4-odometer-and-mileage).

### Emails not arriving

```bash
npx wrangler tail --search "Resend"
```

- `RESEND_API_KEY is not set` → set the secret.
- Resend 403 → the sending domain isn't verified, or `MAIL_FROM` isn't on it.
- Nothing at all in the logs → the cron didn't fire at the digest hour. Check
  `TIMEZONE` and `DIGEST_HOUR` vars, and that both crons are still in
  `wrangler.toml`.

### SMS not arriving

```bash
npx wrangler tail --search "Twilio"
```

- `Twilio credentials are not set` → set the three secrets.
- `could not normalize phone` → the Driver Phone column has something
  unparseable. 10 digits, or 11 starting with 1, or full E.164.
- Nothing at all → the priority didn't match `SMS_PRIORITIES`. By default only
  `Critical — Do Not Drive` texts.

## Routine changes

**Retune an interval** — edit it on the Service Intervals board. Live on the
next sweep; no deploy. Open orders are untouched.

**Pause a rule** — untick **Active**. History is kept.

**Restrict a rule to some trucks** — link them in **Applies To**. Empty means
all.

**Add a vehicle** — new row on Fleet — Vehicles with IMEI, status, driver,
expiry dates. Run `/admin/sweep`. Then baseline its clocks
([step 9 in the README](../README.md#9-baseline-the-service-clocks--dont-skip-this)).

**Retire a vehicle** — set Status to `Sold` or `Out of Service`. It stops being
evaluated; its history stays on the board.

**Change who gets the digest** — `DIGEST_TO` / `ALERT_TO` in `wrangler.toml`,
then redeploy. Comma-separated addresses work.

## Escalation

If the system is down and trucks need servicing in the meantime: the
**Service History** group on the work order board has every completed service
with its odometer, so intervals can be worked out by hand from the
[interval table](MONDAY-BOARDS.md#pre-loaded-rules) and the current dash reading.

Nothing here is load-bearing for safety — it schedules maintenance, it doesn't
prevent anything. A day of downtime costs nothing.
