/**
 * Co-guardians: inviting, accepting, removing, leaving.
 *
 * A guardian sees and changes everything about a family's children, so every
 * step is deliberate:
 *   - only the OWNER invites or removes, and only after a recent sign-in;
 *   - the invitation is a single-use, 7-day token in the URL fragment, stored
 *     as a hash, and its landing page is inert (a mail scanner accepts nothing);
 *   - accepting requires being signed in as the INVITED address, which proves
 *     the invitee controls that mailbox — a forwarded email is not enough;
 *   - one family per account: someone already in a family cannot be pulled into
 *     another one.
 * Both the invitation email and the acceptance page say plainly what a
 * guardian can see.
 */

import { randomToken, keyedHash } from '../lib/crypto.js';
import { rateLimit } from '../lib/ratelimit.js';
import { inlineScriptCsp } from '../lib/csp.js';
import { normEmail } from '../auth/access.js';
import { audit } from '../auth/staff.js';
import { sendHouseholdInvite } from '../email.js';
import { portalOrigin, maskEmail } from '../auth/magic.js';
import * as data from './data.js';
import { guardiansPage, inviteLandingBody, INVITE_SCRIPT, inviteMessagePage } from './family-pages.js';
import { redirect } from './auth-pages.js';
import { portalPage, portalResponse, notFoundResponse } from './ui.js';

const INVITE_DAYS = 7;
const MAX_PENDING = 3;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;

const NOTICES = {
  invited: 'Invitation sent. It works for 7 days.',
  cancelled: 'Invitation cancelled.',
  removed: 'Guardian removed. They can no longer see your family.',
};

function signInAgain(rc) {
  return inviteMessagePage(rc, {
    title: 'Please sign in again',
    text: 'For your security, managing guardians needs a recent sign-in. Sign out, sign in again, then try once more.',
    status: 403,
  });
}

/** GET /invite — the inert landing page. Works signed in or out. */
export async function inviteLanding(rc) {
  return portalResponse(portalPage({ rc, title: "You've been invited", body: inviteLandingBody(rc) }), {
    headers: { 'Content-Security-Policy': await inlineScriptCsp(INVITE_SCRIPT) },
  });
}

/** POST /invite/accept */
export async function acceptInvitation(env, ctx, rc, session, form) {
  const expired = () =>
    inviteMessagePage(rc, {
      title: 'This invitation has expired',
      text: 'Invitations work once and expire after 7 days. Ask the person who invited you to send a new one.',
    });

  const token = String(form.get('t') || '');
  if (!TOKEN_SHAPE.test(token)) return expired();
  const tokenHash = await keyedHash(env, 'invite', token);
  const invite = await data.findInvite(env, tokenHash);
  if (!invite) return expired();
  const masked = maskEmail(invite.invited_email_norm);

  if (!session) {
    return inviteMessagePage(rc, {
      title: 'Sign in to accept',
      text: `This invitation was sent to ${masked}. Sign in with that email address, then open the invitation link from your email again.`,
      status: 200,
    });
  }
  if (normEmail(session.email) !== invite.invited_email_norm) {
    return inviteMessagePage(rc, {
      title: 'This invitation is for someone else',
      text: `It was sent to ${masked}, and you're signed in with a different address. Sign out, sign in as ${masked}, then open the link again.`,
      status: 403,
    });
  }
  if (await data.getHousehold(env, session.accountId)) {
    return inviteMessagePage(rc, {
      title: "You're already part of a family",
      text: 'An account can belong to one family on the portal. If you need to switch, email info@tnsaints.com and we will help.',
      status: 409,
    });
  }
  if (!(await data.acceptInvite(env, session.accountId, tokenHash))) return expired();
  ctx.waitUntil(
    audit(env, {
      actor: `account:${session.accountId}`,
      action: 'portal.invite_accept',
      subjectType: 'household',
      subjectId: invite.household_id,
    })
  );
  return redirect(rc.url('/?notice=joined'));
}

/**
 * /guardians routes, for a signed-in parent who has a household.
 * @returns {Promise<Response|null>}
 */
export async function guardianRoutes({ env, ctx, request, rc, session, household, pathname, method, readForm }) {
  const accountId = session.accountId;
  const isOwner = household.role === 'owner';
  const log = (action, subjectType, subjectId) =>
    ctx.waitUntil(audit(env, { actor: `account:${accountId}`, action, subjectType, subjectId }));
  const render = async (extra = {}) =>
    guardiansPage(rc, session, {
      household,
      guardians: await data.listGuardians(env, accountId),
      invites: isOwner ? await data.listPendingInvites(env, accountId) : [],
      ...extra,
    });

  if (pathname === '/guardians' && method === 'GET') {
    return render({ notice: NOTICES[new URL(request.url).searchParams.get('notice')] || '' });
  }

  if (pathname === '/guardians/invite' && method === 'POST') {
    if (!isOwner) return notFoundResponse(rc);
    if (!session.recentAuth) return signInAgain(rc);
    return readForm(async (form) => {
      const typed = String(form.get('invite_email') || '').trim();
      const emailNorm = normEmail(typed);
      const fail = (message) => render({ values: { email: typed }, errors: [{ id: 'invite_email', message }], status: 400 });

      if (!EMAIL_SHAPE.test(emailNorm) || emailNorm.length > 254) return fail('Enter an email address like name@example.com');
      if (emailNorm === normEmail(session.email)) return fail("That's your own address.");
      const guardians = await data.listGuardians(env, accountId);
      if (guardians.some((g) => normEmail(g.email) === emailNorm)) return fail('That person is already a guardian.');
      const pending = await data.listPendingInvites(env, accountId);
      if (pending.length >= MAX_PENDING && !pending.some((p) => p.invited_email_norm === emailNorm)) {
        return fail(`You can have ${MAX_PENDING} invitations waiting at once. Cancel one first.`);
      }
      const limit = await rateLimit(env, [
        { scope: 'invite-household-day', subject: String(household.id), limit: 10, windowSeconds: 24 * 60 * 60 },
      ]);
      if (!limit.allowed) return fail("You've sent a lot of invitations today. Please try again tomorrow.");

      const token = randomToken(32);
      const created = await data.createInvite(env, accountId, {
        tokenHash: await keyedHash(env, 'invite', token),
        emailNorm,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      });
      if (!created) return notFoundResponse(rc);
      const me = guardians.find((g) => Number(g.account_id) === accountId);
      ctx.waitUntil(
        sendHouseholdInvite(env, {
          to: typed,
          inviterName: me?.display_name || '',
          familyName: household.display_name || '',
          url: `${portalOrigin(env)}${rc.url('/invite')}#t=${token}`,
          days: INVITE_DAYS,
        }).then((r) => {
          if (!r.ok) console.error(JSON.stringify({ event: 'invite_not_sent', budget: Boolean(r.budget) }));
        })
      );
      log('portal.invite_create', 'household', household.id);
      return redirect(rc.url('/guardians?notice=invited'));
    });
  }

  if (pathname === '/guardians/invite/cancel' && method === 'POST') {
    if (!isOwner) return notFoundResponse(rc);
    return readForm(async (form) => {
      if (await data.revokeInvite(env, accountId, normEmail(form.get('email')))) {
        log('portal.invite_cancel', 'household', household.id);
      }
      return redirect(rc.url('/guardians?notice=cancelled'));
    });
  }

  if (pathname === '/guardians/remove' && method === 'POST') {
    if (!isOwner) return notFoundResponse(rc);
    if (!session.recentAuth) return signInAgain(rc);
    return readForm(async (form) => {
      const target = Number(form.get('account_id'));
      if (!Number.isInteger(target) || !(await data.removeGuardian(env, accountId, target))) {
        return notFoundResponse(rc);
      }
      log('portal.guardian_remove', 'account', target);
      return redirect(rc.url('/guardians?notice=removed'));
    });
  }

  if (pathname === '/guardians/leave' && method === 'POST') {
    if (isOwner) return notFoundResponse(rc);
    if (await data.leaveHousehold(env, accountId)) log('portal.household_leave', 'household', household.id);
    return redirect(rc.url('/'));
  }

  return null;
}
