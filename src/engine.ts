/**
 * The due-date engine.
 *
 * Deliberately pure: no database, no network, no clock of its own. Everything
 * it needs is passed in, so the whole thing is unit-testable and you can reason
 * about "why did this open?" without replaying a webhook.
 */

export type TriggerOn = 'Whichever First' | 'Mileage Only' | 'Date Only' | 'Fault Code';

export interface EvalRule {
  id: string;
  name: string;
  triggerOn: TriggerOn;
  miles: number | null;
  months: number | null;
  warnMiles: number;
  warnDays: number;
  /** When set, the due date comes from this Fleet—Vehicles date column instead of an interval. */
  watchDateCol: string | null;
  active: boolean;
  /** Empty = applies to every active vehicle. */
  appliesTo: string[];
}

export interface EvalVehicle {
  mondayItemId: string;
  odometer: number | null;
  /** Fleet—Vehicles date column id -> YYYY-MM-DD */
  dateColumns: Record<string, string | null>;
}

export interface EvalState {
  lastDoneOdo: number | null;
  lastDoneAt: string | null; // YYYY-MM-DD
}

export interface EvalResult {
  applicable: boolean;
  due: boolean;
  overdue: boolean;
  dueOdo: number | null;
  dueDate: string | null;
  milesRemaining: number | null;
  daysRemaining: number | null;
  reason: string;
}

const NOT_APPLICABLE = (reason: string): EvalResult => ({
  applicable: false, due: false, overdue: false,
  dueOdo: null, dueDate: null, milesRemaining: null, daysRemaining: null, reason,
});

// ---------------------------------------------------------------------------
// Date helpers. All UTC — Monday date columns are plain calendar dates and we
// must not let the Worker's timezone shift them by a day.
// ---------------------------------------------------------------------------

export function toDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseDay(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

/** Calendar-correct month arithmetic, clamping to the end of short months. */
export function addMonths(day: string, months: number): string {
  const d = parseDay(day);
  const targetMonth = d.getUTCMonth() + Math.round(months);
  const probe = new Date(Date.UTC(d.getUTCFullYear(), targetMonth, 1));
  const lastDayOfTarget = new Date(
    Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return toDayString(
    new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), Math.min(d.getUTCDate(), lastDayOfTarget))),
  );
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function evaluate(
  vehicle: EvalVehicle,
  rule: EvalRule,
  state: EvalState,
  today: string,
): EvalResult {
  if (!rule.active) return NOT_APPLICABLE('rule is paused');

  // Fault-code rules are opened by the MIL webhook, never by the schedule.
  if (rule.triggerOn === 'Fault Code') return NOT_APPLICABLE('event-driven rule');

  if (rule.appliesTo.length > 0 && !rule.appliesTo.includes(vehicle.mondayItemId)) {
    return NOT_APPLICABLE('rule does not apply to this vehicle');
  }

  // --- Mode A: the due date is a fixed expiry on the vehicle (tag, insurance,
  // inspection). No mileage component, and no interval arithmetic.
  if (rule.watchDateCol) {
    const dueDate = vehicle.dateColumns[rule.watchDateCol] ?? null;
    if (!dueDate) {
      return NOT_APPLICABLE(`no date on file in vehicle column ${rule.watchDateCol}`);
    }
    const daysRemaining = daysBetween(today, dueDate);
    const due = daysRemaining <= rule.warnDays;
    return {
      applicable: true,
      due,
      overdue: daysRemaining < 0,
      dueOdo: null,
      dueDate,
      milesRemaining: null,
      daysRemaining,
      reason: due
        ? daysRemaining < 0
          ? `expired ${Math.abs(daysRemaining)} days ago`
          : `expires in ${daysRemaining} days (warn at ${rule.warnDays})`
        : `expires in ${daysRemaining} days`,
    };
  }

  // --- Mode B: recurring interval measured from the last completion.
  const useMiles = rule.triggerOn !== 'Date Only' && rule.miles !== null && rule.miles > 0;
  const useDate = rule.triggerOn !== 'Mileage Only' && rule.months !== null && rule.months > 0;

  if (!useMiles && !useDate) return NOT_APPLICABLE('rule has no usable interval');

  let dueOdo: number | null = null;
  let milesRemaining: number | null = null;
  if (useMiles) {
    if (state.lastDoneOdo === null) return NOT_APPLICABLE('no mileage baseline yet');
    if (vehicle.odometer === null) return NOT_APPLICABLE('no odometer reading for this vehicle');
    dueOdo = state.lastDoneOdo + rule.miles!;
    milesRemaining = dueOdo - vehicle.odometer;
  }

  let dueDate: string | null = null;
  let daysRemaining: number | null = null;
  if (useDate) {
    if (!state.lastDoneAt) return NOT_APPLICABLE('no date baseline yet');
    dueDate = addMonths(state.lastDoneAt, rule.months!);
    daysRemaining = daysBetween(today, dueDate);
  }

  const mileageDue = milesRemaining !== null && milesRemaining <= rule.warnMiles;
  const dateDue = daysRemaining !== null && daysRemaining <= rule.warnDays;
  const mileageOverdue = milesRemaining !== null && milesRemaining <= 0;
  const dateOverdue = daysRemaining !== null && daysRemaining <= 0;

  const due = mileageDue || dateDue;
  const overdue = mileageOverdue || dateOverdue;

  const bits: string[] = [];
  if (milesRemaining !== null) {
    bits.push(
      milesRemaining <= 0
        ? `${Math.abs(Math.round(milesRemaining))} mi overdue`
        : `${Math.round(milesRemaining)} mi to go`,
    );
  }
  if (daysRemaining !== null) {
    bits.push(
      daysRemaining <= 0
        ? `${Math.abs(daysRemaining)} days overdue`
        : `${daysRemaining} days to go`,
    );
  }

  return {
    applicable: true, due, overdue, dueOdo, dueDate, milesRemaining, daysRemaining,
    reason: bits.join(', ') || 'no signal',
  };
}

/**
 * Which side of the warning window we are on decides both the Monday status
 * label and how loudly we shout about it.
 */
export function priorityFor(result: EvalResult): 'High' | 'Normal' {
  return result.overdue ? 'High' : 'Normal';
}

export function isCriticalDtc(code: string, criticalPrefixes: readonly string[]): boolean {
  const c = code.trim().toUpperCase();
  return criticalPrefixes.some((p) => c.startsWith(p.toUpperCase()));
}

/** Local calendar date in an IANA zone, for "is it 6am in Chicago yet". */
export function localDayAndHour(now: Date, timeZone: string): { day: string; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    // Intl can render midnight as "24" in some runtimes.
    hour: Number(parts.hour) % 24,
  };
}
