# Architecture

Why this system is shaped the way it is. Read this before changing the
scheduling logic — most of the non-obvious decisions here are load-bearing.

## The constraint that shapes everything

**Bouncie has no maintenance API.**

Their app *does* have maintenance reminders — "Bouncie Care" — schedulable by
mileage or time. None of it is exposed to developers. There is no endpoint, no
field on the vehicle object, nothing. We searched their entire OpenAPI document
for `maintenance`, `reminder`, `care` and `service` and found zero references.

So the service schedule cannot live in Bouncie, and any design that assumes
otherwise falls over immediately.

What Bouncie *does* give us is better suited to the job anyway: an
authoritative, unrounded odometer reading delivered on every `tripEnd` webhook,
plus fault codes and battery health as they happen. That is the entire input
this system needs.

The resulting split:

| Concern | Owner | Why |
|---|---|---|
| **What** should happen | Monday (Service Intervals board) | The office needs to retune intervals without a deploy |
| **When** it happens | Bouncie (odometer + events) | Only the truck knows how far it has been driven |
| **Whether it happened** | Monday (work order → Done) | A human has to confirm; telematics cannot |
| The arithmetic between them | Cloudflare Worker | Stateless, free, and nobody has to run a server |

Neither vendor has to know about the other's internals, and either can be
replaced without rewriting the other half.

## Data flow

```
   Bouncie device                  Cloudflare Worker                 Monday
   (one per truck)
        │
        │  tripEnd ─────────────▶  POST /bouncie/webhook
        │  mil                      │  verify shared secret
        │  battery                  │  return 200 immediately
        │  connect/disconnect       │  process in waitUntil
        │                           │      │
        │                           │      ├─ odometer → D1
        │                           │      ├─ evaluate every rule ──▶ create work order
        │                           │      └─ fault code → alert ───▶ email + SMS
        │                           │
        │  ◀──────────────────────  │  cron 0 */6 * * *
        │     GET /v1/vehicles      │    poll odometers (backstop)
        │     GET /v1/webhooks      │    revive deactivated webhooks
        │                           │
                                    │  cron 0 11,12 * * *
                                    │    sync rules ◀──────────────── read Service Intervals
                                    │    sweep fleet
                                    │    email the 6am digest
                                    │
                                    │  POST /monday/webhook ◀──────── status → Done
                                    │    reset that service's clock
```

### The loop most fleet systems leave out

The `Done → reset the clock` path is the one that matters most and is the
easiest to skip. Without it, completing a job does not reschedule the next one:
the board slowly fills with stale orders, people stop trusting it, and the
system is worse than a spreadsheet because it *looks* authoritative.

The clock resets from **what the tech actually wrote down** (Odometer at
Service, Completed Date), falling back to the live Bouncie reading only when
those are blank — and when it falls back, it says so in the item's updates so
nobody is misled about where the number came from.

## Module layout

| File | Responsibility | Notes |
|---|---|---|
| `src/engine.ts` | The due-date decision | **Pure.** No DB, no network, no clock. Everything passed in. |
| `src/sync.ts` | Orchestration | The only place that touches D1, Monday and Bouncie together |
| `src/bouncie.ts` | Bouncie client + webhook types | Token minting, retry-on-401, payload verification |
| `src/monday.ts` | Monday GraphQL client | Column readers/writers, pagination |
| `src/notify.ts` | Email + SMS | Every function swallows its own errors by design |
| `src/config.ts` | Board and column IDs, env shape | The one file that changes if a board is rebuilt |
| `src/index.ts` | Router + cron dispatch | Thin; all logic delegated |

### Why the engine is pure

`evaluate(vehicle, rule, state, today)` takes four plain objects and returns a
verdict. It has no dependencies, so:

- The whole schedule is unit-testable without mocking a database or a webhook.
- "Why did this open?" is answerable by calling one function, not by replaying
  production traffic.
- Changing an interval's semantics is a change in one place with tests around it.

If you find yourself wanting to pass `env` into `engine.ts`, that is the signal
the logic belongs in `sync.ts` instead.

## Two scheduling modes

Which mode applies is decided by one field on the interval:
**Watches Vehicle Date Column**.

### Mode A — recurring (that field is blank)

```
due_odo  = last_done_odo + interval_miles
due_date = last_done_at  + interval_months
open when either is inside its warn window
```

Oil, tires, brakes, fluids, inspections. `Whichever First` is the default and
is doing real work in both directions:

- The rough-in van at 24,000 miles in 8 months earns **five** oil changes.
- The shop truck at 1,038 miles in the same period still earns **one**, on the
  6-month side, because oil degrades sitting still.

A pure-mileage schedule neglects the second truck. A pure-calendar schedule
destroys the first. This is the central argument for the whole system.

### Mode B — fixed expiry (that field holds a column ID)

```
due_date = vehicle.<that date column>
open when days_remaining <= warn_days
```

Tag, insurance, annual inspection. These have a real date on a real document;
inventing an interval for them would be wrong. Renew it, update the date on the
vehicle row, and the next one schedules itself.

**Keeping these two modes genuinely separate is what prevents double-booking.**
If tag renewal were both a date-column rule *and* a 12-month interval, it would
open twice. `evaluate()` returns early for Mode B and never consults the
interval arithmetic.

### The third case — not scheduled at all

`Fault Code` rules are never evaluated by the sweep. They fire from the `mil`
webhook, which is the one situation where waiting until 6am is the wrong answer.

## Idempotency and duplicate prevention

Bouncie retries any webhook it does not get a 2xx for, and delivers events out
of order. Three defences:

1. **`seen_events` table.** Every event gets a key of
   `eventType|imei|transactionId|timestamp`. The insert is the dedupe — a
   duplicate throws on the primary key and we return early.

2. **Partial unique index.**
   ```sql
   CREATE UNIQUE INDEX uq_open_wo
     ON work_orders(imei, interval_id) WHERE state = 'open';
   ```
   At most one *open* order per vehicle per service, enforced by the database
   rather than by a check-then-act race.

3. **Claim before create.** `openWorkOrder` writes a `pending:` row to D1
   *before* calling Monday. A duplicate loses the race at the index and creates
   nothing in Monday. If the Monday call then fails, the claim is deleted so the
   next sweep retries rather than going silently quiet.

That ordering is deliberate and easy to break. If you refactor
`openWorkOrder`, keep the claim first.

## Failure modes and how they are handled

| Failure | Cause | Handling |
|---|---|---|
| Webhook silently deactivates | Bouncie does this spontaneously; widely reported | 6-hourly cron checks `active`, re-enables, emails. Same cron polls odometers so nothing is missed meanwhile |
| Duplicate work orders | Webhook retries | Partial unique index + claim-before-create |
| Odometer goes backwards | Out-of-order delivery | Readings below the stored value are rejected and audited |
| Retry storm | A 4xx/5xx from us makes Bouncie retry | Webhook returns 200 on receipt, work happens in `waitUntil` |
| 20 orders on a new truck's first day | No service history, so everything looks overdue | New vehicles baselined at current odometer; `/admin/baseline` sets real figures |
| Auth expires | No usable refresh token, no client_credentials grant | Non-expiring portal auth code, re-exchanged on any 401 |
| Missing response fields | Bouncie routinely omits `mil`, `battery`, `location`, `nickName` | Every field read through a guard |
| "Why did this open?" | Perennial automation question | Reason written into the work order's updates; every decision in an append-only `audit` table |

## Deliberate non-goals

- **No `tripData` subscription.** It streams continuously for the whole duration
  of every trip and would be the overwhelming majority of data volume, for
  information the schedule never reads.
- **No GPS / geofencing / driver scoring.** Bouncie's own app already does this
  well. Duplicating it here would be work with no payoff.
- **No cost forecasting or depreciation modelling.** The service history on the
  work order board is the raw material for that; build it when someone actually
  asks.
- **No mobile app.** Monday's app is the mobile client.
- **Not built to scale past ~50 vehicles.** The sweep is a serial loop over
  vehicles, and rule evaluation is a query per vehicle per rule. Fine at ten
  trucks, wrong at a hundred — at which point buy a commercial platform instead.

## Cost

| | |
|---|---|
| Cloudflare Workers + D1 | $0 — far inside the free tier |
| Resend (~35 emails/month) | $0 — 3,000/month free |
| Twilio | ~$1.15/month number rental + ~$0.008/message |
| **Total** | **~$1.17/month** |

A commercial fleet-maintenance platform runs $8–15 per vehicle per month, so
roughly $100/month for this fleet. The real cost here is that this is ours to
maintain — the right trade at ten trucks, the wrong one at a hundred.
