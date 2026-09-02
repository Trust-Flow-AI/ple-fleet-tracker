# Contributing

Small private project, few contributors. These notes exist so the non-obvious
parts don't get accidentally undone.

## Getting set up

```bash
git clone https://github.com/Trust-Flow-AI/ple-fleet-tracker.git
cd ple-fleet-tracker
npm install

cp .dev.vars.example .dev.vars     # fill in; never commit this
npm run db:init:local              # local D1
npm run dev
```

```bash
npm run typecheck   # tsc --noEmit — must be clean
npm test            # vitest — must pass
npm run tail        # live production logs
```

Both checks run in CI on every push and PR. Nothing merges red.

## Read first

- [ARCHITECTURE.md](ARCHITECTURE.md) — why the design is what it is. The
  scheduling modes and the idempotency ordering are load-bearing.
- [docs/BOUNCIE-API.md](docs/BOUNCIE-API.md) — before touching anything that
  talks to Bouncie. Their API has a lot of sharp edges and they are all
  documented there.
- [docs/MONDAY-BOARDS.md](docs/MONDAY-BOARDS.md) — before touching a board.

## House rules

**Keep `src/engine.ts` pure.** No `env`, no `fetch`, no `Date.now()`, no DB. It
takes plain objects and returns a verdict. This is what makes the schedule
testable and makes "why did this open?" answerable. If you want to pass `env`
into it, the logic belongs in `sync.ts`.

**Every scheduling change needs a test.** `test/engine.test.ts` covers the
window boundaries, both modes, month-end clamping and DST. Add the case that
motivated your change — the tests are cheap because the engine is pure.

**Never widen the odometer trust.** We use `tripEnd.odometer` only.
`startOdometer` is rounded upstream and `endOdometer` isn't, so differencing
them produces plausible-looking wrong numbers. If you need distance, use the
per-trip `distance` field.

**Keep claim-before-create.** `openWorkOrder` writes its D1 claim row *before*
calling Monday, so a duplicate webhook loses at the unique index and creates
nothing. Reversing that order reintroduces duplicate work orders under retry,
which is the bug most likely to make people stop trusting the board.

**Return 200 to Bouncie on receipt.** A 4xx or 5xx from us triggers their retry
policy, so a slow Monday call would become a retry storm. Validate, ack, then
work in `ctx.waitUntil`.

**Notifications must never fail the work order.** Everything in `notify.ts`
swallows its own errors and returns a boolean. The Monday item is the durable
record; email and SMS are courtesy on top.

**Don't subscribe to `tripData`.** It streams continuously for the whole
duration of every trip, for data the schedule never reads.

**Board IDs live in one place.** `src/config.ts`. If you rebuild a board, every
column gets a new ID — update that file and run `/admin/verify`.

## Adding a service interval

Usually **no code change**: add a row on the Service Intervals board and it
applies on the next sweep. Code is only needed for a genuinely new *kind* of
trigger.

If you do add a trigger type, it needs: a new `TriggerOn` value, a branch in
`evaluate()`, tests for both the fires and doesn't-fire cases, and a row in the
MONDAY-BOARDS.md semantics table.

## Verifying config against the live boards

`src/config.ts` can drift from the real boards. The deployed check is
`GET /admin/verify?key=$ADMIN_KEY`, which reports any column the code expects
that no longer exists. Run it after any board change — CI cannot, because it has
no Monday token.

## Commits and PRs

Conventional-ish prefixes, present tense, say why in the body when it isn't
obvious:

```
fix: stop odometer regressing on out-of-order tripEnd
feat: open a work order when Bouncie reports low battery
docs: record the gps-format required-despite-optional quirk
```

PRs: what changed, why, how you verified it. The template asks for exactly
that. For scheduling changes, say which test covers the new behaviour.

## Secrets

Never commit `.dev.vars`, tokens, or the Bouncie auth code — `.gitignore`
covers the usual paths but it isn't a substitute for looking at your diff.
Production secrets live in `wrangler secret`, never in `wrangler.toml`.

If a secret is ever committed, rotate it rather than only rewriting history:
`BOUNCIE_AUTH_CODE` and `ADMIN_KEY` are both trivially rotatable, and the Monday
token can be regenerated from Monday's developer settings.

## Where things are

```
src/
  index.ts     router + cron dispatch — thin
  sync.ts      orchestration; the only place that touches all three systems
  engine.ts    the due-date decision — PURE, keep it that way
  bouncie.ts   Bouncie client, webhook types, signature check
  monday.ts    Monday GraphQL, column readers/writers
  notify.ts    email + SMS, error-swallowing by design
  config.ts    board/column IDs, env shape, critical DTC list
test/
  engine.test.ts   scheduling logic, date math, DST
  notify.test.ts   phone normalization, digest rendering, escaping
docs/
  BOUNCIE-API.md   field notes on a sharp-edged API
  MONDAY-BOARDS.md board + column reference
  RUNBOOK.md       operating it when something looks wrong
```
