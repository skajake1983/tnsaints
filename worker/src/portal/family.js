/**
 * Family routes: setup, dashboard, children, medical, emergency contacts,
 * claiming children from past evaluations.
 *
 * Every route needs a signed-in parent, and every read or write of family data
 * goes through portal/data.js, where the household check lives inside the SQL.
 * A child id that is not this family's gets the same 404 as one that does not
 * exist.
 *
 * Plain HTML forms, post-redirect-get: a successful POST answers 303 to a page
 * that can be reloaded safely; a failed one re-renders the form with an error
 * summary and the parent's input kept.
 *
 * Audit rows name the account and the record ids — never a child's name, a
 * date of birth, or a word of medical text.
 */

import { audit } from '../auth/staff.js';
import { resolvePlayerId } from '../feedback/players.js';
import { parseLegacyGrade, schoolYearOf } from '../lib/grades.js';
import { googleConfigured } from '../auth/google.js';
import * as data from './data.js';
import { validateGuardian, validateChild, validateMedical, validateContacts } from './forms.js';
import { setupPage, dashboardPage, childPage, contactsPage, accountPage } from './family-pages.js';
import { redirect } from './auth-pages.js';
import { notFoundResponse } from './ui.js';
import { guardianRoutes } from './guardians.js';
import { applyRoutes } from './apply.js';
import { familyEnrollments, getProgram, programOpen } from '../programs/enrollment.js';

const NOTICES = {
  joined: "Welcome — you've joined the family.",
  applied: "Application received. We'll email you when a place in a group is ready.",
  contacts: 'Emergency contacts saved.',
  claimed: 'Added to your family.',
  'not-claimed': "That child couldn't be added. They may already be in a family.",
};
const SAVED = {
  added: 'Child added. Next, answer the medical question below.',
  profile: 'Changes saved.',
  medical: 'Medical answer saved.',
};

/** Paths this module serves, so the router can send signed-out visitors to sign in. */
export function isFamilyPath(pathname) {
  return (
    pathname === '/' ||
    pathname === '/family/setup' ||
    pathname === '/contacts' ||
    pathname === '/account' ||
    pathname === '/children' ||
    pathname.startsWith('/children/') ||
    pathname === '/guardians' ||
    pathname.startsWith('/guardians/') ||
    pathname === '/account/signout-others'
  );
}

/**
 * @returns {Promise<Response|null>} null if no family route matched
 */
export async function familyRoutes({ env, ctx, request, rc, session, pathname, method, readForm }) {
  const accountId = session.accountId;
  const url = new URL(request.url);
  const log = (action, subjectType, subjectId) =>
    ctx.waitUntil(audit(env, { actor: `account:${accountId}`, action, subjectType, subjectId }));

  if (pathname === '/account' && method === 'GET') {
    const google = googleConfigured(env);
    const linked = google
      ? Boolean(
          await env.DB.prepare(`SELECT 1 FROM account_identities WHERE account_id = ?1 AND provider = 'google' LIMIT 1`)
            .bind(accountId)
            .first()
        )
      : false;
    const notice = url.searchParams.get('notice') === 'signedout' ? 'Signed out everywhere else.' : '';
    return accountPage(rc, session, {
      google, googleLinked: linked, sessions: await data.listSessions(env, accountId), notice,
    });
  }

  if (pathname === '/account/signout-others' && method === 'POST') {
    const n = await data.revokeOtherSessions(env, accountId, session.idHash);
    if (n) log('portal.signout_others', 'account', accountId);
    return redirect(rc.url('/account?notice=signedout'));
  }

  const household = await data.getHousehold(env, accountId);

  if (pathname === '/family/setup' && method === 'POST') {
    if (household) return redirect(rc.url('/'));
    return readForm(async (form) => {
      const { values, errors } = validateGuardian(form);
      if (errors.length) return setupPage(rc, session, { values, errors, status: 400 });
      const id = await data.createHousehold(env, accountId, values);
      if (id) log('portal.household_create', 'household', id);
      return redirect(rc.url('/'));
    });
  }

  // Everything below needs a household; without one, the only page is setup.
  if (!household) {
    return method === 'GET' && pathname === '/' ? setupPage(rc, session) : redirect(rc.url('/'));
  }

  if (pathname === '/guardians' || pathname.startsWith('/guardians/')) {
    const response = await guardianRoutes({ env, ctx, request, rc, session, household, pathname, method, readForm });
    if (response) return response;
  }

  if (pathname === '/' && method === 'GET') {
    const [guardians, children, contacts, claimable, enrollments, academy] = await Promise.all([
      data.listGuardians(env, accountId),
      data.listChildren(env, accountId),
      data.listEmergencyContacts(env, accountId),
      data.claimableChildren(env, accountId),
      familyEnrollments(env, accountId),
      getProgram(env, 'academy'),
    ]);
    return dashboardPage(rc, {
      household, guardians, children, contacts, claimable, enrollments,
      academy: academy && programOpen(academy) ? academy : null,
      notice: NOTICES[url.searchParams.get('notice')] || '',
    });
  }

  if (pathname === '/children/new' && method === 'GET') {
    return childPage(rc, {});
  }

  if (pathname === '/children' && method === 'POST') {
    return readForm(async (form) => {
      const { values, errors } = validateChild(form);
      if (errors.length) return childPage(rc, { values, errors, status: 400 });
      const result = await data.createChild(env, accountId, values);
      if (!result.ok) {
        const message = result.reason === 'legacy'
          ? 'This child is already registered under your email from a past evaluation. Use "Add to my family" on your family page instead.'
          : result.reason === 'duplicate'
            ? "You've already added a child with this name."
            : "We couldn't add this child. Please try again.";
        return childPage(rc, { values, errors: [{ id: 'child_name', message }], status: 400 });
      }
      log('portal.child_add', 'player', result.id);
      return redirect(rc.url(`/children/${result.id}?saved=added#medical`));
    });
  }

  if (pathname === '/children/claim' && method === 'POST') {
    return readForm(async (form) => {
      const registrationId = Number(form.get('registration_id'));
      // Only something on this account's own claimable list can be claimed.
      const entry = Number.isInteger(registrationId)
        ? (await data.claimableChildren(env, accountId)).find((c) => Number(c.registration_id) === registrationId)
        : null;
      const playerId = entry
        ? await data.claimChild(env, accountId, registrationId, resolvePlayerId, {
            school: entry.school || null,
            gradeLevel: parseLegacyGrade(entry.grade),
            gradeSchoolYear: parseLegacyGrade(entry.grade) === null ? null : schoolYearOf(new Date(entry.created_at)),
          })
        : null;
      if (playerId) log('portal.child_claim', 'player', playerId);
      return redirect(rc.url(`/?notice=${playerId ? 'claimed' : 'not-claimed'}`));
    });
  }

  const application = await applyRoutes({ env, ctx, request, rc, session, pathname, method, readForm });
  if (application) return application;

  const childMatch = /^\/children\/(\d{1,12})(\/medical)?$/.exec(pathname);
  if (childMatch) {
    const playerId = Number(childMatch[1]);
    const child = await data.getChild(env, accountId, playerId);
    if (!child) return notFoundResponse(rc);

    if (!childMatch[2] && method === 'GET') {
      const medical = await data.getMedical(env, accountId, playerId);
      return childPage(rc, { child, medical, saved: SAVED[url.searchParams.get('saved')] || '' });
    }

    if (!childMatch[2] && method === 'POST') {
      return readForm(async (form) => {
        const { values, errors } = validateChild(form);
        const medical = await data.getMedical(env, accountId, playerId);
        if (errors.length) return childPage(rc, { child, values, errors, medical, status: 400 });
        const result = await data.updateChild(env, accountId, playerId, values);
        if (!result.ok && result.reason === 'duplicate') {
          return childPage(rc, {
            child, values, medical, status: 400,
            errors: [{ id: 'child_name', message: 'Another child in your family already has this name.' }],
          });
        }
        if (!result.ok) return notFoundResponse(rc);
        log('portal.child_update', 'player', playerId);
        return redirect(rc.url(`/children/${playerId}?saved=profile`));
      });
    }

    if (childMatch[2] && method === 'POST') {
      return readForm(async (form) => {
        const { values, errors } = validateMedical(form);
        if (errors.length) {
          const medical = await data.getMedical(env, accountId, playerId);
          return childPage(rc, { child, medical, medicalValues: values, medicalErrors: errors, status: 400 });
        }
        if (!(await data.setMedical(env, accountId, playerId, values))) return notFoundResponse(rc);
        log('portal.medical_update', 'player', playerId);
        return redirect(rc.url(`/children/${playerId}?saved=medical#medical`));
      });
    }
  }

  if (pathname === '/contacts' && method === 'GET') {
    return contactsPage(rc, { contacts: await data.listEmergencyContacts(env, accountId) });
  }

  if (pathname === '/contacts' && method === 'POST') {
    return readForm(async (form) => {
      const { values, errors } = validateContacts(form);
      if (errors.length) return contactsPage(rc, { values, errors, status: 400 });
      await data.replaceEmergencyContacts(env, accountId, values);
      log('portal.contacts_update', 'household', household.id);
      return redirect(rc.url('/?notice=contacts'));
    });
  }

  return null;
}
