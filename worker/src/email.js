/**
 * Registration email notifications via Resend.
 *
 * Two messages per registration:
 *   1. An alert to the academy so a coach can follow up and confirm.
 *   2. A receipt to the parent so they know it went through.
 *
 * DESIGN RULE: email must never be able to fail a registration. Every send
 * runs through ctx.waitUntil() after the spot is already committed to D1, and
 * every failure is caught and logged rather than thrown. A Resend outage
 * costs a notification, not a child's place in the session.
 */

import { toCsv, toBase64 } from './http.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Where mail actually goes.
 *
 * Overridable ONLY from .dev.vars, which is gitignored and never uploaded by
 * `wrangler deploy`. Pointed at a local sink, the whole send path — claim,
 * final gate, recipient resolution, state writes — runs end to end in tests
 * without a byte leaving the machine.
 *
 * That path was previously unreachable under test: with no API key configured
 * the drain returned before any of it, so the code deciding WHICH ADDRESS
 * RECEIVES WHICH BODY had no coverage at all.
 */
function endpointFor(env) {
  return env.RESEND_ENDPOINT || RESEND_ENDPOINT;
}

/**
 * Logo is referenced by absolute URL rather than embedded.
 *
 * Data URIs are not an option — Gmail strips them from img src entirely. A
 * hosted URL is the standard for transactional mail, with the tradeoff that
 * clients which block remote images (Outlook desktop, mainly) show alt text
 * instead. Both templates below are therefore built to read correctly with the
 * image missing: the wordmark stays as live text, never baked into the image.
 */
const LOGO_URL = 'https://tnsaints.com/email-logo.png';

function logoImg(size = 56) {
  // Explicit width/height so blocking clients still reserve the right space,
  // and border:0 to stop Outlook drawing a link border around it.
  return `<img src="${LOGO_URL}" width="${size}" height="${size}" alt="Tennessee Saints"
    style="display:block;border:0;outline:none;text-decoration:none;width:${size}px;height:${size}px;" />`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function emailConfigured(env) {
  return Boolean(env.RESEND_API_KEY && env.NOTIFY_EMAIL_FROM && env.NOTIFY_EMAIL_TO);
}

/**
 * Reserve one send against today's budget.
 *
 * Resend's free plan caps at 100 emails/day. Two emails per registration
 * means a full 50-seat day sits exactly on that ceiling, so the budget has to
 * be spent deliberately rather than first-come-first-served: the academy
 * alert is the thing the owner actually asked for, and it must never be the
 * message that gets dropped because a parent receipt spent the last credit.
 *
 * @returns {Promise<boolean>} true if this send is within budget
 */
export async function reserveSend(env, { reserveFloor = 0 } = {}) {
  // NOT `parseInt(...) || 100`. Zero is falsy, so that expression turned
  // EMAIL_DAILY_LIMIT=0 into a limit of 100 — the exact opposite of what it
  // says. Every test suite and the local harness documented 0 as "sending is
  // switched off", so a developer who pasted a real key while trusting that
  // guard would have sent roughly eighty real emails to invented addresses
  // from the academy's domain. Nothing was disabled; only the missing API key
  // was holding it.
  const parsed = parseInt(env.EMAIL_DAILY_LIMIT, 10);
  const limit = Number.isFinite(parsed) ? parsed : 100;
  // Resend's counter is UTC-based, so key the budget the same way.
  const day = new Date().toISOString().slice(0, 10);

  try {
    const row = await env.DB.prepare(
      `INSERT INTO email_budget (day, sent) VALUES (?1, 1)
         ON CONFLICT(day) DO UPDATE SET sent = sent + 1
       RETURNING sent`
    )
      .bind(day)
      .first();

    const used = Number(row?.sent || 0);
    if (used > limit - reserveFloor) {
      console.warn(
        `Email budget guard: ${used}/${limit} used today, reserveFloor=${reserveFloor} — skipping this send.`
      );
      return false;
    }
    return true;
  } catch (err) {
    // Budget bookkeeping must never block the alert itself.
    console.error('Email budget check failed, sending anyway:', err?.message);
    return true;
  }
}

/**
 * Give back a credit reserved by reserveSend() when the send did not happen.
 *
 * reserveSend increments before the network call, so a transient Resend 429
 * during a decision batch burns a credit for a message that never went out.
 * Across fifty near-identical messages that can defer genuinely-deliverable
 * families to the next day for no reason. Refunding on a real failure keeps the
 * counter honest. Floored at zero so it can never go negative.
 */
export async function refundSend(env) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await env.DB.prepare(
      `UPDATE email_budget SET sent = MAX(0, sent - 1) WHERE day = ?1`
    )
      .bind(day)
      .run();
  } catch (err) {
    console.error('Email budget refund failed:', err?.message);
  }
}

async function send(env, { to, subject, html, text, replyTo, attachments }) {
  const payload = {
    from: env.NOTIFY_EMAIL_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  // A plain-text alternative materially helps deliverability for a burst of
  // near-identical messages, which is exactly the shape of a decision batch.
  if (text) payload.text = text;
  if (replyTo) payload.reply_to = replyTo;
  if (attachments) payload.attachments = attachments;

  const res = await fetch(endpointFor(env), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    // A rejected-address error from Resend echoes the address in its body, and
    // this string is both logged (observability, full sampling) and stored in
    // parent_messages.last_error, which the decisions screen displays. Redact
    // anything email-shaped before it leaves this line, so a parent's address
    // never lands in logs or on a shared screen. The comment used to claim this
    // was safe; it was not.
    const detail = (await res.text())
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
      .slice(0, 300);
    throw new Error(`Resend responded ${res.status}: ${detail}`);
  }

  // The provider id is worth keeping: it is what turns "we sent it" into
  // something checkable when a family says nothing arrived.
  try {
    const body = await res.json();
    return body?.id || null;
  } catch {
    return null;
  }
}

/**
 * Send one already-composed message and report the outcome rather than throwing.
 *
 * The batch drain needs to record per-message success or failure and carry on,
 * so an exception here would either abort the whole run or have to be caught at
 * every call site. Budget is NOT reserved inside this function: the drain
 * reserves first so it can put a message back on the queue untouched when the
 * budget runs out, which is different from a send that genuinely failed.
 */
export async function sendComposedMessage(env, { to, subject, html, text, replyTo }) {
  if (!emailConfigured(env)) {
    return { ok: false, error: 'email not configured' };
  }

  try {
    const id = await send(env, { to, subject, html, text, replyTo });
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err?.message || 'send failed' };
  }
}

/**
 * Welcome email for a newly-added staff member.
 *
 * Deliberately NOT a magic link. There is no token in it, no way to sign in
 * that bypasses Microsoft — it points at the plain admin URL and tells the
 * person to sign in with the same @tnsaints.com email and password they already
 * use for Microsoft 365. Two reasons: the security model puts Cloudflare Access
 * and Entra in front of that URL, so a link that skipped them would be a
 * backdoor; and the person is already provisioned in the staff table, so the
 * only thing they need is the address and the instruction.
 *
 * Best-effort: returns {ok} and never throws, so adding a user succeeds even if
 * the mail provider is momentarily down. The row is what grants access; the
 * email is a courtesy.
 */
export async function sendStaffInvite(env, { to, displayName, role }) {
  if (!emailConfigured(env)) return { ok: false, error: 'email not configured' };

  const host = String(env.ADMIN_HOSTNAME || 'admin.tnsaints.com');
  const url = `https://${host}`;
  const contact = env.NOTIFY_EMAIL_TO || 'info@tnsaints.com';
  const roleWord =
    role === 'admin' ? 'an academy admin' : role === 'coach' ? 'a coach' : 'a viewer';

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;color:#13233d;">
    <div style="background:#06255c;color:#fff;padding:16px 18px;border-radius:8px 8px 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:12px;vertical-align:middle;">${logoImg(40)}</td>
        <td style="vertical-align:middle;font-size:18px;font-weight:800;">Tennessee Saints — staff access</td>
      </tr></table>
    </div>
    <div style="border:1px solid #dfe3ea;border-top:0;border-radius:0 0 8px 8px;padding:20px;">
      <p style="margin-top:0;">Hi ${escapeHtml(displayName || 'there')},</p>
      <p>You have been added as <strong>${escapeHtml(roleWord)}</strong> on the Tennessee Saints
      staff site.</p>
      <p style="margin:18px 0;">
        <a href="${url}" style="background:#06255c;color:#fff;text-decoration:none;
          padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block;">Open the staff site</a>
      </p>
      <p>Sign in with your <strong>@tnsaints.com Microsoft 365 email and password</strong> — the same
      login you use for Outlook. There is no separate password to set up.</p>
      <p style="color:#536277;font-size:14px;">The first time you sign in from a browser, Microsoft
      may ask you to confirm your identity (the same multi-factor step it uses elsewhere). That is
      normal. If anything does not work, reply to this email or contact ${escapeHtml(contact)}.</p>
    </div>
    <p style="color:#8a94a6;font-size:12px;text-align:center;margin-top:14px;">
      Tennessee Saints Basketball Academy · staff only</p>
  </div>`;

  const text = [
    `Hi ${displayName || 'there'},`,
    '',
    `You have been added as ${roleWord} on the Tennessee Saints staff site.`,
    '',
    `Open ${url} and sign in with your @tnsaints.com Microsoft 365 email and password`,
    `— the same login you use for Outlook. There is no separate password.`,
    '',
    `The first time you sign in from a browser, Microsoft may ask you to confirm your`,
    `identity; that is normal. Questions: ${contact}.`,
  ].join('\n');

  try {
    const id = await send(env, {
      to,
      subject: 'Your Tennessee Saints staff access',
      html,
      text,
      replyTo: contact,
    });
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err?.message || 'send failed' };
  }
}

function row(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<tr>
    <td style="padding:6px 12px 6px 0;color:#536277;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
    <td style="padding:6px 0;color:#13233d;"><strong>${escapeHtml(value)}</strong></td>
  </tr>`;
}

/**
 * Same as row() but the value is trusted markup rather than escaped text.
 * Only for values built in this file — never for anything a visitor supplied.
 */
function rowHtml(label, html) {
  return `<tr>
    <td style="padding:6px 12px 6px 0;color:#536277;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
    <td style="padding:6px 0;color:#13233d;">${html}</td>
  </tr>`;
}

const VENUE = 'Grassland Heights Baptist Church, 2316 Hillsboro Rd, Franklin, TN 37069';

// Google's documented Maps URL scheme: opens the native app on a phone and the
// web map on a desktop. This is the link a parent taps on Saturday morning, so
// it needs to hand off straight to turn-by-turn rather than to a search page.
const VENUE_MAP_URL =
  'https://www.google.com/maps/search/?api=1&query=' +
  encodeURIComponent(VENUE);

function alertHtml(env, data, result) {
  const isWaitlist = result.status === 'waitlist';
  const banner = isWaitlist
    ? { bg: '#b42318', text: `WAITLIST &middot; position ${escapeHtml(result.position)}` }
    : { bg: '#0b3a8d', text: 'CONFIRMED' };

  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;">
    <div style="background:${banner.bg};color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:12px;vertical-align:middle;">${logoImg(44)}</td>
        <td style="vertical-align:middle;">
          <div style="font-size:13px;letter-spacing:.08em;opacity:.85;">NEW EVALUATION REGISTRATION</div>
          <div style="font-size:20px;font-weight:800;margin-top:2px;">${banner.text}</div>
        </td>
      </tr></table>
    </div>
    <div style="border:1px solid #dfe3ea;border-top:0;border-radius:0 0 8px 8px;padding:18px;">
      <table style="border-collapse:collapse;font-size:14px;width:100%;">
        ${row('Session', data.session_time)}
        ${row('Player', data.player_name)}
        ${row('Grade', data.grade)}
        ${row('Years playing', data.years_experience)}
        ${row('School', data.school)}
        ${row('Parent', data.parent_name)}
        ${row('Parent email', data.parent_email)}
        ${row('Parent phone', data.phone)}
        ${row('Emergency contact', `${data.emergency_contact_name} — ${data.emergency_contact_phone}`)}
        ${row('Medical notes', data.medical_notes)}
        ${row('Highlight link', data.highlight_link)}
        ${row('Photo release', data.photo_release ? 'Granted' : 'DECLINED — do not photograph')}
        ${row('Signed by', data.signature)}
      </table>
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid #dfe3ea;color:#536277;font-size:13px;">
        <strong>Player notes:</strong><br />${escapeHtml(data.player_notes)}
      </div>
      <div style="margin-top:14px;color:#536277;font-size:13px;">
        Reply directly to this email to reach the parent.
      </div>
    </div>
  </div>`;
}

function parentHtml(env, data, result) {
  const isWaitlist = result.status === 'waitlist';
  const eventLabel = env.EVENT_LABEL || 'our upcoming evaluation';
  const siteUrl = (env.SITE_URL || 'https://tnsaints.com').replace(/\/$/, '');
  const cancelUrl = `${siteUrl}/cancel.html?t=${encodeURIComponent(result.cancelToken || '')}`;

  const lead = isWaitlist
    ? `The ${escapeHtml(data.session_time)} session filled up, so <strong>${escapeHtml(data.player_name)} is on the waiting list</strong>. We will email you if a spot opens, or when we schedule another evaluation date.`
    : `<strong>${escapeHtml(data.player_name)} is registered</strong> for the ${escapeHtml(data.session_time)} session. We will follow up by email to confirm details before the date.`;

  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;">
    <div style="background:#0b3a8d;color:#fff;padding:18px;border-radius:8px 8px 0 0;text-align:center;">
      <div style="margin:0 auto 10px;width:72px;">${logoImg(72)}</div>
      <div style="font-size:19px;font-weight:800;">Tennessee Saints Basketball Academy</div>
      <div style="opacity:.85;font-size:14px;margin-top:2px;">${escapeHtml(eventLabel)}</div>
    </div>
    <div style="border:1px solid #dfe3ea;border-top:0;border-radius:0 0 8px 8px;padding:18px;color:#13233d;font-size:15px;line-height:1.55;">
      <p style="margin-top:0;">${lead}</p>
      <table style="border-collapse:collapse;font-size:14px;margin:14px 0;">
        ${row('Session', data.session_time)}
        ${row('Grade', `${data.grade} (this evaluation is open to 4th–6th grade)`)}
        ${rowHtml('Location', `<strong>Grassland Heights Baptist Church</strong><br />
          <a href="${VENUE_MAP_URL}" style="color:#0b3a8d;">2316 Hillsboro Rd, Franklin, TN 37069</a>
          <span style="color:#536277;">&mdash; tap for directions</span>`)}
      </table>

      <!-- Asked here because a family that just registered is the most likely
           person in the world to tell another family. Links rather than an
           attachment: attachments trip spam filters and nobody forwards them. -->
      <div style="background:#f3f5f9;border-radius:10px;padding:14px 16px;margin:18px 0;">
        <strong style="color:#06255c;">Know another family who'd love this?</strong>
        <p style="margin:4px 0 12px;font-size:14px;color:#536277;">
          Spots are limited, so the fastest way to help is to pass it along.
        </p>
        <!-- Ready-to-paste wording. The real barrier to sharing is not finding
             a button, it is a parent thinking "what do I even say?" and closing
             the email. Handing them the sentence removes that entirely. -->
        <p style="margin:0 0 6px;font-size:13px;color:#536277;">Copy and paste this anywhere:</p>
        <div style="background:#fff;border:1px solid #dfe3ea;border-left:3px solid #f5cf00;border-radius:6px;padding:12px 14px;margin:0 0 14px;font-size:14px;line-height:1.55;color:#13233d;">
          Tennessee Saints is hosting a FREE basketball evaluation for 4th&ndash;6th graders &mdash;
          Saturday, August 29, 9&ndash;11 AM in Franklin, TN. Spots are limited and registration
          closes 8/22. https://tnsaints.com
        </div>
        <a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Ftnsaints.com%2F"
           style="display:inline-block;background:#1877f2;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 16px;border-radius:8px;margin:0 6px 6px 0;">Share on Facebook</a>
        <a href="https://tnsaints.com/tnsaints-evaluation-flyer.jpg"
           style="display:inline-block;background:#f5cf00;color:#06255c;text-decoration:none;font-weight:700;font-size:14px;padding:10px 16px;border-radius:8px;margin:0 6px 6px 0;">Download the flyer</a>
      </div>

      <!-- Self-service cancellation. Without an obvious way out, a family whose
           plans change simply does not show, and the spot stays occupied while
           a waitlisted player sits at home. Naming the beneficiary - another
           family - is what makes people actually bother. -->
      <p style="margin:0 0 14px;font-size:14px;color:#13233d;">
        <strong>Plans change.</strong> If your player can't make it,
        <a href="${cancelUrl}" style="color:#0b3a8d;font-weight:700;">release your spot here</a>
        and we'll open it for another family. You can also just reply to this email.
      </p>

      <p style="color:#536277;font-size:13px;margin-bottom:0;">
        Questions? Just reply to this email or reach us at info@tnsaints.com.<br />
        Team over self. Character over stats. Christ over everything.
      </p>
    </div>
  </div>`;
}

/**
 * Final roster, emailed on a schedule after registration closes.
 *
 * Exists so the roster never depends on someone remembering to run a command
 * with a token on the right evening. The token endpoint stays for on-demand
 * pulls; this is the one that matters on event weekend.
 *
 * Never throws — the cron handler passes it to ctx.waitUntil().
 */
export async function sendRosterDigest(env, { reason = 'scheduled' } = {}) {
  let rows;
  try {
    // Deliberately NOT medical_notes or signature.
    //
    // This CSV is emailed daily, all year, to a shared inbox — forwardable,
    // device-cached, long-retained, and outside the audited least-privilege
    // boundary the rest of the system keeps. A child's medical history and
    // typed liability signature have no business in a routine "are seats
    // filling" email. A has_medical_notes flag carries the one thing the gym
    // printout needs (which children have a note to ask Jacob about); the note
    // text stays behind the audited endpoint.
    const res = await env.DB.prepare(
      `SELECT session_time, status, player_name, grade, years_experience,
              parent_name, parent_email, phone, school,
              emergency_contact_name, emergency_contact_phone,
              CASE WHEN medical_notes IS NOT NULL AND TRIM(medical_notes) != ''
                   THEN 'yes' ELSE '' END AS has_medical_notes,
              photo_release, highlight_link, player_notes, created_at
         FROM registrations
        WHERE event_id = ?1
        ORDER BY session_time, status DESC, id`
    )
      .bind(env.EVENT_ID)
      .all();
    rows = res.results || [];
  } catch (err) {
    console.error('Roster digest query failed:', err?.message);
    return;
  }

  // The cron runs daily all year now, so the handler decides whether there is
  // anything worth sending. No registrations for the active event means either
  // no campaign is running or a new event has just been rolled in — either way,
  // a daily "0 of 50" email is noise that trains the owner to ignore it.
  if (rows.length === 0) {
    console.log(JSON.stringify({ event: 'roster_digest_skipped', reason: 'no registrations' }));
    return;
  }

  // Checked after the work check, not before: otherwise an unconfigured Worker
  // logs an error every single day forever, including the eleven months of the
  // year when there is no event running and nothing to send. An alarm that
  // fires constantly is one nobody reads.
  if (!emailConfigured(env)) {
    console.error(
      `Roster digest NOT SENT: ${rows.length} registrations exist but email is not configured.`
    );
    return;
  }

  const confirmed = rows.filter((r) => r.status === 'confirmed');
  const waitlist = rows.filter((r) => r.status === 'waitlist');
  const bySession = (time, status) =>
    rows.filter((r) => r.session_time === time && r.status === status).length;

  const times = String(env.SESSION_TIMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // The cron runs daily through August, so most of these land while
  // registration is still open. Only the one after the deadline is final.
  const closesAt = env.REGISTRATION_CLOSES_AT ? new Date(env.REGISTRATION_CLOSES_AT) : null;
  const windowOpen = Boolean(closesAt && !Number.isNaN(closesAt.getTime()) && new Date() <= closesAt);

  const capacity = parseInt(env.SLOT_CAPACITY, 10) || 25;
  const totalCapacity = capacity * times.length;
  const spotsLeft = Math.max(0, totalCapacity - confirmed.length);

  const cell = 'padding:7px 14px 7px 0;';
  const summaryRows = times
    .map((t) => {
      const taken = bySession(t, 'confirmed');
      const left = Math.max(0, capacity - taken);
      const waiting = bySession(t, 'waitlist');
      const leftCell = left === 0
        ? '<span style="color:#b42318;font-weight:800;">FULL</span>'
        : `<strong style="color:#0b3a8d;">${left} left</strong>`;
      return `<tr style="border-top:1px solid #eef1f6;">
        <td style="${cell}"><strong>${escapeHtml(t)}</strong></td>
        <td style="${cell}">${taken} of ${capacity} registered</td>
        <td style="${cell}">${leftCell}</td>
        <td style="padding:7px 0;color:${waiting ? '#b42318' : '#8a94a6'};">${waiting} waiting</td>
      </tr>`;
    })
    .join('');

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;">
    <div style="background:#0b3a8d;color:#fff;padding:16px 18px;border-radius:8px 8px 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:12px;vertical-align:middle;">${logoImg(44)}</td>
        <td style="vertical-align:middle;">
          <div style="font-size:13px;letter-spacing:.08em;opacity:.85;">${windowOpen ? 'REGISTRATION UPDATE' : 'FINAL ROSTER'}</div>
          <div style="font-size:20px;font-weight:800;margin-top:2px;">${escapeHtml(env.EVENT_LABEL || 'Evaluation')}</div>
        </td>
      </tr></table>
    </div>
    <div style="border:1px solid #dfe3ea;border-top:0;border-radius:0 0 8px 8px;padding:18px;color:#13233d;">
      <p style="margin-top:0;">${
        windowOpen
          ? 'Here is where registration stands today. Full roster attached as a spreadsheet.'
          : 'Registration has closed. Final roster attached as a spreadsheet.'
      }</p>
      <table style="border-collapse:collapse;font-size:14px;width:100%;">${summaryRows}</table>
      <p style="margin:14px 0 0;font-size:15px;">
        <strong>${confirmed.length} of ${totalCapacity}</strong> spots filled &middot;
        <strong style="color:${spotsLeft ? '#0b3a8d' : '#b42318'};">${spotsLeft ? `${spotsLeft} still open` : 'all sessions full'}</strong>${
          waitlist.length ? ` &middot; <strong style="color:#b42318;">${waitlist.length} waiting</strong>` : ''
        }
      </p>
      <p style="color:#536277;font-size:13px;margin-bottom:0;">
        Open roster.csv in Excel or Google Sheets. Print it before Saturday so you
        have the list even without signal at the gym.
      </p>
    </div>
  </div>`;

  const csv = rows.length ? toCsv(rows) : 'no registrations';

  try {
    // Counted against the daily budget like everything else — it was exempt
    // before, which quietly made the budget figure wrong. Given no reserve
    // floor, so it can spend the last credit: this email is the owner's daily
    // visibility and is the wrong thing to starve.
    if (!(await reserveSend(env))) {
      console.error('Roster digest skipped: daily email budget exhausted.');
      return;
    }

    await send(env, {
      to: env.NOTIFY_EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean),
      subject: windowOpen
        ? `Evaluation roster — ${confirmed.length}/${totalCapacity} filled, ${spotsLeft} spots left`
        : `FINAL roster — ${confirmed.length} confirmed, ${waitlist.length} waitlisted`,
      html,
      attachments: [
        { filename: `roster-${env.EVENT_ID}.csv`, content: toBase64(csv) },
      ],
    });
    console.log(JSON.stringify({ event: 'roster_digest_sent', reason, rows: rows.length }));
  } catch (err) {
    console.error('Roster digest send failed:', err?.message);
  }
}

/**
 * "You're off the waiting list" — sent the moment a seat frees.
 *
 * Carries the same cancel link as a normal confirmation, which is what makes
 * automatic promotion safe: a family who has already made other plans releases
 * the seat in one tap and the next person moves up. Without that, auto-promotion
 * just converts a waitlisted family into a no-show.
 */
async function sendPromotionEmail(env, promoted) {
  const siteUrl = (env.SITE_URL || 'https://tnsaints.com').replace(/\/$/, '');
  const cancelUrl = `${siteUrl}/cancel.html?t=${encodeURIComponent(promoted.cancel_token || '')}`;

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;">
    <div style="background:#14663a;color:#fff;padding:18px;border-radius:8px 8px 0 0;text-align:center;">
      <div style="margin:0 auto 10px;width:72px;">${logoImg(72)}</div>
      <div style="font-size:19px;font-weight:800;">A spot just opened &mdash; your player is in</div>
    </div>
    <div style="border:1px solid #dfe3ea;border-top:0;border-radius:0 0 8px 8px;padding:18px;color:#13233d;font-size:15px;line-height:1.55;">
      <p style="margin-top:0;">
        Good news &mdash; a place came free for the ${escapeHtml(promoted.session_time)} session, and
        <strong>${escapeHtml(promoted.player_name)}</strong> was next on the waiting list.
        You are now confirmed.
      </p>
      <table style="border-collapse:collapse;font-size:14px;margin:14px 0;">
        ${row('Session', promoted.session_time)}
        ${rowHtml('Location', `<strong>Grassland Heights Baptist Church</strong><br />
          <a href="${VENUE_MAP_URL}" style="color:#0b3a8d;">2316 Hillsboro Rd, Franklin, TN 37069</a>
          <span style="color:#536277;">&mdash; tap for directions</span>`)}
      </table>
      <p style="margin:0 0 14px;font-size:14px;">
        <strong>If plans have already changed</strong>, please
        <a href="${cancelUrl}" style="color:#0b3a8d;font-weight:700;">release the spot here</a>
        so the next family on the list can take it.
      </p>
      <p style="color:#536277;font-size:13px;margin-bottom:0;">
        Questions? Just reply to this email or reach us at info@tnsaints.com.<br />
        Team over self. Character over stats. Christ over everything.
      </p>
    </div>
  </div>`;

  try {
    if (await reserveSend(env)) {
      await send(env, {
        to: promoted.parent_email,
        subject: `You're in — ${promoted.player_name}, ${promoted.session_time} evaluation`,
        html,
        replyTo: env.NOTIFY_EMAIL_TO.split(',')[0].trim(),
      });
    }
  } catch (err) {
    console.error('Failed to send promotion email:', err?.message);
  }
}

/**
 * Told when a family releases a spot.
 *
 * Carries the waitlist depth for that specific session, because that is the
 * decision the message exists to prompt: a freed seat with someone waiting is
 * a phone call worth making today, and a freed seat with nobody waiting is
 * just information.
 *
 * Promotion is automatic — cancelByToken() moves the longest-waiting family in
 * that session into the freed seat and emails them. What makes that safe
 * rather than reckless is that the promoted family receives their own cancel
 * link, so one who has already made other plans releases the seat in a tap and
 * the next person moves up.
 */
export async function sendCancellationAlert(env, result) {
  if (!emailConfigured(env)) {
    console.error('Cancellation alert skipped: email is not configured.');
    return;
  }

  const r = result.registration;
  const waiting = result.waitlistForSession;

  // Tell the promoted family first. They are the ones with a decision to make,
  // and their seat is already committed in the database either way.
  if (result.promoted) {
    await sendPromotionEmail(env, result.promoted);
  }

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;">
    <div style="background:#b42318;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;">
      <div style="font-size:13px;letter-spacing:.08em;opacity:.85;">SPOT RELEASED</div>
      <div style="font-size:20px;font-weight:800;margin-top:2px;">${escapeHtml(r.session_time)} is open again</div>
    </div>
    <div style="border:1px solid #dfe3ea;border-top:0;border-radius:0 0 8px 8px;padding:18px;">
      <table style="border-collapse:collapse;font-size:14px;">
        ${row('Player', r.player_name)}
        ${row('Grade', r.grade)}
        ${row('Parent', r.parent_name)}
        ${row('Session', r.session_time)}
      </table>
      ${
        result.reason
          ? `<div style="margin-top:14px;padding:12px 14px;background:#f3f5f9;border-left:3px solid #b42318;border-radius:6px;font-size:14px;color:#13233d;">
               <strong style="display:block;color:#536277;font-size:12px;letter-spacing:.06em;">REASON GIVEN</strong>
               ${escapeHtml(result.reason)}
             </div>`
          : '<p style="margin-top:14px;color:#8a94a6;font-size:13px;">No reason given.</p>'
      }
      <p style="margin:16px 0 0;font-size:15px;">
        ${
          result.promoted
            ? `<strong style="color:#14663a;">${escapeHtml(result.promoted.player_name)} was moved up from the waiting list into that spot</strong> and has been emailed.
               ${waiting > 0 ? `${waiting} still waiting for ${escapeHtml(r.session_time)}.` : 'Nobody else is waiting for that session.'}`
            : waiting > 0
              ? `<strong style="color:#b42318;">${waiting} ${waiting === 1 ? 'family is' : 'families are'} waiting for ${escapeHtml(r.session_time)}</strong>, but nobody was promoted &mdash; worth a look.`
              : 'Nobody is on the waiting list for that session, so the spot is simply open again.'
        }
      </p>
    </div>
  </div>`;

  try {
    if (await reserveSend(env)) {
      await send(env, {
        to: env.NOTIFY_EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean),
        subject: `Spot released: ${r.player_name} — ${r.session_time}${waiting ? ` (${waiting} waiting)` : ''}`,
        html,
      });
    }
  } catch (err) {
    console.error('Failed to send cancellation alert:', err?.message);
  }
}

/**
 * Fire both notifications. Never throws — callers pass this to ctx.waitUntil()
 * after the registration is already durable.
 */
export async function sendRegistrationEmails(env, data, result) {
  if (!emailConfigured(env)) {
    // Loud, because silently not notifying anyone is the worst failure here.
    console.error(
      'EMAIL NOT CONFIGURED — registration stored but nobody was notified. ' +
        'Set RESEND_API_KEY, NOTIFY_EMAIL_FROM, NOTIFY_EMAIL_TO.'
    );
    return;
  }

  const label = result.status === 'waitlist' ? 'WAITLIST' : 'Registration';
  const subject = `${label}: ${data.player_name} — ${data.session_time} (${data.grade})`;

  // The academy alert goes first and spends budget down to the last credit:
  // this is the notification the whole feature exists for.
  try {
    if (await reserveSend(env)) {
      await send(env, {
        to: env.NOTIFY_EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean),
        subject,
        html: alertHtml(env, data, result),
        replyTo: data.parent_email,
      });
    } else {
      console.error(
        `EMAIL BUDGET EXHAUSTED — no alert sent for ${data.player_name} (${data.session_time}). ` +
          'Registration IS saved; pull the roster via /api/admin/registrations.'
      );
    }
  } catch (err) {
    console.error('Failed to send academy alert email:', err?.message);
  }

  if (String(env.SEND_PARENT_CONFIRMATION || 'true').toLowerCase() === 'false') return;

  // Parent receipts stop early, leaving a reserve so that a late rush of
  // registrations still produces alerts. Losing a receipt is a minor UX cost;
  // losing an alert means a family signs up and nobody ever contacts them.
  const reserveFloor = parseInt(env.EMAIL_ALERT_RESERVE, 10) || 25;
  if (!(await reserveSend(env, { reserveFloor }))) {
    // No address in the log. Constitution: PII never in logs. The player name
    // is enough for staff to know which receipt was deferred, and a first name
    // is far less linkable than an email.
    console.warn(`Skipped parent receipt for ${data.player_name} to protect alert budget.`);
    return;
  }

  try {
    await send(env, {
      to: data.parent_email,
      subject:
        result.status === 'waitlist'
          ? `Waiting list — ${data.player_name}, Tennessee Saints evaluation`
          : `You're registered — ${data.player_name}, Tennessee Saints evaluation`,
      html: parentHtml(env, data, result),
      replyTo: env.NOTIFY_EMAIL_TO.split(',')[0].trim(),
    });
  } catch (err) {
    console.error('Failed to send parent confirmation email:', err?.message);
  }
}
