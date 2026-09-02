/**
 * Pure Light Electric — fleet maintenance automation.
 *
 *   Bouncie webhook  ─┐
 *   Bouncie API poll ─┼─▶  this Worker  ─▶  Monday work orders + email + SMS
 *   Monday webhook   ─┘        │
 *                              └─ D1: odometer, service clocks, open orders
 *
 * Bouncie has no maintenance API of its own — its in-app "Care" reminders are
 * not exposed — so the service schedule lives here, driven off the odometer
 * reading that arrives with every tripEnd event.
 */

import { WO_COL, WO_STATUS, type Env } from './config';
import * as bouncie from './bouncie';
import * as monday from './monday';
import { localDayAndHour, toDayString } from './engine';
import * as sync from './sync';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    try {
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /health':
          return json({ ok: true, at: new Date().toISOString() });

        case 'POST /bouncie/webhook':
          return handleBouncieWebhook(req, env, ctx);

        case 'POST /monday/webhook':
          return handleMondayWebhook(req, env, ctx, url);

        case 'GET /admin/verify':
          requireAdmin(url, env);
          return json(await verifyWiring(env));

        case 'POST /admin/sweep':
          requireAdmin(url, env);
          return json(await sync.runSweep(env));

        case 'POST /admin/digest':
          requireAdmin(url, env);
          return json({ sent: await sync.sendDigest(env, toDayString(new Date())) });

        case 'POST /admin/baseline':
          requireAdmin(url, env);
          return json(await setBaseline(req, env));

        case 'GET /admin/audit': {
          requireAdmin(url, env);
          const { results } = await env.DB.prepare(
            `SELECT at, kind, imei, detail FROM audit ORDER BY id DESC LIMIT 100`,
          ).all();
          return json(results);
        }

        default:
          return json({ error: 'Not found' }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'unauthorized') return json({ error: 'unauthorized' }, 401);
      console.error('Unhandled error', err);
      return json({ error: message }, 500);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(event.cron, env));
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

async function runScheduled(cron: string, env: Env): Promise<void> {
  // The 6-hourly firing is the safety net: poll Bouncie directly in case a
  // webhook silently deactivated, and re-arm it.
  if (cron === '0 */6 * * *') {
    await sync.checkWebhookHealth(env);
    await sync.syncIntervals(env);
    await sync.syncVehicles(env);
    const { results } = await env.DB.prepare(`SELECT imei FROM vehicles`).all<{ imei: string }>();
    for (const r of results ?? []) await sync.evaluateVehicle(env, r.imei);
    return;
  }

  // Morning sweep + digest. Two firings cover CST and CDT; the local-hour check
  // plus a once-per-day guard means exactly one of them does the work, and it
  // stays correct across daylight saving without anyone editing the cron.
  const { day, hour } = localDayAndHour(new Date(), env.TIMEZONE);
  if (hour !== Number(env.DIGEST_HOUR)) return;

  const guard = await env.DB.prepare(`SELECT v FROM kv WHERE k = 'last_digest_day'`).first<{ v: string }>();
  if (guard?.v === day) return;

  await env.DB.prepare(
    `INSERT INTO kv (k, v) VALUES ('last_digest_day', ?1)
     ON CONFLICT(k) DO UPDATE SET v = ?1`,
  ).bind(day).run();

  await sync.runSweep(env);
  await sync.sendDigest(env, day);
}

// ---------------------------------------------------------------------------
// Bouncie webhook
// ---------------------------------------------------------------------------

async function handleBouncieWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!bouncie.verifyWebhookAuth(req, env.BOUNCIE_WEBHOOK_KEY)) {
    return json({ error: 'bad webhook key' }, 401);
  }

  let event: bouncie.BouncieEvent;
  try {
    event = (await req.json()) as bouncie.BouncieEvent;
  } catch {
    // Returning 4xx makes Bouncie retry, and a body that will never parse would
    // retry for hours. Accept it and move on.
    return json({ ok: true, ignored: 'unparseable body' });
  }

  // Acknowledge immediately and do the work in the background. Bouncie retries
  // on ANY non-2xx — including a 500 from our own downstream calls — so a slow
  // Monday API would otherwise turn into a retry storm.
  ctx.waitUntil(processBouncieEvent(env, event));
  return json({ ok: true });
}

async function processBouncieEvent(env: Env, event: bouncie.BouncieEvent): Promise<void> {
  try {
    if (!event?.eventType || !event?.imei) return;

    // Deduplicate: retries and out-of-order delivery are both normal here.
    const key = bouncie.eventKey(event);
    try {
      await env.DB.prepare(`INSERT INTO seen_events (key, received_at) VALUES (?1, ?2)`)
        .bind(key, new Date().toISOString()).run();
    } catch {
      return; // already handled
    }

    switch (event.eventType) {
      case 'tripEnd': {
        const odo = event.end?.odometer;
        const at = event.end?.timestamp ?? new Date().toISOString();
        if (typeof odo === 'number' && Number.isFinite(odo)) {
          await sync.applyOdometer(env, event.imei, odo, at);
        }
        if (event.transactionId) {
          await sync.recordTrip(env, event.imei, event.transactionId, {
            endAt: at, fuelConsumed: event.end?.fuelConsumed,
          });
        }
        break;
      }

      case 'tripStart': {
        // startOdometer is rounded to the whole mile upstream while endOdometer
        // is not, so this is only a liveness signal — never a mileage source.
        const at = event.start?.timestamp ?? new Date().toISOString();
        await env.DB.prepare(`UPDATE vehicles SET last_trip_at = ?2 WHERE imei = ?1`)
          .bind(event.imei, at).run();
        if (event.transactionId) {
          await sync.recordTrip(env, event.imei, event.transactionId, { startAt: at });
        }
        break;
      }

      case 'tripMetrics':
        if (event.transactionId && event.metrics) {
          await sync.recordTrip(env, event.imei, event.transactionId, {
            tripDistance: event.metrics.tripDistance,
            totalIdlingTime: event.metrics.totalIdlingTime,
            hardBrakingCounts: event.metrics.hardBrakingCounts,
            hardAccelerationCounts: event.metrics.hardAccelerationCounts,
            maxSpeed: event.metrics.maxSpeed,
          });
        }
        break;

      case 'mil':
        await sync.handleMil(
          env, event.imei,
          (event.mil?.value ?? '').toUpperCase() === 'ON',
          event.mil?.codes ?? '',
        );
        break;

      case 'battery':
        await sync.handleBattery(env, event.imei, event.battery?.value ?? 'normal');
        break;

      case 'connect':
        await sync.handleConnection(env, event.imei, true, event.connect?.timestamp ?? new Date().toISOString());
        break;

      case 'disconnect':
        await sync.handleConnection(env, event.imei, false, event.disconnect?.timestamp ?? new Date().toISOString());
        break;

      case 'vinChange':
        // A VIN change means the dongle was moved to a different vehicle. Left
        // unnoticed, every mile and every service would be logged against the
        // wrong truck, so this is worth a human looking at it.
        await env.DB.prepare(`INSERT INTO audit (at, kind, imei, detail) VALUES (?1,'vin_change',?2,?3)`)
          .bind(new Date().toISOString(), event.imei,
            `${event.vinChange?.oldVin ?? 'none'} -> ${event.vinChange?.newVin ?? 'none'}`).run();
        break;

      default:
        break; // tripData and geozones are not used by the maintenance schedule
    }
  } catch (err) {
    console.error('processBouncieEvent failed', event?.eventType, event?.imei, err);
  }
}

// ---------------------------------------------------------------------------
// Monday webhook — fires when a work order's status changes
// ---------------------------------------------------------------------------

interface MondayWebhookBody {
  challenge?: string;
  event?: {
    type?: string;
    boardId?: number;
    pulseId?: number;
    columnId?: string;
    value?: { label?: { text?: string } };
  };
}

async function handleMondayWebhook(
  req: Request, env: Env, ctx: ExecutionContext, url: URL,
): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as MondayWebhookBody;

  // Monday verifies a new webhook URL by POSTing a challenge it expects echoed
  // back. This must answer before any auth check, or the webhook cannot be saved.
  if (body.challenge) return json({ challenge: body.challenge });

  requireAdmin(url, env);

  const ev = body.event;
  if (!ev?.pulseId || ev.columnId !== WO_COL.status) return json({ ok: true, ignored: 'not a status change' });

  const label = ev.value?.label?.text;
  if (label !== WO_STATUS.done && label !== WO_STATUS.skipped) {
    return json({ ok: true, ignored: `status ${label}` });
  }

  ctx.waitUntil(
    sync.completeWorkOrder(env, String(ev.pulseId), label === WO_STATUS.skipped)
      .catch((err) => console.error('completeWorkOrder failed', err)),
  );
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

function requireAdmin(url: URL, env: Env): void {
  if (url.searchParams.get('key') !== env.ADMIN_KEY) throw new Error('unauthorized');
}

/**
 * Confirms the board columns this code expects still exist. Run it after any
 * board surgery — a deleted column otherwise fails silently on one field.
 */
async function verifyWiring(env: Env): Promise<unknown> {
  const boards = [
    { name: 'Vehicles', id: env.MONDAY_BOARD_VEHICLES },
    { name: 'Intervals', id: env.MONDAY_BOARD_INTERVALS },
    { name: 'Work Orders', id: env.MONDAY_BOARD_WORKORDERS },
  ];
  const data = await monday.gql<{ boards: Array<{ id: string; name: string; columns: Array<{ id: string; title: string }> }> }>(
    env,
    `query V($ids: [ID!]) { boards(ids: $ids) { id name columns { id title } } }`,
    { ids: boards.map((b) => b.id) },
  );

  const found = new Map(data.boards.map((b) => [b.id, new Set(b.columns.map((c) => c.id))]));
  const expected: Array<[string, string, string]> = [];
  const { VEHICLE_COL, INTERVAL_COL } = await import('./config');
  for (const [k, v] of Object.entries(VEHICLE_COL)) expected.push(['Vehicles', env.MONDAY_BOARD_VEHICLES, `${k}=${v}`]);
  for (const [k, v] of Object.entries(INTERVAL_COL)) expected.push(['Intervals', env.MONDAY_BOARD_INTERVALS, `${k}=${v}`]);
  for (const [k, v] of Object.entries(WO_COL)) expected.push(['Work Orders', env.MONDAY_BOARD_WORKORDERS, `${k}=${v}`]);

  const missing = expected.filter(([, boardId, kv]) => !found.get(boardId)?.has(kv.split('=')[1]!));

  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM vehicles) AS vehicles,
       (SELECT COUNT(*) FROM intervals WHERE active = 1) AS active_rules,
       (SELECT COUNT(*) FROM work_orders WHERE state = 'open') AS open_orders,
       (SELECT COUNT(*) FROM service_state) AS service_clocks`,
  ).first();

  let webhooks: unknown = 'could not reach Bouncie';
  try {
    webhooks = (await bouncie.listWebhooks(env)).map((w) => ({ name: w.name, active: w.active, events: w.events }));
  } catch { /* reported as-is above */ }

  return {
    ok: missing.length === 0,
    boards: data.boards.map((b) => ({ id: b.id, name: b.name, columns: b.columns.length })),
    missingColumns: missing.map(([board, , kv]) => `${board}: ${kv}`),
    database: counts,
    bouncieWebhooks: webhooks,
  };
}

/**
 * Tell the system when a service was actually last done, so the first
 * automatic due date is real rather than assumed.
 *
 *   POST /admin/baseline?key=...
 *   { "imei": "...", "intervalId": "...", "odometer": 41200, "date": "2026-06-14" }
 */
async function setBaseline(req: Request, env: Env): Promise<unknown> {
  const b = (await req.json()) as { imei?: string; intervalId?: string; odometer?: number; date?: string };
  if (!b.imei || !b.intervalId) throw new Error('imei and intervalId are required');
  await env.DB.prepare(
    `INSERT INTO service_state (imei, interval_id, last_done_odo, last_done_at, source)
     VALUES (?1, ?2, ?3, ?4, 'manual')
     ON CONFLICT(imei, interval_id) DO UPDATE SET last_done_odo=?3, last_done_at=?4, source='manual'`,
  ).bind(b.imei, b.intervalId, b.odometer ?? null, b.date ?? toDayString(new Date())).run();
  const opened = await sync.evaluateVehicle(env, b.imei);
  return { ok: true, openedAfterBaseline: opened };
}
