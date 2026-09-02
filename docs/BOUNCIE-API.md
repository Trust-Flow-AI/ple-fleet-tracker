# Bouncie API — field notes

Bouncie's own documentation is a JavaScript single-page app at
[docs.bouncie.dev](https://docs.bouncie.dev/); the machine-readable spec behind
it is at `https://docs.bouncie.dev/openapi.json`.

This file records what we actually verified, and — importantly — what we could
**not** confirm. Everything marked *unconfirmed* should be treated as a guess
until someone tests it.

---

## 1. Endpoints and hosts

Note the split between hosts. This trips people up.

| Purpose | URL |
|---|---|
| Authorize (browser) | `https://auth.bouncie.com/dialog/authorize` |
| Token exchange | `https://auth.bouncie.com/oauth/token` |
| API base | `https://api.bouncie.dev/v1` |
| Developer portal | `https://www.bouncie.dev/` (Keycloak SSO, your normal bouncie.com login) |

| Method | Path | Query params |
|---|---|---|
| GET | `/user` | — |
| GET | `/vehicles` | `vin`, `imei`, `limit`, `skip` |
| GET | `/trips` | `imei`, `transaction-id`, `gps-format`, `starts-after`, `ends-before` |
| GET / POST | `/webhooks` | POST body: `name`, `url`, `authKey`, `events`, `active?` |
| PUT / DELETE | `/webhooks/{id}` | — |
| GET / POST | `/application-geozones/` | `imei`, `locationId`, `scheduleId` |
| GET / POST | `/locations/` | `name`, `id` |
| GET / POST | `/schedules/` | `name`, `id` |

Geo-zones, locations and schedules look like a newer addition — no open-source
client knows about them. We don't use any of them.

---

## 2. Authentication

### The header gotcha

```
Authorization: <access_token>        ← RAW TOKEN, NO "Bearer " PREFIX
Content-Type: application/json
```

The spec says verbatim: *"Make sure to only include the access token and **not**
the 'Bearer' prefix."* This is the single most common first-attempt failure, and
it fails as a 401 with no explanation. There is no `x-api-key` anywhere, and
**no OAuth scopes exist** — sending one breaks the request.

### How the headless integration works

There is **no `client_credentials` grant**. What there is instead, per the spec:

> "An authorization code that can be exchanged for an access token. **There is
> no expiration for the authorization code**, however if the user goes through
> the authorization flow for your application again and a new authorization code
> is generated, the old authorization code will no longer be valid."

So the pattern — which every open-source Bouncie client uses — is: store the
non-expiring authorization code, and re-exchange it for a fresh access token
whenever you get a 401. That is what `src/bouncie.ts` does.

For your own vehicles you never need the browser flow at all:

1. Portal → **Users & Devices** tab → **Authorize My Devices** → Yes
2. Your account appears in the list; expand the row
3. Copy the **Authorization Code**

`client_id` + `client_secret` + `redirect_uri` + that code = a working headless
integration. Note **you choose the `client_id` string yourself** in the portal;
it is not generated for you.

> ⚠️ **The trap.** Re-running the authorize flow invalidates the previous code.
> If someone clicks "Authorize My Devices" again six months from now, the
> integration goes dark until `BOUNCIE_AUTH_CODE` is updated. The error surfaces
> as a 400 on token exchange, and `bouncie.ts` says so explicitly in the thrown
> message.

### Token exchange

`POST https://auth.bouncie.com/oauth/token`, form-encoded:

```
client_id=...&client_secret=...&grant_type=authorization_code
&code=...&redirect_uri=...
```

`redirect_uri` is validation-only here. Response: `access_token`,
`refresh_token`, `expires_in`, `token_type`.

**Unconfirmed:** whether `refresh_token` is actually returned in practice. The
spec documents it and a `grant_type=refresh_token` flow, but no open-source
client uses it — all three we examined re-POST the authorization code instead.
**Unconfirmed:** the access token lifetime. The spec never states a value. Read
`expires_in`; we keep a 5-minute safety margin and fall back to 45 minutes if
the field is absent.

---

## 3. `GET /vehicles`

Returns a **JSON array** even when filtering to one `imei`.

```json
[{
  "model": { "make": "TOYOTA", "name": "PRIUS", "year": 2007 },
  "standardEngine": "1.5L I4",
  "vin": "2GKALMEK8C6225392",
  "imei": "353762078072777",   // from the public ha-bouncie fixtures
  "nickName": "my prius",
  "stats": {
    "localTimeZone": "-0500",
    "lastUpdated": "2022-11-23T01:53:57.000Z",
    "odometer": 120508.63004550002,
    "location": { "lat": 40.64, "lon": -73.99, "heading": 146, "address": "1011 45th St, Brooklyn, NY" },
    "fuelLevel": 29.411764705882355,
    "isRunning": false,
    "speed": 123.2446465,
    "mil": { "milOn": false, "lastUpdated": "2022-11-23T01:38:55.000Z" },
    "battery": { "status": "normal", "lastUpdated": "2022-11-23T01:37:41.000Z" }
  }
}]
```

Field notes:

- `model.name` is the model — **not** `model.model`.
- `nickName` (capital N) is **often absent**. Synthesize `{year} {make} {name}`.
- `stats.localTimeZone` is a UTC **offset** (`"-0500"`), not an IANA name — so
  no DST information. All timestamps are UTC.
- `stats.fuelLevel` is a percent, unrounded. `speed` is MPH.

### Defensive coding is mandatory here

`stats.mil`, `stats.battery`, `stats.location`, `stats.fuelLevel` and `nickName`
are **all routinely missing** from real responses. And `stats.location`
sometimes arrives as a **bare address string** instead of an object:

```json
"location": "123 Main St, Dallas, Texas 75251, United States"
```

Treat the whole `stats` subtree as optional. `readOdometer()` and
`readDtcCodes()` in `src/bouncie.ts` exist for exactly this reason.

### MIL / DTC shape

```json
"mil": {
  "milOn": true,
  "qualifiedDtcList": [
    { "code": "P0A80", "name": ["Replace hybrid battery pack", "Call Toyota"] },
    { "code": "P0666" }
  ]
}
```

`name` is an **array** of descriptions, and **can be absent entirely** on a
code. `dtcCount` / `dtcDetails` are not API fields.

---

## 4. Odometer and mileage

`stats.odometer` is a real running odometer, in **miles** (units not stated in
the spec; confirmed against client implementations). Trips also carry
`startOdometer` / `endOdometer`.

Three precision gotchas, empirically verified and **undocumented upstream**:

1. **`startOdometer` is rounded to the nearest whole mile; `endOdometer` is
   not.** A trip ending at `28062.2` is followed by one starting at `28062`.
   **Never derive distance by differencing odometer readings across trips** —
   the seams disagree. Use the per-trip `distance` field.
2. `stats.odometer` is a long float (`120508.63004550002`), consistent with an
   internally summed and unit-converted value rather than a raw OBD read.
3. `maxSpeed` is quantized to whole km/h upstream, so `62.137100000000004` is a
   conversion artifact, not precision. Round before display.

**Unconfirmed:** the `stats.odometer` refresh cadence, and whether it updates
mid-trip. Empirically it refreshes at least per-trip. **We use
`tripEnd.odometer` as the authoritative value** — it fires once per trip with a
fresh unrounded reading, which is exactly what the schedule needs.

### Trip query constraints

- `starts-after` → `ends-before` window must be **≤ 1 week**.
- Earliest supported date is **2020-05-21**.
- `imei` is effectively required; VIN is not accepted.
- **`gps-format` is documented as optional but is actually required** — omitting
  it returns `400 gpsFormat is a required field`. There is no way to suppress
  GPS, so you fetch ~10× the payload and discard it.
- GPS is ~90% of payload size. Trip records contain **no lat/lon fields** —
  position exists only inside the encoded `gps` string.
- In-progress trips return partial records: no `endTime`, `distance`,
  `averageSpeed`, `maxSpeed` or `fuelConsumed`, and `endOdometer: null`.
- Zero-distance trips are real idle events — `distance: 0` with nonzero
  `fuelConsumed` and a large `totalIdleDuration`.
- `transactionId` is the correct dedupe key across overlapping windows.

**Unconfirmed:** whether trip query params are canonically kebab-case or
camelCase. The spec documents kebab (`gps-format`); one client sends camel
(`gpsFormat`) and reports a server error message in camelCase, implying the
validator accepts both. We use kebab per the spec.

---

## 5. Webhooks

### Event types

11 exist. Note the `eventType` **value** differs from the doc's path name for
the two device events, and the payload key differs again.

| `eventType` | Payload key | Used here |
|---|---|---|
| `connect` | `connect` | ✅ |
| `disconnect` | `disconnect` | ✅ |
| `battery` | `battery` | ✅ |
| `mil` | `mil` | ✅ |
| `vinChange` | `vinChange` | ✅ (audit only) |
| `tripStart` | `start` | ✅ (liveness only) |
| `tripEnd` | `end` | ✅ **the important one** |
| `tripMetrics` | `metrics` | ✅ |
| `tripData` | `data` (array) | ❌ **deliberately not subscribed** |
| `applicationGeozone` | `geozone` | ❌ |
| `userGeozone` | `geozone` | ❌ |

Every payload has `{ eventType, imei, vin }`; trip and geozone events add
`transactionId`.

```json
{ "eventType": "tripEnd", "imei": "...", "vin": "...", "transactionId": "...",
  "end": { "timestamp": "...", "timeZone": "-0500", "odometer": 12014, "fuelConsumed": 0.2 } }

{ "eventType": "mil", "imei": "...", "vin": "...",
  "mil": { "timestamp": "...", "value": "ON", "codes": "P0420" } }

{ "eventType": "battery", "imei": "...", "vin": "...",
  "battery": { "timestamp": "...", "value": "normal" } }
```

### Field-name drift between webhook and REST

Same data, different names. An easy source of bugs:

| Concept | Webhook | REST |
|---|---|---|
| Check engine | `mil.value` (`"ON"`), `mil.codes` (string) | `mil.milOn` (bool), `mil.qualifiedDtcList` (array) |
| Hard braking | `hardBrakingCounts` | `hardBrakingCount` |
| Idle time | `metrics.totalIdlingTime` | `totalIdleDuration` |
| Coordinates | `latitude`/`longitude` on connect/disconnect; `lat`/`lon` on tripData | — |

**`tripStart` / `tripEnd` carry no GPS coordinates** — only timestamp, timeZone,
odometer and fuel. Bouncie's own guidance is to *"use the webhook as a trigger
to call the API and retrieve the rest of the data."* That's the intended
architecture.

### Verification: shared secret, not a signature

You supply `authKey` at registration. Bouncie sends it back on every delivery in
**two headers** — `Authorization` **and** `X-Bouncie-Authorization` (duplicated
because some platforms strip or consume `Authorization`).

There is **no HMAC scheme** — no timestamp, no body digest. So compare in
constant time and rely on HTTPS. `verifyWebhookAuth()` checks both headers.

Unusual bonus: key rotation is **receiver-driven** — a consumer can change its
key by returning a new one in an `Authorization` *response* header.

### Retries and auto-deactivation

> "Bouncie will attempt to retry a webhook Request if it times out, responds
> with invalid JSON, or responds with a 4xx or 5xx level status code. A backoff
> policy will be used."

**A 4xx from you triggers retries.** Always return 200 on receipt and process
asynchronously — otherwise a slow downstream call becomes a retry storm. One
community report puts retries at exponential delay up to ~11 hours.

Persistently failing webhooks are **automatically deactivated**. Community
reports put the threshold at a 0.95 failure rate over ≥100 messages in 4 hours
(*not official*), and multiple developers report webhooks "randomly becoming
disabled every few days" with no visible errors. **This is why
`checkWebhookHealth()` exists** and runs every 6 hours.

**Confirmed limit:** max 100 webhooks per application. The "one URL per app"
belief is false.

**Unconfirmed:** timeout seconds, retry count, exact backoff formula, and the
official deactivation threshold.

---

## 6. Rate limits

**Not documented anywhere** — no mention of rate limits, throttling, quotas or
429 in the spec. But they exist: one client treats 429 as retryable and
serializes trip calls with a 250 ms delay, noting *"Bouncie rate-limits, and a
long range fans out into many windows."*

No published numbers. Discover empirically and back off exponentially on 429 and
5xx. Nothing in this project comes close to any plausible limit.

**There is no sandbox or test environment.** You test against live data on your
own devices.

---

## 7. Maintenance features

**Native: yes. Exposed via API: no.**

Bouncie Care / Care Plans let you build a Service Library of recurring or
one-time maintenance items scheduled by mileage interval, time interval, or
both, with configurable lead time. The app shows a care timeline with the date
and mileage of the next event, and you can log completed service manually.

None of it is in the API. We searched the OpenAPI document for
`maintenance`, `reminder`, `care` and `service`: **zero references**. No
`/care`, no `/maintenance`, no `/service` path, nothing maintenance-related on
the vehicle object. No open-source client references it either.

**This is the reason this project exists.** See
[ARCHITECTURE.md](../ARCHITECTURE.md).

---

## 8. Gotcha checklist

Ranked by how likely each is to bite you:

1. `Authorization` takes the **raw token, no `Bearer ` prefix**.
2. Odometer seams don't line up — never difference odometers for distance.
3. 1-week cap on trip queries; earliest date 2020-05-21.
4. `gps-format` is required despite being documented optional.
5. `stats` subtree fields are frequently absent; `location` is sometimes a string.
6. Field-name drift between webhook and REST representations.
7. `tripStart`/`tripEnd` have no coordinates.
8. Webhook delivery is **out of order and delayed**; retries mean you must be
   idempotent on `transactionId` + `eventType` + `timestamp`.
9. Webhooks **silently self-deactivate**. Poll `GET /v1/webhooks` for `active: false`.
10. `tripData` is a firehose — Bouncie's own advice is to buffer it through a queue.
11. `localTimeZone` / `timeZone` are offsets, not IANA names.
12. One community report says the address field started returning Google Plus
    Codes instead of human-readable addresses in some cases.
13. Developer support is slow — multiple reports of contact-form silence for months.
14. Re-running the authorize flow silently invalidates the previous auth code.

---

## Sources

- `https://docs.bouncie.dev/` and **`https://docs.bouncie.dev/openapi.json`** (primary)
- `https://www.bouncie.dev/` (portal)
- [mandarons/ha-bouncie](https://github.com/mandarons/ha-bouncie) — Home Assistant integration; real response fixtures
- [mandarons/bounciepy](https://github.com/mandarons/bounciepy) — Python client
- [streetsmartslabs/bouncie](https://github.com/streetsmartslabs/bouncie) — Ruby client
- [digitalhen/bouncie-mcp](https://github.com/digitalhen/bouncie-mcp) — richest source of empirically-verified quirks
- [Vehicle Analytics with Bouncie Webhooks](https://mcconnellweb.com/posts/bouncie-webhook-analytics/)
- [community.bouncie.com](https://community.bouncie.com/) — API questions, Dev API, Developer API threads
- [Vehicle Care notifications](https://help.bouncie.com/en/articles/8809521-vehicle-care-notifications)
