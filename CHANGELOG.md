# Changelog

## [1.0.0] — 2026-09-02

First working version. Boards live, code deployable, not yet in production.

### Added

- **Three Monday boards** — Vehicles (registry + live
  telematics), Service Intervals (the rulebook), Maintenance & Renewals (work
  orders, with the Done group doubling as the service history).
- **22 pre-loaded service intervals** covering engine and fluids, brakes, tires,
  compliance and inspections, with real intervals, lead times and shop notes.
- **Cloudflare Worker** receiving Bouncie webhooks: `tripEnd` drives the
  odometer and re-evaluates the schedule; `mil` opens a diagnostic work order
  with the actual fault codes; `battery` low/critical opens a battery order;
  connect/disconnect track device state; `vinChange` is audited.
- **Two scheduling modes** — recurring intervals measured from the last
  completion, and fixed-expiry rules read off a vehicle date column. Kept
  separate so compliance items cannot double-book.
- **Completion loop** — marking a work order Done resets that service's clock
  from the odometer and date the tech entered, falling back to the live Bouncie
  reading and saying so when they're blank.
- **6am Central digest**, with two cron firings and a local-hour check so it
  stays correct across daylight saving without editing the schedule. Sends an
  all-clear when nothing is due, so silence always means broken.
- **Webhook self-healing** — a 6-hourly cron detects webhooks Bouncie has
  silently deactivated, re-enables them, and emails. The same cron polls
  odometers directly as a backstop, so nothing is missed while a webhook is down.
- **Email via Resend, SMS via Twilio**, both optional; the Worker degrades to
  Monday-only notifications when their secrets are absent.
- **Admin endpoints** — `/admin/verify` (schema + data + webhook health),
  `/admin/sweep`, `/admin/digest`, `/admin/baseline`, `/admin/audit`.
- **31 tests** over the scheduling engine and notification rendering, covering
  window boundaries, both modes, month-end clamping, DST, and HTML escaping.
- Documentation: architecture and rationale, Bouncie API field notes, board
  reference, operational runbook, contributing guide.

### Notes

- Bouncie exposes no maintenance API — their in-app "Care" reminders are not
  reachable — which is why the schedule lives in Monday and the arithmetic in
  the Worker. See ARCHITECTURE.md.
- Not yet baselined against real service history; new vehicles assume "serviced
  as of first sync" until `/admin/baseline` is used.
- Board IDs, the Monday account URL and notification addresses are deployment
  secrets rather than repo contents, so this repository can be public.
