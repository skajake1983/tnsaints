/**
 * The CRM screens (crm:view to read, crm:write to change, crm:export for the
 * audited CSV, crm:admin to merge, anonymize and import), and the Inbox of
 * website inquiries.
 *
 * Audited (identifiers only — never staff notes, never names): exports,
 * merges, anonymizations, links to a family, imports, do-not-contact changes
 * and contacts added by hand. Everyday work (moving cards, logging calls,
 * tasks) is recorded on the CRM's own timeline with who did it.
 */

import { can, audit } from '../../auth/staff.js';
import { readForm } from '../../lib/body.js';
import { toCsv } from '../../http.js';
import { page, htmlResponse, adminHeaders } from '../ui.js';
import { inboxBody, INBOX_STYLES } from '../inbox-ui.js';
import {
  CRM_STYLES, boardBody, listBody, contactBody, familyBody, tasksBody, customersBody, newContactBody, importBody,
} from '../crm-ui.js';
import {
  PIPELINES, CONTACT_KINDS, TASK_VIEWS, allStages, owners as staffOwners, board, moveCard, listContacts, contactDetail,
  householdDetail, logActivity, setOwner, setDoNotContact, validateNewContact, createContact, listTasks, taskCounts,
  createTask, setTaskStatus, customers, mergeContacts, anonymizeContact, linkContactToFamily, exportRows,
} from '../../crm/store.js';
import { reconcileCrm } from '../../crm/reconcile.js';
import { previewImport, runImport } from '../../crm/import.js';
import { NAV, denyHtml, seeOther, notFoundPage } from '../nav.js';

const denyCrm = denyHtml('CRM', 'The CRM is limited to academy admins.');
const denyCrmAdmin = denyHtml('CRM', 'Merging, anonymizing and importing are limited to CRM administrators.');

/** Where a form may send you back to: a CRM page, never anywhere else. */
const SAFE_BACK = /^\/crm(?:\/[a-z0-9/-]*)?(?:\?[A-Za-z0-9=&_:.%@+-]*)?$/;
function backTo(form, fallback, msg) {
  const raw = String(form?.get('back') || '');
  const path = SAFE_BACK.test(raw) ? raw : fallback;
  return `${path}${path.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`;
}

async function formOf(request) {
  try {
    return await readForm(request, 16 * 1024);
  } catch {
    return null;
  }
}

function crmPage(rc, title, body, status = 200) {
  return htmlResponse(page({ title, principal: rc.principal, nav: NAV, current: '/crm', body, extraStyles: CRM_STYLES }), { status });
}

const flags = (principal) => ({
  canWrite: can(principal, 'crm:write'), canAdmin: can(principal, 'crm:admin'), canExport: can(principal, 'crm:export'),
});

function listFilters(url) {
  const kind = url.searchParams.get('kind') || '';
  const stage = url.searchParams.get('stage') || '';
  return {
    q: String(url.searchParams.get('q') || '').slice(0, 80),
    kind: CONTACT_KINDS.includes(kind) ? kind : '',
    stage: /^[a-z]{1,20}:[a-z_]{1,30}$/.test(stage) ? stage : '',
    owner: String(url.searchParams.get('owner') || '').slice(0, 254),
    dnc: url.searchParams.get('dnc') === '1',
  };
}

export const routes = [
  // --- Inbox -----------------------------------------------------------------
  {
    method: 'GET', path: '/inbox', cap: 'crm:view',
    deny: denyHtml('Inbox', 'The inbox is limited to academy admins.'),
    handler: async ({ env, principal, url, base }) => {
      const status = url.searchParams.get('status') === 'handled' ? 'handled' : 'new';
      const { results } = await env.DB.prepare(
        `SELECT i.id, i.purpose, i.fields, i.message, i.received_at, i.status,
                c.name, c.email, c.phone, c.household_id
           FROM crm_inquiries i LEFT JOIN crm_contacts c ON c.id = i.contact_id
          WHERE i.status = ?1 ORDER BY i.received_at DESC LIMIT 100`
      ).bind(status).all();
      return htmlResponse(page({ title: 'Inbox', principal, nav: NAV, current: '/crm',
        body: inboxBody({ rows: results || [], status, canWrite: can(principal, 'crm:write'), base }),
        extraStyles: INBOX_STYLES }));
    },
  },
  {
    method: 'POST', path: /^\/inbox\/(\d{1,12})\/handled$/, cap: 'crm:write', deny: denyHtml('Inbox'),
    handler: async ({ env, ctx, principal, base }, m) => {
      const now = new Date().toISOString();
      const res = await env.DB.prepare(
        `UPDATE crm_inquiries SET status = 'handled', handled_by = ?2, handled_at = ?3 WHERE id = ?1 AND status = 'new'`
      ).bind(Number(m[1]), principal.email, now).run();
      if (res.meta.changes) {
        ctx.waitUntil(audit(env, { actor: principal.email, action: 'crm.inquiry_handled', subjectType: 'inquiry',
          subjectId: m[1] }));
      }
      return seeOther(base, '/inbox');
    },
  },

  // --- Pipeline board -----------------------------------------------------------
  {
    method: 'GET', path: '/crm', cap: 'crm:view', deny: denyCrm,
    handler: async (rc) => {
      const { env, principal, url, base } = rc;
      const wanted = url.searchParams.get('pipeline');
      const pipeline = PIPELINES.includes(wanted) ? wanted : 'family';
      const owner = String(url.searchParams.get('owner') || '').slice(0, 254);
      const [stages, owners, cards] = await Promise.all([allStages(env), staffOwners(env), board(env, pipeline, { owner })]);
      return crmPage(rc, 'CRM', boardBody({ pipeline, stages: stages.get(pipeline), cards, owners, owner,
        ...flags(principal), base, message: url.searchParams.get('msg') }));
    },
  },
  {
    method: 'POST', path: /^\/crm\/cards\/(\d{1,12})\/move$/, cap: 'crm:write', deny: denyCrm,
    handler: async ({ request, env, principal, base }, m) => {
      const form = await formOf(request);
      const stage = String(form?.get('stage') || '');
      const result = /^[a-z_]{1,30}$/.test(stage) ? await moveCard(env, { id: Number(m[1]), stage, actor: principal.email }) : 'invalid';
      return seeOther(base, backTo(form, '/crm', result));
    },
  },

  // --- Contacts list and CSV ---------------------------------------------------------
  {
    method: 'GET', path: '/crm/list', cap: 'crm:view', deny: denyCrm,
    handler: async (rc) => {
      const { env, principal, url, base } = rc;
      const filters = listFilters(url);
      const [stages, owners, rows] = await Promise.all([allStages(env), staffOwners(env), listContacts(env, filters)]);
      return crmPage(rc, 'CRM contacts', listBody({ rows, filters, stages, owners, ...flags(principal), base }));
    },
  },
  {
    method: 'GET', path: '/crm/list.csv', cap: 'crm:export',
    deny: denyHtml('CRM', 'Downloading the contact list is limited to academy admins.'),
    handler: async ({ env, ctx, principal, url }) => {
      const filters = listFilters(url);
      const rows = exportRows(await listContacts(env, filters));
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'crm.export', subjectType: 'crm_contacts',
        detail: { rows: rows.length, filtered: Object.keys(filters).filter((k) => filters[k]) } }));
      const today = new Date().toISOString().slice(0, 10);
      return new Response(rows.length ? toCsv(rows) : 'name,kind,email,phone\r\n', {
        headers: adminHeaders({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="tnsaints-crm-contacts-${today}.csv"`,
        }),
      });
    },
  },

  // --- One contact -------------------------------------------------------------------
  {
    method: 'GET', path: '/crm/contacts/new', cap: 'crm:write', deny: denyCrm,
    handler: async (rc) => crmPage(rc, 'Add a contact', newContactBody({ owners: await staffOwners(rc.env), ...flags(rc.principal),
      base: rc.base })),
  },
  {
    method: 'POST', path: '/crm/contacts/new', cap: 'crm:write', deny: denyCrm,
    handler: async (rc) => {
      const { request, env, ctx, principal, base } = rc;
      const form = await formOf(request);
      if (!form) return seeOther(base, '/crm/contacts/new');
      const { value, errors } = validateNewContact(form);
      if (Object.keys(errors).length) {
        return crmPage(rc, 'Add a contact', newContactBody({ values: value, errors, owners: await staffOwners(env),
          ...flags(principal), base }), 400);
      }
      const { result, id } = await createContact(env, value, principal.email);
      if (result === 'created') {
        ctx.waitUntil(audit(env, { actor: principal.email, action: 'crm.contact_create', subjectType: 'crm_contact', subjectId: id }));
        return seeOther(base, `/crm/contacts/${id}?msg=created`);
      }
      if (result === 'exists' && id) return seeOther(base, `/crm/contacts/${id}?msg=exists`);
      return crmPage(rc, 'Add a contact', newContactBody({ values: value, errors: { owner: 'Choose someone on staff, or nobody.' },
        owners: await staffOwners(env), ...flags(principal), base }), 400);
    },
  },
  {
    method: 'GET', path: /^\/crm\/contacts\/(\d{1,12})$/, cap: 'crm:view', deny: denyCrm,
    handler: async (rc, m) => {
      const { env, principal, url, base } = rc;
      await reconcileCrm(env);
      const [detail, stages, owners] = await Promise.all([contactDetail(env, Number(m[1])), allStages(env), staffOwners(env)]);
      if (!detail) return notFoundPage(principal, 'No such contact');
      return crmPage(rc, detail.contact.name || 'Contact', contactBody({ detail, stages, owners, ...flags(principal), base,
        message: url.searchParams.get('msg') }));
    },
  },
  {
    method: 'POST', path: /^\/crm\/contacts\/(\d{1,12})\/(activity|owner|dnc|link)$/, cap: 'crm:write', deny: denyCrm,
    handler: async ({ request, env, ctx, principal, base }, m) => {
      const contactId = Number(m[1]);
      const fallback = `/crm/contacts/${contactId}`;
      const form = await formOf(request);
      if (!form) return seeOther(base, `${fallback}?msg=invalid`);
      let result;
      if (m[2] === 'activity') {
        result = await logActivity(env, { contactId, kind: String(form.get('kind') || ''), body: form.get('body'),
          occurredOn: String(form.get('occurred_on') || ''), actor: principal.email });
      } else if (m[2] === 'owner') {
        result = await setOwner(env, { contactId, owner: String(form.get('owner') || ''), actor: principal.email });
      } else if (m[2] === 'dnc') {
        result = await setDoNotContact(env, { contactId, on: form.get('on') === '1', actor: principal.email });
        if (result === 'saved') {
          ctx.waitUntil(audit(env, { actor: principal.email, action: 'crm.dnc', subjectType: 'crm_contact', subjectId: contactId,
            detail: { on: form.get('on') === '1' } }));
        }
      } else {
        const linked = await linkContactToFamily(env, { contactId, guardianEmail: String(form.get('guardian_email') || ''),
          actor: principal.email });
        result = linked.result;
        if (result === 'linked') {
          ctx.waitUntil(audit(env, { actor: principal.email, action: 'crm.link', subjectType: 'crm_contact', subjectId: contactId,
            detail: { household: linked.householdId } }));
          await reconcileCrm(env);
          return seeOther(base, `/crm/families/${linked.householdId}?msg=linked`);
        }
      }
      return seeOther(base, backTo(form, fallback, result));
    },
  },
  {
    method: 'POST', path: /^\/crm\/contacts\/(\d{1,12})\/(merge|anonymize)$/, cap: 'crm:admin', deny: denyCrmAdmin,
    handler: async ({ request, env, ctx, principal, base }, m) => {
      const contactId = Number(m[1]);
      const form = await formOf(request);
      if (m[2] === 'merge') {
        const into = String(form?.get('into_id') || '').trim();
        const intoId = /^\d{1,12}$/.test(into) ? Number(into) : 0;
        const result = await mergeContacts(env, { fromId: contactId, intoId, actor: principal.email });
        if (result !== 'merged') return seeOther(base, `/crm/contacts/${contactId}?msg=invalid`);
        ctx.waitUntil(audit(env, { actor: principal.email, action: 'crm.merge', subjectType: 'crm_contact', subjectId: intoId,
          detail: { merged: contactId } }));
        return seeOther(base, `/crm/contacts/${intoId}?msg=merged`);
      }
      if (form?.get('confirm') !== 'yes') return seeOther(base, `/crm/contacts/${contactId}?msg=confirm`);
      const result = await anonymizeContact(env, { id: contactId });
      if (result === 'anonymized') {
        ctx.waitUntil(audit(env, { actor: principal.email, action: 'crm.anonymize', subjectType: 'crm_contact', subjectId: contactId }));
      }
      return seeOther(base, `/crm/contacts/${contactId}?msg=${result === 'anonymized' ? 'anonymized' : 'invalid'}`);
    },
  },

  // --- One family ----------------------------------------------------------------------
  {
    method: 'GET', path: /^\/crm\/families\/(\d{1,12})$/, cap: 'crm:view', deny: denyCrm,
    handler: async (rc, m) => {
      const { env, principal, url, base } = rc;
      await reconcileCrm(env);
      const [detail, stages, owners] = await Promise.all([householdDetail(env, Number(m[1])), allStages(env), staffOwners(env)]);
      if (!detail) return notFoundPage(principal, 'No such family');
      return crmPage(rc, detail.household.display_name || 'Family', familyBody({ detail, stages, owners, ...flags(principal),
        base, message: url.searchParams.get('msg') }));
    },
  },
  {
    method: 'POST', path: /^\/crm\/families\/(\d{1,12})\/(activity|owner|dnc)$/, cap: 'crm:write', deny: denyCrm,
    handler: async ({ request, env, ctx, principal, base }, m) => {
      const householdId = Number(m[1]);
      const fallback = `/crm/families/${householdId}`;
      const form = await formOf(request);
      if (!form) return seeOther(base, `${fallback}?msg=invalid`);
      let result;
      if (m[2] === 'activity') {
        result = await logActivity(env, { householdId, kind: String(form.get('kind') || ''), body: form.get('body'),
          occurredOn: String(form.get('occurred_on') || ''), actor: principal.email });
      } else if (m[2] === 'owner') {
        result = await setOwner(env, { householdId, owner: String(form.get('owner') || ''), actor: principal.email });
      } else {
        result = await setDoNotContact(env, { householdId, on: form.get('on') === '1', actor: principal.email });
        if (result === 'saved') {
          ctx.waitUntil(audit(env, { actor: principal.email, action: 'crm.dnc', subjectType: 'household', subjectId: householdId,
            detail: { on: form.get('on') === '1' } }));
        }
      }
      return seeOther(base, backTo(form, fallback, result));
    },
  },

  // --- Tasks ----------------------------------------------------------------------------
  {
    method: 'GET', path: '/crm/tasks', cap: 'crm:view', deny: denyCrm,
    handler: async (rc) => {
      const { env, principal, url, base } = rc;
      const wanted = url.searchParams.get('view');
      const view = TASK_VIEWS.includes(wanted) ? wanted : 'today';
      const owner = String(url.searchParams.get('owner') || '').slice(0, 254);
      const [rows, counts, owners] = await Promise.all([listTasks(env, { view, owner }), taskCounts(env, { owner }), staffOwners(env)]);
      return crmPage(rc, 'CRM tasks', tasksBody({ view, rows, counts, owners, owner, ...flags(principal), base,
        message: url.searchParams.get('msg') }));
    },
  },
  {
    method: 'POST', path: '/crm/tasks', cap: 'crm:write', deny: denyCrm,
    handler: async ({ request, env, principal, base }) => {
      const form = await formOf(request);
      const id = (k) => (/^\d{1,12}$/.test(String(form?.get(k) || '')) ? Number(form.get(k)) : null);
      const result = form
        ? await createTask(env, { title: form.get('title'), dueOn: String(form.get('due_on') || ''),
          owner: String(form.get('owner') || ''), contactId: id('contact_id'), householdId: id('household_id'),
          actor: principal.email })
        : 'invalid';
      return seeOther(base, backTo(form, '/crm/tasks', result === 'created' ? 'task-created' : 'invalid'));
    },
  },
  {
    method: 'POST', path: /^\/crm\/tasks\/(\d{1,12})\/(done|cancelled|open)$/, cap: 'crm:write', deny: denyCrm,
    handler: async ({ request, env, principal, base }, m) => {
      const form = await formOf(request);
      const changed = await setTaskStatus(env, { id: Number(m[1]), status: m[2], actor: principal.email });
      return seeOther(base, backTo(form, '/crm/tasks', changed ? 'task-updated' : 'not-found'));
    },
  },

  // --- Customers and import --------------------------------------------------------------
  {
    method: 'GET', path: '/crm/customers', cap: 'crm:view', deny: denyCrm,
    handler: async (rc) => {
      const [rows, owners] = await Promise.all([customers(rc.env), staffOwners(rc.env)]);
      return crmPage(rc, 'CRM customers', customersBody({ rows, owners, ...flags(rc.principal), base: rc.base }));
    },
  },
  {
    method: 'GET', path: '/crm/import', cap: 'crm:admin', deny: denyCrmAdmin,
    handler: async (rc) => crmPage(rc, 'CRM import', importBody({ preview: await previewImport(rc.env), ...flags(rc.principal),
      base: rc.base, message: rc.url.searchParams.get('msg') })),
  },
  {
    method: 'POST', path: '/crm/import', cap: 'crm:admin', deny: denyCrmAdmin,
    handler: async (rc) => {
      const { env, ctx, principal } = rc;
      const result = await runImport(env);
      ctx.waitUntil(audit(env, { actor: principal.email, action: 'crm.import', subjectType: 'crm_contacts', detail: result }));
      return crmPage(rc, 'CRM import', importBody({ preview: await previewImport(env), ...flags(principal), base: rc.base,
        result }));
    },
  },
];
