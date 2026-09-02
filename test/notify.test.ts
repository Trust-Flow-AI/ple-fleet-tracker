import { describe, expect, it } from 'vitest';
import { escapeHtml, mailContext, normalizePhone, renderDigest, type MailContext } from '../src/notify';

const CTX: MailContext = { boardUrl: 'https://acme.monday.com/boards/123', orgName: 'Acme' };

describe('phone normalization', () => {
  it('handles the ways people actually type numbers', () => {
    expect(normalizePhone('(512) 555-0143')).toBe('+15125550143');
    expect(normalizePhone('512.555.0143')).toBe('+15125550143');
    expect(normalizePhone('1-512-555-0143')).toBe('+15125550143');
    expect(normalizePhone('+15125550143')).toBe('+15125550143');
  });
  it('refuses rather than guessing at junk', () => {
    expect(normalizePhone('555-0143')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('n/a')).toBeNull();
  });
});

describe('digest', () => {
  it('says all clear when nothing is open', () => {
    const { subject, html } = renderDigest([], '2026-09-02', CTX);
    expect(subject).toBe('Fleet: all clear');
    expect(html).toContain('Nothing due today');
  });

  it('leads with the overdue count', () => {
    const { subject, html } = renderDigest([
      { vehicle: 'Truck 3', service: 'Oil & Filter Change', status: 'Overdue', detail: '600 mi over', itemId: '1', priority: 'High' },
      { vehicle: 'Van 1', service: 'Tire Rotation', status: 'Due Soon', detail: '300 mi left', itemId: '2', priority: 'Normal' },
    ], '2026-09-02', CTX);
    expect(subject).toBe('Fleet: 1 overdue, 1 coming due');
    expect(html).toContain('Overdue (1)');
    expect(html).toContain('Coming due (1)');
    expect(html).toContain('https://acme.monday.com/boards/123/pulses/1');
  });

  it('escapes vehicle names so a stray quote cannot break the email', () => {
    const { html } = renderDigest([
      { vehicle: `Mike's "big" truck & trailer`, service: 'Brake Inspection', status: 'Overdue', detail: '1 day over', itemId: '9', priority: 'High' },
    ], '2026-09-02', CTX);
    expect(html).toContain('Mike&#39;s &quot;big&quot; truck &amp; trailer');
    expect(html).not.toContain(`Mike's "big"`);
  });
});

describe('mail context', () => {
  it('strips a trailing slash so board URLs never double up', () => {
    const env = { MONDAY_ACCOUNT_URL: 'https://acme.monday.com/', MONDAY_BOARD_WORKORDERS: '99' };
    expect(mailContext(env as never).boardUrl).toBe('https://acme.monday.com/boards/99');
  });
  it('leaves a clean URL alone', () => {
    const env = { MONDAY_ACCOUNT_URL: 'https://acme.monday.com', MONDAY_BOARD_WORKORDERS: '99' };
    expect(mailContext(env as never).boardUrl).toBe('https://acme.monday.com/boards/99');
  });
});

describe('escapeHtml', () => {
  it('covers all five characters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});
