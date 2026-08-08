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

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

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
async function reserveSend(env, { reserveFloor = 0 } = {}) {
  const limit = parseInt(env.EMAIL_DAILY_LIMIT, 10) || 100;
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

async function send(env, { to, subject, html, replyTo }) {
  const payload = {
    from: env.NOTIFY_EMAIL_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (replyTo) payload.reply_to = replyTo;

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    // Body may contain the address; log status and provider message only.
    const detail = await res.text();
    throw new Error(`Resend responded ${res.status}: ${detail.slice(0, 300)}`);
  }
}

function row(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<tr>
    <td style="padding:6px 12px 6px 0;color:#536277;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
    <td style="padding:6px 0;color:#13233d;"><strong>${escapeHtml(value)}</strong></td>
  </tr>`;
}

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
        ${row('Location', 'Grassland Heights Baptist Church, 2316 Hillsboro Rd, Franklin, TN 37069')}
      </table>
      <p style="color:#536277;font-size:13px;margin-bottom:0;">
        Questions? Just reply to this email or reach us at info@tnsaints.com.<br />
        Team over self. Character over stats. Christ over everything.
      </p>
    </div>
  </div>`;
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
    console.warn(`Skipped parent receipt for ${data.parent_email} to protect alert budget.`);
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
