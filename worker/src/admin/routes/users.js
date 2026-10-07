/**
 * Staff accounts: the Users page, add or change a person, (de)activate, and
 * resend the welcome email. All staff:manage.
 */

import { json } from '../../http.js';
import { audit, listStaff, addOrUpdateStaff, setStaffStatus, getStaff } from '../../auth/staff.js';
import { page, adminHeaders } from '../ui.js';
import { usersBody, USERS_STYLES, usersCsp } from '../staff-ui.js';
import { sendStaffInvite } from '../../email.js';
import { NAV, denyHtml, denyJson } from '../nav.js';

const denyUsers = denyJson('Only academy admins can manage users.');

async function readJsonBody(request) {
  try {
    return { body: await request.json() };
  } catch {
    return { error: json({ ok: false, error: 'Could not read that request.' }, { status: 400 }) };
  }
}

export const routes = [
  {
    method: 'GET', path: '/users', cap: 'staff:manage',
    deny: denyHtml('Users', 'Only academy admins can manage users.'),
    handler: ({ env, principal }) => renderUsers(env, principal),
  },
  {
    method: 'POST', path: '/api/staff', cap: 'staff:manage', deny: denyUsers,
    handler: ({ request, env, ctx, principal }) => handleStaffUpsert(request, env, ctx, principal),
  },
  {
    method: 'POST', path: /^\/api\/staff\/(deactivate|activate)$/, cap: 'staff:manage', deny: denyUsers,
    handler: ({ request, env, ctx, principal }, m) => handleStaffStatus(request, env, ctx, principal, m[1] === 'activate'),
  },
  {
    method: 'POST', path: '/api/staff/reinvite', cap: 'staff:manage', deny: denyUsers,
    handler: ({ request, env, ctx, principal }) => handleStaffReinvite(request, env, ctx, principal),
  },
];

async function renderUsers(env, principal) {
  const staff = await listStaff(env);
  // The Access model is not something the Worker can read from Cloudflare, so
  // it is a declared config value. Set ACCESS_EMAIL_MODE=domain once the Access
  // policy admits the whole @tnsaints.com domain; until then the screen tells
  // the admin to also touch the dashboard for each person.
  const accessMode = String(env.ACCESS_EMAIL_MODE || '').trim() === 'domain' ? 'domain' : 'individual';

  return new Response(
    page({
      title: 'Users',
      principal,
      nav: NAV,
      current: '/users',
      extraStyles: USERS_STYLES,
      body: usersBody({ staff, me: principal.email, accessMode }),
    }),
    { headers: adminHeaders({ 'Content-Security-Policy': await usersCsp() }) }
  );
}

async function handleStaffUpsert(request, env, ctx, principal) {
  const { body, error } = await readJsonBody(request);
  if (error) return error;

  const result = await addOrUpdateStaff(env, {
    email: body.email,
    displayName: body.display_name,
    authorLabel: body.author_label,
    role: body.role,
  });
  if (!result.ok) {
    return json(result, { status: 400 });
  }

  ctx.waitUntil(
    audit(env, {
      actor: principal.email,
      action: result.created ? 'staff.add' : 'staff.update',
      subjectType: 'staff',
      subjectId: result.email,
      detail: { role: result.role, reactivated: Boolean(result.reactivated) },
    })
  );

  // Welcome email, best-effort, on create (or when explicitly asked). Never
  // blocks the add — the row is what grants access; the email is a courtesy.
  let invited;
  if (body.send_invite && (result.created || body.send_invite === true)) {
    const sent = await sendStaffInvite(env, {
      to: result.email,
      displayName: String(body.display_name || '').trim(),
      role: result.role,
    });
    invited = Boolean(sent.ok);
  }

  return json({ ...result, invited });
}

async function handleStaffStatus(request, env, ctx, principal, activate) {
  const { body, error } = await readJsonBody(request);
  if (error) return error;

  const result = await setStaffStatus(env, { email: body.email, active: activate });
  if (!result.ok) {
    return json(result, { status: 400 });
  }
  ctx.waitUntil(
    audit(env, {
      actor: principal.email,
      action: activate ? 'staff.activate' : 'staff.deactivate',
      subjectType: 'staff',
      subjectId: result.email,
    })
  );
  return json(result);
}

async function handleStaffReinvite(request, env, ctx, principal) {
  const { body, error } = await readJsonBody(request);
  if (error) return error;
  const target = await getStaff(env, body.email);
  if (!target) {
    return json({ ok: false, error: 'That person is not on the staff list.' }, { status: 404 });
  }
  const sent = await sendStaffInvite(env, {
    to: target.email_norm,
    displayName: target.display_name,
    role: target.role,
  });
  ctx.waitUntil(
    audit(env, {
      actor: principal.email,
      action: 'staff.reinvite',
      subjectType: 'staff',
      subjectId: target.email_norm,
    })
  );
  if (sent.budget) {
    return json(
      { ok: false, error: 'Today’s email allowance is used up. Try again tomorrow, or tell them the site address directly.' },
      { status: 429 }
    );
  }
  if (!sent.ok) {
    return json({ ok: false, error: 'Email could not be sent right now. Tell them the site address directly.' }, { status: 502 });
  }
  return json({ ok: true });
}
