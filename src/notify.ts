/**
 * Outbound notifications: email via Resend, SMS via Twilio.
 *
 * Every function here swallows its own errors and returns a boolean. A failed
 * text message must never roll back a work order — the work order in Monday is
 * the durable record, notifications are the courtesy layer on top.
 */

import type { Env } from './config';

export async function sendEmail(
  env: Env,
  opts: { to: string | string[]; subject: string; html: string; replyTo?: string },
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('sendEmail skipped: RESEND_API_KEY is not set');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: Array.isArray(opts.to) ? opts.to : [opts.to],
        subject: opts.subject,
        html: opts.html,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      console.error('Resend rejected the message', res.status, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('sendEmail failed', err);
    return false;
  }
}

export async function sendSms(env: Env, to: string, body: string): Promise<boolean> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
    console.warn('sendSms skipped: Twilio credentials are not set');
    return false;
  }
  const normalized = normalizePhone(to);
  if (!normalized) {
    console.warn(`sendSms skipped: could not normalize phone "${to}"`);
    return false;
  }
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        // Keep it inside one segment where possible; drivers read these on a job site.
        body: new URLSearchParams({ To: normalized, From: env.TWILIO_FROM, Body: body.slice(0, 320) }),
      },
    );
    if (!res.ok) {
      console.error('Twilio rejected the message', res.status, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('sendSms failed', err);
    return false;
  }
}

/** Best-effort E.164. Assumes US/Canada when no country code is present. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits.length >= 11 ? digits : null;
  const d = digits.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Where the work order board lives, so emails can link into it. Passed in
 * rather than hardcoded: the account URL and board ID are deployment secrets,
 * which is what lets this repository be public.
 */
export interface MailContext {
  /** e.g. https://acme.monday.com/boards/1234567890 */
  boardUrl: string;
  /** Name shown in the email's eyebrow, e.g. "Pure Light Electric". */
  orgName?: string;
}

export function mailContext(env: Env): MailContext {
  const base = (env.MONDAY_ACCOUNT_URL ?? '').replace(/\/+$/, '');
  return { boardUrl: `${base}/boards/${env.MONDAY_BOARD_WORKORDERS}` };
}

const SHELL = (title: string, inner: string, ctx: MailContext) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2430;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:10px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin-bottom:6px;">${escapeHtml(ctx.orgName ?? 'Fleet')} &middot; Maintenance</div>
    <h1 style="margin:0 0 20px;font-size:21px;line-height:1.3;">${escapeHtml(title)}</h1>
    ${inner}
    <p style="margin:26px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
      Sent automatically by the fleet tracker. Work orders live on the
      <a href="${escapeHtml(ctx.boardUrl)}" style="color:#0073ea;">Maintenance &amp; Renewals</a> board.
    </p>
  </div>
</body></html>`;

export interface DigestLine {
  vehicle: string;
  service: string;
  status: string;
  detail: string;
  itemId: string;
  priority: string;
}

export function renderDigest(
  lines: DigestLine[],
  today: string,
  ctx: MailContext,
): { subject: string; html: string } {
  const overdue = lines.filter((l) => l.status === 'Overdue');
  const soon = lines.filter((l) => l.status !== 'Overdue');

  const subject = overdue.length
    ? `Fleet: ${overdue.length} overdue, ${soon.length} coming due`
    : soon.length
      ? `Fleet: ${soon.length} coming due`
      : 'Fleet: all clear';

  if (!lines.length) {
    return {
      subject,
      html: SHELL(
        'Nothing due today',
        `<p style="margin:0;font-size:15px;line-height:1.6;color:#374151;">Every vehicle is inside its service window and no registrations, insurance policies or inspections are approaching expiry. Next check tomorrow morning.</p>`,
        ctx,
      ),
    };
  }

  const table = (title: string, rows: DigestLine[], accent: string) =>
    rows.length
      ? `<h2 style="margin:22px 0 10px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:${accent};">${escapeHtml(title)} (${rows.length})</h2>
         <table style="width:100%;border-collapse:collapse;font-size:14px;">
           ${rows
             .map(
               (r) => `<tr style="border-bottom:1px solid #eef0f3;">
             <td style="padding:9px 8px 9px 0;vertical-align:top;">
               <a href="${ctx.boardUrl}/pulses/${r.itemId}" style="color:#0073ea;text-decoration:none;font-weight:600;">${escapeHtml(r.service)}</a>
               <div style="color:#6b7280;font-size:13px;margin-top:2px;">${escapeHtml(r.vehicle)}</div>
             </td>
             <td style="padding:9px 0;text-align:right;vertical-align:top;white-space:nowrap;color:#374151;">${escapeHtml(r.detail)}</td>
           </tr>`,
             )
             .join('')}
         </table>`
      : '';

  return {
    subject,
    html: SHELL(
      `Fleet status — ${today}`,
      table('Overdue', overdue, '#c0392b') + table('Coming due', soon, '#b45309'),
      ctx,
    ),
  };
}

export function renderAlert(opts: {
  title: string;
  vehicle: string;
  body: string;
  itemId?: string;
  ctx: MailContext;
}): string {
  const link = opts.itemId
    ? `<p style="margin:18px 0 0;"><a href="${opts.ctx.boardUrl}/pulses/${opts.itemId}" style="display:inline-block;background:#0073ea;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;">Open the work order</a></p>`
    : '';
  return SHELL(
    opts.title,
    `<p style="margin:0 0 10px;font-size:15px;"><strong>${escapeHtml(opts.vehicle)}</strong></p>
     <p style="margin:0;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(opts.body)}</p>${link}`,
    opts.ctx,
  );
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
