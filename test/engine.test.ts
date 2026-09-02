import { describe, expect, it } from 'vitest';
import {
  addMonths, daysBetween, evaluate, isCriticalDtc, localDayAndHour, priorityFor,
  type EvalRule, type EvalVehicle,
} from '../src/engine';

const TAG_COL = 'date_tag';

const vehicle = (odometer: number | null, dates: Record<string, string | null> = {}): EvalVehicle => ({
  mondayItemId: '100',
  odometer,
  dateColumns: dates,
});

const rule = (over: Partial<EvalRule> = {}): EvalRule => ({
  id: 'r1',
  name: 'Oil & Filter Change',
  triggerOn: 'Whichever First',
  miles: 5000,
  months: 6,
  warnMiles: 500,
  warnDays: 14,
  watchDateCol: null,
  active: true,
  appliesTo: [],
  ...over,
});

describe('date arithmetic', () => {
  it('adds months on the calendar', () => {
    expect(addMonths('2026-01-15', 6)).toBe('2026-07-15');
    expect(addMonths('2026-09-02', 12)).toBe('2027-09-02');
  });

  it('clamps to the end of a shorter month rather than rolling over', () => {
    // Naive date math turns Jan 31 + 1 month into Mar 3. That would silently
    // push a due date past the month it belongs in.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29'); // leap year
    expect(addMonths('2026-05-31', 1)).toBe('2026-06-30');
  });

  it('counts days across a DST boundary without drifting', () => {
    // US DST starts 2026-03-08. Working in UTC keeps this at exactly 31 days.
    expect(daysBetween('2026-02-25', '2026-03-28')).toBe(31);
    expect(daysBetween('2026-09-02', '2026-09-02')).toBe(0);
    expect(daysBetween('2026-09-10', '2026-09-02')).toBe(-8);
  });
});

describe('mileage intervals', () => {
  it('stays quiet well inside the window', () => {
    const r = evaluate(vehicle(41000), rule({ months: null }), { lastDoneOdo: 40000, lastDoneAt: null }, '2026-09-02');
    expect(r.applicable).toBe(true);
    expect(r.due).toBe(false);
    expect(r.dueOdo).toBe(45000);
    expect(r.milesRemaining).toBe(4000);
  });

  it('opens once inside the warning window but not yet overdue', () => {
    const r = evaluate(vehicle(44600), rule({ months: null }), { lastDoneOdo: 40000, lastDoneAt: null }, '2026-09-02');
    expect(r.due).toBe(true);
    expect(r.overdue).toBe(false);
    expect(priorityFor(r)).toBe('Normal');
    expect(r.reason).toContain('400 mi to go');
  });

  it('flags overdue past the due odometer', () => {
    const r = evaluate(vehicle(46200), rule({ months: null }), { lastDoneOdo: 40000, lastDoneAt: null }, '2026-09-02');
    expect(r.due).toBe(true);
    expect(r.overdue).toBe(true);
    expect(priorityFor(r)).toBe('High');
    expect(r.reason).toContain('1200 mi overdue');
  });

  it('will not evaluate mileage without a baseline', () => {
    const r = evaluate(vehicle(41000), rule({ months: null }), { lastDoneOdo: null, lastDoneAt: null }, '2026-09-02');
    expect(r.applicable).toBe(false);
    expect(r.reason).toBe('no mileage baseline yet');
  });

  it('will not evaluate mileage without an odometer reading', () => {
    const r = evaluate(vehicle(null), rule({ months: null }), { lastDoneOdo: 40000, lastDoneAt: null }, '2026-09-02');
    expect(r.applicable).toBe(false);
    expect(r.reason).toBe('no odometer reading for this vehicle');
  });
});

describe('whichever comes first', () => {
  it('fires on time even when the truck has barely moved', () => {
    // A truck that sat all summer still needs its oil changed.
    const r = evaluate(vehicle(40100), rule(), { lastDoneOdo: 40000, lastDoneAt: '2026-02-20' }, '2026-08-20');
    expect(r.due).toBe(true);
    expect(r.overdue).toBe(true);
    expect(r.dueDate).toBe('2026-08-20');
    expect(r.milesRemaining).toBe(4900); // nowhere near due on mileage
  });

  it('fires on mileage even when the date is far off', () => {
    const r = evaluate(vehicle(44900), rule(), { lastDoneOdo: 40000, lastDoneAt: '2026-08-01' }, '2026-09-02');
    expect(r.due).toBe(true);
    expect(r.overdue).toBe(false);
  });

  it('ignores the date side when the rule is mileage only', () => {
    const r = evaluate(
      vehicle(40100),
      rule({ triggerOn: 'Mileage Only' }),
      { lastDoneOdo: 40000, lastDoneAt: '2020-01-01' },
      '2026-09-02',
    );
    expect(r.due).toBe(false);
    expect(r.daysRemaining).toBeNull();
  });

  it('ignores the mileage side when the rule is date only', () => {
    const r = evaluate(
      vehicle(99999),
      rule({ triggerOn: 'Date Only' }),
      { lastDoneOdo: 40000, lastDoneAt: '2026-08-25' },
      '2026-09-02',
    );
    expect(r.due).toBe(false);
    expect(r.milesRemaining).toBeNull();
  });
});

describe('expiry-date rules (tag, insurance, inspection)', () => {
  it('opens inside the lead time', () => {
    const r = evaluate(
      vehicle(50000, { [TAG_COL]: '2026-10-01' }),
      rule({ watchDateCol: TAG_COL, warnDays: 45, miles: null, months: null }),
      { lastDoneOdo: null, lastDoneAt: null },
      '2026-09-02',
    );
    expect(r.due).toBe(true);
    expect(r.overdue).toBe(false);
    expect(r.daysRemaining).toBe(29);
    expect(r.dueDate).toBe('2026-10-01');
  });

  it('reports how long something has been expired', () => {
    const r = evaluate(
      vehicle(50000, { [TAG_COL]: '2026-08-01' }),
      rule({ watchDateCol: TAG_COL, warnDays: 45, miles: null, months: null }),
      { lastDoneOdo: null, lastDoneAt: null },
      '2026-09-02',
    );
    expect(r.overdue).toBe(true);
    expect(r.reason).toBe('expired 32 days ago');
  });

  it('stays quiet outside the lead time', () => {
    const r = evaluate(
      vehicle(50000, { [TAG_COL]: '2027-06-01' }),
      rule({ watchDateCol: TAG_COL, warnDays: 45, miles: null, months: null }),
      { lastDoneOdo: null, lastDoneAt: null },
      '2026-09-02',
    );
    expect(r.due).toBe(false);
  });

  it('does not invent a due date when no expiry is on file', () => {
    const r = evaluate(
      vehicle(50000, { [TAG_COL]: null }),
      rule({ watchDateCol: TAG_COL, warnDays: 45, miles: null, months: null }),
      { lastDoneOdo: null, lastDoneAt: null },
      '2026-09-02',
    );
    expect(r.applicable).toBe(false);
    expect(r.reason).toContain('no date on file');
  });
});

describe('applicability', () => {
  it('skips paused rules', () => {
    const r = evaluate(vehicle(99999), rule({ active: false }), { lastDoneOdo: 0, lastDoneAt: '2000-01-01' }, '2026-09-02');
    expect(r.applicable).toBe(false);
    expect(r.reason).toBe('rule is paused');
  });

  it('never schedules a fault-code rule', () => {
    const r = evaluate(vehicle(99999), rule({ triggerOn: 'Fault Code' }), { lastDoneOdo: 0, lastDoneAt: '2000-01-01' }, '2026-09-02');
    expect(r.applicable).toBe(false);
    expect(r.reason).toBe('event-driven rule');
  });

  it('honours a vehicle allow-list', () => {
    const restricted = rule({ appliesTo: ['200', '300'] });
    expect(evaluate(vehicle(99999), restricted, { lastDoneOdo: 0, lastDoneAt: '2000-01-01' }, '2026-09-02').applicable).toBe(false);
    const applies = evaluate({ ...vehicle(99999), mondayItemId: '200' }, restricted, { lastDoneOdo: 0, lastDoneAt: '2000-01-01' }, '2026-09-02');
    expect(applies.applicable).toBe(true);
  });

  it('skips a rule with no usable interval at all', () => {
    const r = evaluate(vehicle(99999), rule({ miles: null, months: null }), { lastDoneOdo: 0, lastDoneAt: '2000-01-01' }, '2026-09-02');
    expect(r.applicable).toBe(false);
    expect(r.reason).toBe('rule has no usable interval');
  });
});

describe('critical fault codes', () => {
  const prefixes = ['P0A', 'P0300', 'P0217', 'U0100'];
  it('catches misfires, overheats and lost-comms', () => {
    expect(isCriticalDtc('P0300', prefixes)).toBe(true);
    expect(isCriticalDtc('p0217', prefixes)).toBe(true);
    expect(isCriticalDtc(' P0A80 ', prefixes)).toBe(true);
    expect(isCriticalDtc('U0100', prefixes)).toBe(true);
  });
  it('leaves routine codes to the normal queue', () => {
    expect(isCriticalDtc('P0420', prefixes)).toBe(false); // lazy catalytic converter
    expect(isCriticalDtc('P0455', prefixes)).toBe(false); // loose gas cap
  });
});

describe('digest scheduling', () => {
  it('resolves 6am Chicago in daylight saving time', () => {
    // 2026-07-15 11:00 UTC == 06:00 CDT
    expect(localDayAndHour(new Date('2026-07-15T11:00:00Z'), 'America/Chicago'))
      .toEqual({ day: '2026-07-15', hour: 6 });
    expect(localDayAndHour(new Date('2026-07-15T12:00:00Z'), 'America/Chicago').hour).toBe(7);
  });

  it('resolves 6am Chicago in standard time', () => {
    // 2026-12-15 12:00 UTC == 06:00 CST — this is why there are two cron firings.
    expect(localDayAndHour(new Date('2026-12-15T12:00:00Z'), 'America/Chicago'))
      .toEqual({ day: '2026-12-15', hour: 6 });
    expect(localDayAndHour(new Date('2026-12-15T11:00:00Z'), 'America/Chicago').hour).toBe(5);
  });

  it('reports the local day, not the UTC day, late at night', () => {
    // 2026-09-03 02:00 UTC is still 2026-09-02 in Chicago.
    expect(localDayAndHour(new Date('2026-09-03T02:00:00Z'), 'America/Chicago').day).toBe('2026-09-02');
  });
});
