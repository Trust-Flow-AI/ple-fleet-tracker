/** Orchestration: ties Bouncie, the engine, D1 and Monday together. */

import {
  ACTIVE_VEHICLE_STATUSES, CRITICAL_DTC_PREFIXES, OPENED_BY, PRIORITY,
  VEHICLE_COL, WO_COL, WO_GROUP, WO_STATUS, type Env,
} from './config';
import * as bouncie from './bouncie';
import * as monday from './monday';
import {
  evaluate, isCriticalDtc, priorityFor, toDayString,
  type EvalRule, type EvalVehicle,
} from './engine';
import { mailContext, renderAlert, renderDigest, sendEmail, sendSms, type DigestLine } from './notify';

const nowIso = () => new Date().toISOString();
const today = () => toDayString(new Date());

async function audit(env: Env, kind: string, imei: string | null, detail: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO audit (at, kind, imei, detail) VALUES (?1, ?2, ?3, ?4)`)
    .bind(nowIso(), kind, imei, detail.slice(0, 2000))
    .run();
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/** Mirror the Service Intervals board into D1 so a change in Monday lands same-day. */
export async function syncIntervals(env: Env): Promise<number> {
  const rules = await monday.fetchIntervals(env);
  const stmts = rules.map((r) =>
    env.DB.prepare(
      `INSERT INTO intervals (id, name, category, trigger_on, miles, months, warn_miles,
         warn_days, applies_to, owner_ids, est_cost, active, watch_date_col, instructions, synced_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
       ON CONFLICT(id) DO UPDATE SET
         name=?2, category=?3, trigger_on=?4, miles=?5, months=?6, warn_miles=?7,
         warn_days=?8, applies_to=?9, owner_ids=?10, est_cost=?11, active=?12,
         watch_date_col=?13, instructions=?14, synced_at=?15`,
    ).bind(
      r.id, r.name, r.category, r.triggerOn, r.miles, r.months, r.warnMiles, r.warnDays,
      JSON.stringify(r.appliesTo), JSON.stringify(r.ownerIds), r.estCost,
      r.active ? 1 : 0, r.watchDateCol, r.instructions, nowIso(),
    ),
  );
  if (stmts.length) await env.DB.batch(stmts);

  // Drop rules the office deleted in Monday, so they stop being evaluated.
  const keep = rules.map((r) => r.id);
  if (keep.length) {
    await env.DB.prepare(
      `DELETE FROM intervals WHERE id NOT IN (${keep.map(() => '?').join(',')})`,
    ).bind(...keep).run();
  }
  return rules.length;
}

interface CachedInterval {
  id: string; name: string; category: string | null; trigger_on: string;
  miles: number | null; months: number | null; warn_miles: number; warn_days: number;
  applies_to: string; owner_ids: string; est_cost: number | null; active: number;
  watch_date_col: string | null; instructions: string | null;
}

async function cachedIntervals(env: Env): Promise<CachedInterval[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM intervals WHERE active = 1`).all<CachedInterval>();
  return results ?? [];
}

function toRule(ci: CachedInterval): EvalRule {
  return {
    id: ci.id,
    name: ci.name,
    triggerOn: (ci.trigger_on as EvalRule['triggerOn']) ?? 'Whichever First',
    miles: ci.miles, months: ci.months,
    warnMiles: ci.warn_miles ?? 0, warnDays: ci.warn_days ?? 0,
    watchDateCol: ci.watch_date_col,
    active: ci.active === 1,
    appliesTo: safeJsonArray(ci.applies_to),
  };
}

function safeJsonArray(s: string | null): string[] {
  if (!s) return [];
  try { const p = JSON.parse(s); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
}
function safeJsonNumArray(s: string | null): number[] {
  if (!s) return [];
  try { const p = JSON.parse(s); return Array.isArray(p) ? p.map(Number).filter(Number.isFinite) : []; } catch { return []; }
}

// ---------------------------------------------------------------------------
// Vehicle sync
// ---------------------------------------------------------------------------

export interface VehicleRecord {
  imei: string; monday_item_id: string; vin: string | null; label: string;
  status: string; odometer: number | null; odometer_at: string | null;
  driver_phone: string | null; driver_ids: string | null;
  tag_expires: string | null; insurance_expires: string | null; inspection_due: string | null;
}

/**
 * Reconcile the Monday vehicle registry with what Bouncie reports, then make
 * sure every vehicle has a service baseline. Without the baseline step, adding
 * a truck would immediately open all ~20 work orders at once, which is how
 * people learn to ignore the board.
 */
export async function syncVehicles(env: Env): Promise<{ matched: number; unmatched: string[]; seeded: number }> {
  const [mondayVehicles, bouncieVehicles] = await Promise.all([
    monday.fetchVehicles(env),
    bouncie.listVehicles(env).catch((err) => {
      console.error('Bouncie /vehicles failed during sync; continuing with Monday data only', err);
      return [] as bouncie.BouncieVehicle[];
    }),
  ]);

  const byImei = new Map(bouncieVehicles.filter((v) => v.imei).map((v) => [v.imei!, v]));
  const unmatched: string[] = [];
  let matched = 0;
  let seeded = 0;

  for (const mv of mondayVehicles) {
    if (!mv.imei) { unmatched.push(`${mv.name} (no IMEI on the Monday item)`); continue; }
    const bv = byImei.get(mv.imei);
    if (!bv) unmatched.push(`${mv.name} (IMEI ${mv.imei} not found in Bouncie)`);
    else matched++;

    const odo = bv ? bouncie.readOdometer(bv) : null;
    const dtc = bv ? bouncie.readDtcCodes(bv) : [];
    const milOn = bv?.stats?.mil?.milOn === true;
    const battery = bv?.stats?.battery?.status ?? null;

    await env.DB.prepare(
      `INSERT INTO vehicles (imei, monday_item_id, vin, label, status, odometer, odometer_at,
         mil_on, dtc_codes, battery, driver_phone, driver_ids,
         tag_expires, insurance_expires, inspection_due, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
       ON CONFLICT(imei) DO UPDATE SET
         monday_item_id=?2, vin=COALESCE(?3, vin), label=?4, status=?5,
         odometer=COALESCE(?6, odometer), odometer_at=COALESCE(?7, odometer_at),
         mil_on=?8, dtc_codes=?9, battery=COALESCE(?10, battery),
         driver_phone=?11, driver_ids=?12,
         tag_expires=?13, insurance_expires=?14, inspection_due=?15, updated_at=?16`,
    ).bind(
      mv.imei, mv.mondayItemId, bv?.vin ?? mv.vin, mv.name, mv.status,
      odo, bv?.stats?.lastUpdated ?? null, milOn ? 1 : 0,
      dtc.join(', ') || null, battery, mv.driverPhone, JSON.stringify(mv.driverIds),
      mv.tagExpires, mv.insuranceExpires, mv.inspectionDue, nowIso(),
    ).run();

    // Push live telematics back onto the Monday item so the board is the
    // single place anyone has to look.
    if (bv) {
      const patch: Record<string, unknown> = {};
      if (odo !== null) patch[VEHICLE_COL.odometer] = Math.round(odo);
      if (bv.stats?.lastUpdated) {
        patch[VEHICLE_COL.odometerUpdated] = { date: bv.stats.lastUpdated.slice(0, 10) };
      }
      patch[VEHICLE_COL.checkEngine] = { label: milOn ? 'CHECK ENGINE ON' : 'OK' };
      if (dtc.length) patch[VEHICLE_COL.faultCodes] = dtc.join(', ');
      if (battery) {
        const label = battery.toLowerCase() === 'low' ? 'Low'
          : battery.toLowerCase() === 'critical' ? 'Critical' : 'Normal';
        patch[VEHICLE_COL.battery] = { label };
      }
      try { await monday.updateItem(env, env.MONDAY_BOARD_VEHICLES, mv.mondayItemId, patch); }
      catch (err) { console.error(`Failed to push telematics to ${mv.name}`, err); }
    }

    if (env.SEED_BASELINE_FROM_CURRENT !== 'false') {
      seeded += await seedBaselines(env, mv.imei, odo);
    }
  }

  await audit(env, 'sync_vehicles', null,
    `matched=${matched} unmatched=${unmatched.length} seeded=${seeded}`);
  return { matched, unmatched, seeded };
}

/**
 * Give a vehicle a starting point for every interval it does not have one for.
 * We assume "serviced as of right now", which is optimistic but recoverable:
 * marking a work order Done with a back-dated odometer corrects it, and the
 * /admin/baseline endpoint sets it explicitly.
 */
async function seedBaselines(env: Env, imei: string, odometer: number | null): Promise<number> {
  const rules = await cachedIntervals(env);
  let n = 0;
  for (const r of rules) {
    if (r.watch_date_col) continue; // driven by a vehicle expiry date, needs no baseline
    if (r.trigger_on === 'Fault Code') continue;
    const existing = await env.DB.prepare(
      `SELECT 1 FROM service_state WHERE imei = ?1 AND interval_id = ?2`,
    ).bind(imei, r.id).first();
    if (existing) continue;
    await env.DB.prepare(
      `INSERT INTO service_state (imei, interval_id, last_done_odo, last_done_at, source)
       VALUES (?1, ?2, ?3, ?4, 'seeded')`,
    ).bind(imei, r.id, odometer, today()).run();
    n++;
  }
  return n;
}

async function getVehicle(env: Env, imei: string): Promise<VehicleRecord | null> {
  return env.DB.prepare(`SELECT * FROM vehicles WHERE imei = ?1`).bind(imei).first<VehicleRecord>();
}

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------

async function openWorkOrder(
  env: Env,
  v: VehicleRecord,
  rule: { id: string; name: string; category: string | null; ownerIds: number[]; instructions: string | null; estCost: number | null },
  opts: {
    statusLabel: string; priority: string; openedBy: string;
    dueOdo: number | null; dueDate: string | null; milesRemaining: number | null;
    reason: string;
  },
): Promise<string | null> {
  // Claim the slot in D1 first. The partial unique index on (imei, interval_id)
  // WHERE state='open' means a duplicate claim throws here, before we have
  // created anything in Monday — which is exactly the ordering we want, since
  // Bouncie retries webhooks and can deliver the same tripEnd twice.
  const claimId = `pending:${v.imei}:${rule.id}`;
  try {
    await env.DB.prepare(
      `INSERT INTO work_orders (monday_item_id, imei, interval_id, state, due_odo, due_date, priority, opened_at)
       VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6, ?7)`,
    ).bind(claimId, v.imei, rule.id, opts.dueOdo, opts.dueDate, opts.priority, nowIso()).run();
  } catch {
    return null; // already open — nothing to do
  }

  const overdue = opts.statusLabel === WO_STATUS.overdue;
  const values: Record<string, unknown> = {
    [WO_COL.status]: { label: opts.statusLabel },
    [WO_COL.vehicle]: { item_ids: [Number(v.monday_item_id)] },
    [WO_COL.serviceType]: { item_ids: [Number(rule.id)] },
    [WO_COL.priority]: { label: opts.priority },
    [WO_COL.openedBy]: { label: opts.openedBy },
  };

  const assignees = safeJsonNumArray(v.driver_ids).length
    ? safeJsonNumArray(v.driver_ids)
    : rule.ownerIds;
  if (assignees.length) {
    values[WO_COL.assignedTo] = { personsAndTeams: assignees.map((id) => ({ id, kind: 'person' })) };
  }
  if (opts.dueDate) values[WO_COL.dueDate] = { date: opts.dueDate };
  if (opts.dueOdo !== null) values[WO_COL.dueAtOdometer] = Math.round(opts.dueOdo);
  if (opts.milesRemaining !== null) values[WO_COL.milesRemaining] = Math.round(opts.milesRemaining);
  if (rule.instructions) values[WO_COL.notes] = { text: rule.instructions };

  let itemId: string;
  try {
    itemId = await monday.createWorkOrder(env, {
      name: `${v.label} — ${rule.name}`,
      groupId: overdue ? WO_GROUP.overdue : WO_GROUP.dueSoon,
      values,
    });
  } catch (err) {
    // Release the claim so the next sweep can retry rather than going quiet.
    await env.DB.prepare(`DELETE FROM work_orders WHERE monday_item_id = ?1`).bind(claimId).run();
    console.error(`Failed to create work order for ${v.label} / ${rule.name}`, err);
    return null;
  }

  await env.DB.prepare(`UPDATE work_orders SET monday_item_id = ?1 WHERE monday_item_id = ?2`)
    .bind(itemId, claimId).run();

  const why = [
    `Opened automatically — ${opts.reason}.`,
    opts.dueOdo !== null ? `Due at ${Math.round(opts.dueOdo).toLocaleString()} mi (current: ${v.odometer ? Math.round(v.odometer).toLocaleString() : 'unknown'} mi).` : null,
    opts.dueDate ? `Due date: ${opts.dueDate}.` : null,
    rule.estCost ? `Budget estimate: $${rule.estCost}.` : null,
    'Set the status to Done and fill in Completed Date and Odometer at Service — the next one is scheduled from what you enter.',
  ].filter(Boolean).join('\n\n');
  await monday.postUpdate(env, itemId, why).catch(() => {});

  if (assignees.length) {
    await monday.notifyUsers(env, assignees, itemId,
      `${overdue ? 'OVERDUE' : 'Due soon'}: ${rule.name} on ${v.label} — ${opts.reason}`);
  }

  await audit(env, 'work_order_opened', v.imei, `${rule.name} (${opts.statusLabel}) — ${opts.reason}`);
  return itemId;
}

/** Run the schedule for one vehicle. Called after every odometer change and in the sweep. */
export async function evaluateVehicle(env: Env, imei: string): Promise<number> {
  const v = await getVehicle(env, imei);
  if (!v) return 0;
  if (!ACTIVE_VEHICLE_STATUSES.has(v.status)) return 0;

  const rules = await cachedIntervals(env);
  const evalVehicle: EvalVehicle = {
    mondayItemId: v.monday_item_id,
    odometer: v.odometer,
    dateColumns: {
      [VEHICLE_COL.tagExpires]: v.tag_expires,
      [VEHICLE_COL.insuranceExpires]: v.insurance_expires,
      [VEHICLE_COL.inspectionDue]: v.inspection_due,
    },
  };

  let opened = 0;
  for (const ci of rules) {
    const state = await env.DB.prepare(
      `SELECT last_done_odo, last_done_at FROM service_state WHERE imei = ?1 AND interval_id = ?2`,
    ).bind(imei, ci.id).first<{ last_done_odo: number | null; last_done_at: string | null }>();

    const result = evaluate(
      evalVehicle,
      toRule(ci),
      { lastDoneOdo: state?.last_done_odo ?? null, lastDoneAt: state?.last_done_at ?? null },
      today(),
    );

    // Keep Miles Remaining live on any already-open order for this service.
    if (result.applicable && result.milesRemaining !== null) {
      const open = await env.DB.prepare(
        `SELECT monday_item_id FROM work_orders WHERE imei = ?1 AND interval_id = ?2 AND state = 'open'`,
      ).bind(imei, ci.id).first<{ monday_item_id: string }>();
      if (open && !open.monday_item_id.startsWith('pending:')) {
        const patch: Record<string, unknown> = {
          [WO_COL.milesRemaining]: Math.round(result.milesRemaining),
        };
        if (result.overdue) patch[WO_COL.status] = { label: WO_STATUS.overdue };
        await monday.updateItem(env, env.MONDAY_BOARD_WORKORDERS, open.monday_item_id, patch).catch(() => {});
        if (result.overdue) {
          await monday.moveItemToGroup(env, open.monday_item_id, WO_GROUP.overdue).catch(() => {});
        }
        continue;
      }
    }

    if (!result.due) continue;

    const id = await openWorkOrder(env, v, {
      id: ci.id, name: ci.name, category: ci.category,
      ownerIds: safeJsonNumArray(ci.owner_ids), instructions: ci.instructions, estCost: ci.est_cost,
    }, {
      statusLabel: result.overdue ? WO_STATUS.overdue : WO_STATUS.dueSoon,
      priority: priorityFor(result),
      openedBy: ci.watch_date_col || ci.trigger_on === 'Date Only' ? OPENED_BY.date : OPENED_BY.mileage,
      dueOdo: result.dueOdo, dueDate: result.dueDate,
      milesRemaining: result.milesRemaining, reason: result.reason,
    });
    if (id) opened++;
  }
  return opened;
}

/** Mark a work order complete and restart that service's clock. */
export async function completeWorkOrder(
  env: Env, mondayItemId: string, skipped = false,
): Promise<void> {
  const wo = await env.DB.prepare(
    `SELECT * FROM work_orders WHERE monday_item_id = ?1 AND state = 'open'`,
  ).bind(mondayItemId).first<{ imei: string; interval_id: string }>();
  if (!wo) return;

  const item = await monday.fetchItem(env, mondayItemId);
  const v = await getVehicle(env, wo.imei);

  // Prefer what the tech actually wrote down; fall back to live telematics.
  const enteredOdo = item ? monday.numberOf(item, WO_COL.odometerAtService) : null;
  const enteredDate = item ? monday.dateOf(item, WO_COL.completedDate) : null;
  const doneOdo = enteredOdo ?? v?.odometer ?? null;
  const doneAt = enteredDate ?? today();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO service_state (imei, interval_id, last_done_odo, last_done_at, source)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(imei, interval_id) DO UPDATE SET last_done_odo=?3, last_done_at=?4, source=?5`,
    ).bind(wo.imei, wo.interval_id, doneOdo, doneAt, skipped ? 'skipped' : 'completed'),
    env.DB.prepare(
      `UPDATE work_orders SET state = ?2, closed_at = ?3 WHERE monday_item_id = ?1`,
    ).bind(mondayItemId, skipped ? 'skipped' : 'done', nowIso()),
  ]);

  await monday.moveItemToGroup(env, mondayItemId, WO_GROUP.history).catch(() => {});
  if (!enteredOdo && doneOdo !== null) {
    await monday.updateItem(env, env.MONDAY_BOARD_WORKORDERS, mondayItemId, {
      [WO_COL.odometerAtService]: Math.round(doneOdo),
      [WO_COL.completedDate]: { date: doneAt },
    }).catch(() => {});
    await monday.postUpdate(env, mondayItemId,
      `No odometer was entered, so the clock was reset from the live Bouncie reading: ${Math.round(doneOdo).toLocaleString()} mi on ${doneAt}.`,
    ).catch(() => {});
  }

  await audit(env, skipped ? 'work_order_skipped' : 'work_order_done', wo.imei,
    `interval=${wo.interval_id} odo=${doneOdo ?? 'unknown'} at=${doneAt}`);
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

export async function applyOdometer(env: Env, imei: string, odometer: number, at: string): Promise<void> {
  const v = await getVehicle(env, imei);
  if (!v) { await audit(env, 'unknown_imei', imei, `odometer ${odometer} for an IMEI not on the Vehicles board`); return; }

  // Bouncie can deliver webhooks out of order; never walk the odometer backwards.
  if (v.odometer !== null && odometer < v.odometer) {
    await audit(env, 'odometer_out_of_order', imei, `ignored ${odometer} < stored ${v.odometer}`);
    return;
  }

  await env.DB.prepare(
    `UPDATE vehicles SET odometer = ?2, odometer_at = ?3, last_trip_at = ?3, updated_at = ?4 WHERE imei = ?1`,
  ).bind(imei, odometer, at, nowIso()).run();

  await monday.updateItem(env, env.MONDAY_BOARD_VEHICLES, v.monday_item_id, {
    [VEHICLE_COL.odometer]: Math.round(odometer),
    [VEHICLE_COL.odometerUpdated]: { date: at.slice(0, 10) },
    [VEHICLE_COL.deviceStatus]: { label: 'Connected' },
  }).catch((err) => console.error('Failed to write odometer to Monday', err));

  await evaluateVehicle(env, imei);
}

export async function handleMil(env: Env, imei: string, on: boolean, codes: string): Promise<void> {
  const v = await getVehicle(env, imei);
  if (!v) return;

  const codeList = codes.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean);
  const critical = codeList.some((c) => isCriticalDtc(c, CRITICAL_DTC_PREFIXES));

  await env.DB.prepare(
    `UPDATE vehicles SET mil_on = ?2, dtc_codes = ?3, updated_at = ?4 WHERE imei = ?1`,
  ).bind(imei, on ? 1 : 0, codeList.join(', ') || null, nowIso()).run();

  await monday.updateItem(env, env.MONDAY_BOARD_VEHICLES, v.monday_item_id, {
    [VEHICLE_COL.checkEngine]: { label: on ? 'CHECK ENGINE ON' : 'OK' },
    [VEHICLE_COL.faultCodes]: codeList.join(', '),
  }).catch(() => {});

  if (!on) { await audit(env, 'mil_cleared', imei, 'check engine light off'); return; }

  const rule = await env.DB.prepare(
    `SELECT * FROM intervals WHERE trigger_on = 'Fault Code' AND active = 1 LIMIT 1`,
  ).first<CachedInterval>();
  if (!rule) { await audit(env, 'mil_on_no_rule', imei, codeList.join(', ')); return; }

  const itemId = await openWorkOrder(env, v, {
    id: rule.id, name: rule.name, category: rule.category,
    ownerIds: safeJsonNumArray(rule.owner_ids), instructions: rule.instructions, estCost: rule.est_cost,
  }, {
    statusLabel: WO_STATUS.overdue,
    priority: critical ? PRIORITY.critical : PRIORITY.high,
    openedBy: OPENED_BY.faultCode,
    dueOdo: null, dueDate: today(), milesRemaining: null,
    reason: `check engine light came on${codeList.length ? ` with ${codeList.join(', ')}` : ''}`,
  });

  const body = critical
    ? `The check engine light came on with ${codeList.join(', ')}. These codes point at something that can destroy the engine or leave a crew stranded — park the truck and get it looked at before it goes back out.`
    : `The check engine light came on${codeList.length ? ` with ${codeList.join(', ')}` : ''}. A diagnostic work order is open. Safe to keep driving unless it starts running rough or overheating.`;

  await sendEmail(env, {
    to: env.ALERT_TO,
    subject: `${critical ? '[CRITICAL] ' : ''}Check engine — ${v.label}`,
    html: renderAlert({ title: 'Check engine light', vehicle: v.label, body, itemId: itemId ?? undefined, ctx: mailContext(env) }),
  });

  if (v.driver_phone && env.SMS_PRIORITIES.includes(critical ? PRIORITY.critical : PRIORITY.high)) {
    await sendSms(env, v.driver_phone,
      critical
        ? `PURE LIGHT FLEET: ${v.label} threw ${codeList.join(', ')}. Do not keep driving it — call the office.`
        : `PURE LIGHT FLEET: ${v.label} check engine light is on (${codeList.join(', ')}). A work order is open; keep an eye on it.`);
  }
}

export async function handleBattery(env: Env, imei: string, value: string): Promise<void> {
  const v = await getVehicle(env, imei);
  if (!v) return;
  const level = value.toLowerCase();
  const label = level === 'critical' ? 'Critical' : level === 'low' ? 'Low' : 'Normal';

  await env.DB.prepare(`UPDATE vehicles SET battery = ?2, updated_at = ?3 WHERE imei = ?1`)
    .bind(imei, label, nowIso()).run();
  await monday.updateItem(env, env.MONDAY_BOARD_VEHICLES, v.monday_item_id, {
    [VEHICLE_COL.battery]: { label },
  }).catch(() => {});

  if (label === 'Normal') return;

  const rule = await env.DB.prepare(
    `SELECT * FROM intervals WHERE name LIKE 'Battery%' AND active = 1 LIMIT 1`,
  ).first<CachedInterval>();
  if (!rule) return;

  const itemId = await openWorkOrder(env, v, {
    id: rule.id, name: rule.name, category: rule.category,
    ownerIds: safeJsonNumArray(rule.owner_ids), instructions: rule.instructions, estCost: rule.est_cost,
  }, {
    statusLabel: WO_STATUS.overdue,
    priority: label === 'Critical' ? PRIORITY.critical : PRIORITY.high,
    openedBy: OPENED_BY.battery,
    dueOdo: null, dueDate: today(), milesRemaining: null,
    reason: `Bouncie reported battery ${label.toLowerCase()}`,
  });

  await sendEmail(env, {
    to: env.ALERT_TO,
    subject: `Battery ${label.toLowerCase()} — ${v.label}`,
    html: renderAlert({
      title: `Battery reading ${label.toLowerCase()}`,
      vehicle: v.label,
      body: `Bouncie is reporting a ${label.toLowerCase()} battery. Get it load-tested before it strands someone on a job site — a no-start first thing in the morning costs a whole crew's morning, not just one truck's.`,
      itemId: itemId ?? undefined,
      ctx: mailContext(env),
    }),
  });
}

export async function handleConnection(env: Env, imei: string, connected: boolean, at: string): Promise<void> {
  const v = await getVehicle(env, imei);
  if (!v) return;
  await env.DB.prepare(
    `UPDATE vehicles SET connected = ?2, disconnected_at = ?3, updated_at = ?4 WHERE imei = ?1`,
  ).bind(imei, connected ? 1 : 0, connected ? null : at, nowIso()).run();
  await monday.updateItem(env, env.MONDAY_BOARD_VEHICLES, v.monday_item_id, {
    [VEHICLE_COL.deviceStatus]: { label: connected ? 'Connected' : 'Disconnected' },
  }).catch(() => {});
  await audit(env, connected ? 'device_connect' : 'device_disconnect', imei, at);
}

export async function recordTrip(env: Env, imei: string, txId: string, m: {
  tripDistance?: number; fuelConsumed?: number; totalIdlingTime?: number;
  hardBrakingCounts?: number; hardAccelerationCounts?: number; maxSpeed?: number;
  startAt?: string; endAt?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO trips (transaction_id, imei, start_at, end_at, distance, fuel_consumed,
       idle_seconds, hard_brake, hard_accel, max_speed)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
     ON CONFLICT(transaction_id) DO UPDATE SET
       end_at=COALESCE(?4, end_at), distance=COALESCE(?5, distance),
       fuel_consumed=COALESCE(?6, fuel_consumed), idle_seconds=COALESCE(?7, idle_seconds),
       hard_brake=COALESCE(?8, hard_brake), hard_accel=COALESCE(?9, hard_accel),
       max_speed=COALESCE(?10, max_speed)`,
  ).bind(
    txId, imei, m.startAt ?? null, m.endAt ?? null, m.tripDistance ?? null,
    m.fuelConsumed ?? null, m.totalIdlingTime ?? null,
    m.hardBrakingCounts ?? null, m.hardAccelerationCounts ?? null, m.maxSpeed ?? null,
  ).run();
}

// ---------------------------------------------------------------------------
// Scheduled work
// ---------------------------------------------------------------------------

export async function runSweep(env: Env): Promise<{ vehicles: number; opened: number }> {
  await syncIntervals(env);
  await syncVehicles(env);
  const { results } = await env.DB.prepare(`SELECT imei FROM vehicles`).all<{ imei: string }>();
  let opened = 0;
  for (const r of results ?? []) opened += await evaluateVehicle(env, r.imei);
  await audit(env, 'sweep', null, `vehicles=${results?.length ?? 0} opened=${opened}`);
  return { vehicles: results?.length ?? 0, opened };
}

export async function sendDigest(env: Env, day: string): Promise<boolean> {
  const { results } = await env.DB.prepare(
    `SELECT w.monday_item_id, w.due_odo, w.due_date, w.priority, w.state,
            v.label AS vehicle, v.odometer, i.name AS service
     FROM work_orders w
     JOIN vehicles v ON v.imei = w.imei
     LEFT JOIN intervals i ON i.id = w.interval_id
     WHERE w.state = 'open'
     ORDER BY w.due_date IS NULL, w.due_date ASC`,
  ).all<{
    monday_item_id: string; due_odo: number | null; due_date: string | null;
    priority: string | null; vehicle: string; odometer: number | null; service: string | null;
  }>();

  const lines: DigestLine[] = (results ?? []).map((r) => {
    const milesLeft = r.due_odo !== null && r.odometer !== null ? Math.round(r.due_odo - r.odometer) : null;
    const daysLeft = r.due_date ? Math.round((new Date(`${r.due_date}T00:00:00Z`).getTime() - new Date(`${day}T00:00:00Z`).getTime()) / 86_400_000) : null;
    const overdue = (milesLeft !== null && milesLeft <= 0) || (daysLeft !== null && daysLeft <= 0);
    const detail = [
      milesLeft !== null ? (milesLeft <= 0 ? `${Math.abs(milesLeft).toLocaleString()} mi over` : `${milesLeft.toLocaleString()} mi left`) : null,
      daysLeft !== null ? (daysLeft <= 0 ? `${Math.abs(daysLeft)} days over` : `${daysLeft} days left`) : null,
    ].filter(Boolean).join(' · ');
    return {
      vehicle: r.vehicle, service: r.service ?? 'Service',
      status: overdue ? 'Overdue' : 'Due Soon',
      detail: detail || '—', itemId: r.monday_item_id, priority: r.priority ?? 'Normal',
    };
  });

  const { subject, html } = renderDigest(lines, day, mailContext(env));
  const ok = await sendEmail(env, { to: env.DIGEST_TO, subject, html });
  await audit(env, 'digest', null, `${lines.length} open orders, sent=${ok}`);
  return ok;
}

/**
 * Bouncie is known to silently flip webhooks to inactive. If that happens and
 * nobody notices, the whole system just quietly stops working — so check, and
 * turn them back on.
 */
export async function checkWebhookHealth(env: Env): Promise<{ checked: number; revived: string[] }> {
  const revived: string[] = [];
  let checked = 0;
  try {
    const hooks = await bouncie.listWebhooks(env);
    checked = hooks.length;
    for (const h of hooks) {
      if (h.active) continue;
      try {
        await bouncie.reactivateWebhook(env, h);
        revived.push(h.name || h.id);
      } catch (err) { console.error(`Could not revive webhook ${h.id}`, err); }
    }
    if (revived.length) {
      await audit(env, 'webhook_revived', null, revived.join(', '));
      await sendEmail(env, {
        to: env.ALERT_TO,
        subject: 'Fleet tracker: a Bouncie webhook had gone dead',
        html: renderAlert({
          title: 'Bouncie webhook was inactive',
          vehicle: 'Integration health',
          body: `Bouncie had deactivated ${revived.join(', ')} and it has been switched back on automatically. This is a known Bouncie quirk rather than a problem with the fleet. If it keeps happening, the 6-hourly odometer poll is the backstop and nothing will be missed.`,
          ctx: mailContext(env),
        }),
      });
    }
  } catch (err) { console.error('Webhook health check failed', err); }
  return { checked, revived };
}
