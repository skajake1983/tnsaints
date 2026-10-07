/**
 * The board (board:view to read; board:manage for admins; the serving
 * SECRETARY may also record meetings — governance/board.js).
 *
 * Every write is audited with identifiers only. Minutes, motion text and
 * disclosure details are board records and live in their own tables, never in
 * audit_log.
 */

import { can, audit } from '../../auth/staff.js';
import { readForm } from '../../lib/body.js';
import { page, htmlResponse } from '../ui.js';
import {
  BOARD_STYLES, overviewBody, membersBody, meetingsBody, meetingBody, documentsBody, complianceBody, disclosuresBody,
} from '../board-ui.js';
import {
  listMembers, memberFor, maySecretary, validateMember, addMember, endMember, validateMeeting, addMeeting, listMeetings,
  meetingDetail, recordAttendance, cancelMeeting, addMotion, recordVotes, setMotionStatus, minutesStep, addAction,
  setActionStatus, openActions, listDocuments, addDocument, archiveDocument, disclosureStatus, signDisclosure, listCompliance,
  validateCompliance, addCompliance, setComplianceDate, completeCompliance, centralToday,
} from '../../governance/board.js';
import { NAV, denyHtml, seeOther, notFoundPage } from '../nav.js';

const denyBoard = denyHtml('Board', 'The board pages are for board members and academy admins.');
const denyManage = denyHtml('Board', 'Only academy admins change this.');

function boardPage(rc, title, body, status = 200) {
  return htmlResponse(page({ title, principal: rc.principal, nav: NAV, current: '/board', body, extraStyles: BOARD_STYLES }), { status });
}

async function formOf(request) {
  try { return await readForm(request, 64 * 1024); } catch { return null; }
}

/** For writes the secretary may make: admins or the serving secretary, else 403. */
async function secretaryOnly(rc) {
  return (await maySecretary(rc.env, rc.principal, can)) ? null : denyHtml('Board', 'Only the board secretary and academy admins record meetings.')(rc);
}

function log(rc, action, subjectType, subjectId, detail) {
  rc.ctx.waitUntil(audit(rc.env, { actor: rc.principal.email, action, subjectType, subjectId, detail }));
}

export const routes = [
  {
    method: 'GET', path: '/board', cap: 'board:view', deny: denyBoard,
    handler: async (rc) => {
      const year = Number(centralToday().slice(0, 4));
      const [members, meetings, actions, compliance, me] = await Promise.all([
        listMembers(rc.env), listMeetings(rc.env), openActions(rc.env), listCompliance(rc.env), memberFor(rc.env, rc.principal.email),
      ]);
      let myDisclosure = null;
      if (me) myDisclosure = (await disclosureStatus(rc.env, year)).some((s) => s.id === me.id && s.signed_at);
      return boardPage(rc, 'Board', overviewBody({ members, meetings, actions, compliance, myDisclosure, base: rc.base }));
    },
  },
  {
    method: 'GET', path: '/board/members', cap: 'board:view', deny: denyBoard,
    handler: async (rc) => boardPage(rc, 'Board members', membersBody({ members: await listMembers(rc.env),
      canManage: can(rc.principal, 'board:manage'), base: rc.base, message: rc.url.searchParams.get('msg') })),
  },
  {
    method: 'POST', path: '/board/members', cap: 'board:manage', deny: denyManage,
    handler: async (rc) => {
      const form = await formOf(rc.request);
      if (!form) return seeOther(rc.base, '/board/members?msg=invalid');
      const { value, errors } = validateMember(form);
      if (Object.keys(errors).length) {
        return boardPage(rc, 'Board members', membersBody({ members: await listMembers(rc.env), canManage: true, base: rc.base,
          values: value, errors }), 400);
      }
      const id = await addMember(rc.env, value, rc.principal.email);
      log(rc, 'board.member_add', 'board_member', id, { office: value.office });
      return seeOther(rc.base, '/board/members?msg=added');
    },
  },
  {
    method: 'POST', path: /^\/board\/members\/(\d{1,12})\/end$/, cap: 'board:manage', deny: denyManage,
    handler: async (rc, m) => {
      const done = await endMember(rc.env, Number(m[1]));
      if (done) log(rc, 'board.member_end', 'board_member', m[1]);
      return seeOther(rc.base, `/board/members?msg=${done ? 'ended' : 'invalid'}`);
    },
  },
  {
    method: 'GET', path: '/board/meetings', cap: 'board:view', deny: denyBoard,
    handler: async (rc) => boardPage(rc, 'Board meetings', meetingsBody({ meetings: await listMeetings(rc.env),
      canRecord: await maySecretary(rc.env, rc.principal, can), base: rc.base, message: rc.url.searchParams.get('msg') })),
  },
  {
    method: 'POST', path: '/board/meetings', cap: 'board:view', deny: denyBoard,
    handler: async (rc) => {
      const refused = await secretaryOnly(rc);
      if (refused) return refused;
      const form = await formOf(rc.request);
      if (!form) return seeOther(rc.base, '/board/meetings?msg=invalid');
      const { value, errors } = validateMeeting(form);
      if (Object.keys(errors).length) {
        return boardPage(rc, 'Board meetings', meetingsBody({ meetings: await listMeetings(rc.env), canRecord: true, base: rc.base,
          values: value, errors }), 400);
      }
      const id = await addMeeting(rc.env, value, rc.principal.email);
      log(rc, 'board.meeting_add', 'board_meeting', id);
      return seeOther(rc.base, `/board/meetings/${id}?msg=added`);
    },
  },
  {
    method: 'GET', path: /^\/board\/meetings\/(\d{1,12})$/, cap: 'board:view', deny: denyBoard,
    handler: async (rc, m) => {
      const detail = await meetingDetail(rc.env, Number(m[1]));
      if (!detail) return notFoundPage(rc.principal, 'No such meeting');
      return boardPage(rc, detail.meeting.title, meetingBody({ detail, canRecord: await maySecretary(rc.env, rc.principal, can),
        canManage: can(rc.principal, 'board:manage'), base: rc.base, message: rc.url.searchParams.get('msg') }));
    },
  },
  {
    method: 'POST', path: /^\/board\/meetings\/(\d{1,12})\/(attendance|cancel|motions|actions)$/, cap: 'board:view', deny: denyBoard,
    handler: async (rc, m) => {
      const refused = await secretaryOnly(rc);
      if (refused) return refused;
      const meetingId = Number(m[1]);
      const back = (msg) => seeOther(rc.base, `/board/meetings/${meetingId}?msg=${msg}`);
      if (m[2] === 'cancel') {
        if (!can(rc.principal, 'board:manage')) return denyManage(rc);
        const done = await cancelMeeting(rc.env, meetingId);
        if (done) log(rc, 'board.meeting_cancel', 'board_meeting', meetingId);
        return back(done ? 'cancelled' : 'invalid');
      }
      const form = await formOf(rc.request);
      if (!form) return back('invalid');
      if (m[2] === 'attendance') {
        const statuses = {};
        for (const [k, v] of form.entries()) if (/^m\d{1,12}$/.test(k)) statuses[k.slice(1)] = String(v);
        const r = await recordAttendance(rc.env, meetingId, statuses, rc.principal.email);
        if (!r) return back('invalid');
        if (r === 'locked') return back('locked');
        log(rc, 'board.attendance', 'board_meeting', meetingId, { voting: r.voting, present: r.present });
        return back('attendance');
      }
      if (m[2] === 'motions') {
        const id = await addMotion(rc.env, meetingId, form, rc.principal.email);
        if (id) log(rc, 'board.motion_add', 'board_motion', id);
        return back(id ? 'added' : 'invalid');
      }
      const ok = await addAction(rc.env, { meetingId, title: form.get('title'), ownerEmail: form.get('owner_email'),
        dueOn: String(form.get('due_on') || ''), actor: rc.principal.email });
      return back(ok ? 'added' : 'invalid');
    },
  },
  {
    method: 'POST', path: /^\/board\/meetings\/(\d{1,12})\/motions\/(\d{1,12})\/(votes|withdrawn|tabled)$/, cap: 'board:view', deny: denyBoard,
    handler: async (rc, m) => {
      const refused = await secretaryOnly(rc);
      if (refused) return refused;
      const back = (msg) => seeOther(rc.base, `/board/meetings/${m[1]}?msg=${msg}`);
      const motionId = Number(m[2]);
      if (m[3] !== 'votes') {
        const done = await setMotionStatus(rc.env, motionId, m[3]);
        if (done) log(rc, `board.motion_${m[3]}`, 'board_motion', motionId);
        return back(done ? m[3] : 'invalid');
      }
      const form = await formOf(rc.request);
      if (!form) return back('invalid');
      const votes = {};
      const reasons = {};
      for (const [k, v] of form.entries()) {
        if (/^v\d{1,12}$/.test(k)) votes[k.slice(1)] = String(v);
        if (/^r\d{1,12}$/.test(k)) reasons[k.slice(1)] = String(v);
      }
      const result = await recordVotes(rc.env, motionId, votes, reasons, rc.principal.email);
      if (result === 'carried' || result === 'failed') log(rc, `board.motion_${result}`, 'board_motion', motionId);
      return back(result);
    },
  },
  {
    method: 'POST', path: /^\/board\/meetings\/(\d{1,12})\/minutes\/(save|circulate|approve)$/, cap: 'board:view', deny: denyBoard,
    handler: async (rc, m) => {
      const refused = await secretaryOnly(rc);
      if (refused) return refused;
      const form = m[2] === 'save' ? await formOf(rc.request) : null;
      const result = await minutesStep(rc.env, Number(m[1]), m[2], form?.get('minutes'), rc.principal.email);
      if (['saved', 'circulated', 'approved'].includes(result)) log(rc, `board.minutes_${m[2]}`, 'board_meeting', m[1]);
      return seeOther(rc.base, `/board/meetings/${m[1]}?msg=${result}`);
    },
  },
  {
    method: 'POST', path: /^\/board\/actions\/(\d{1,12})\/(done|dropped|open)$/, cap: 'board:view', deny: denyBoard,
    handler: async (rc, m) => {
      const refused = await secretaryOnly(rc);
      if (refused) return refused;
      const form = await formOf(rc.request);
      const meeting = /^\d{1,12}$/.test(String(form?.get('back') || '')) ? `/board/meetings/${form.get('back')}` : '/board';
      const done = await setActionStatus(rc.env, Number(m[1]), m[2], rc.principal.email);
      return seeOther(rc.base, `${meeting}?msg=${done ? 'done' : 'invalid'}`);
    },
  },
  {
    method: 'GET', path: '/board/documents', cap: 'board:view', deny: denyBoard,
    handler: async (rc) => boardPage(rc, 'Board documents', documentsBody({ documents: await listDocuments(rc.env),
      canEdit: await maySecretary(rc.env, rc.principal, can), base: rc.base, message: rc.url.searchParams.get('msg') })),
  },
  {
    method: 'POST', path: '/board/documents', cap: 'board:view', deny: denyBoard,
    handler: async (rc) => {
      const refused = await secretaryOnly(rc);
      if (refused) return refused;
      const form = await formOf(rc.request);
      const result = form ? await addDocument(rc.env, form, rc.principal.email) : 'invalid';
      if (result === 'added') log(rc, 'board.document_add', 'board_document', null);
      return seeOther(rc.base, `/board/documents?msg=${result}`);
    },
  },
  {
    method: 'POST', path: /^\/board\/documents\/(\d{1,12})\/archive$/, cap: 'board:view', deny: denyBoard,
    handler: async (rc, m) => {
      const refused = await secretaryOnly(rc);
      if (refused) return refused;
      const done = await archiveDocument(rc.env, Number(m[1]), rc.principal.email);
      if (done) log(rc, 'board.document_archive', 'board_document', m[1]);
      return seeOther(rc.base, `/board/documents?msg=${done ? 'done' : 'invalid'}`);
    },
  },
  {
    method: 'GET', path: '/board/compliance', cap: 'board:view', deny: denyBoard,
    handler: async (rc) => boardPage(rc, 'Compliance calendar', complianceBody({ items: await listCompliance(rc.env),
      canManage: can(rc.principal, 'board:manage'), base: rc.base, message: rc.url.searchParams.get('msg') })),
  },
  {
    method: 'POST', path: '/board/compliance', cap: 'board:manage', deny: denyManage,
    handler: async (rc) => {
      const form = await formOf(rc.request);
      const v = form ? validateCompliance(form) : null;
      if (v) {
        await addCompliance(rc.env, v);
        log(rc, 'board.compliance_add', 'compliance_item', null, { category: v.category });
      }
      return seeOther(rc.base, `/board/compliance?msg=${v ? 'added' : 'invalid'}`);
    },
  },
  {
    method: 'POST', path: /^\/board\/compliance\/(\d{1,12})\/(date|done)$/, cap: 'board:manage', deny: denyManage,
    handler: async (rc, m) => {
      const id = Number(m[1]);
      let done;
      if (m[2] === 'date') {
        const form = await formOf(rc.request);
        done = await setComplianceDate(rc.env, id, String(form?.get('due_on') || ''));
      } else {
        done = await completeCompliance(rc.env, id, rc.principal.email);
      }
      if (done) log(rc, `board.compliance_${m[2]}`, 'compliance_item', id);
      return seeOther(rc.base, `/board/compliance?msg=${done ? (m[2] === 'date' ? 'saved' : 'done') : 'invalid'}`);
    },
  },
  {
    method: 'GET', path: '/board/disclosures', cap: 'board:view', deny: denyBoard,
    handler: async (rc) => {
      const year = Number(centralToday().slice(0, 4));
      const [status, me] = await Promise.all([disclosureStatus(rc.env, year), memberFor(rc.env, rc.principal.email)]);
      const mine = me ? status.find((s) => s.id === me.id && s.signed_at) || null : null;
      const manage = can(rc.principal, 'board:manage');
      return boardPage(rc, 'Disclosures', disclosuresBody({ year, status: manage ? status : [], mine, isMember: Boolean(me),
        canManage: manage, base: rc.base, message: rc.url.searchParams.get('msg') }));
    },
  },
  {
    method: 'POST', path: '/board/disclosures', cap: 'board:disclose', deny: denyBoard,
    handler: async (rc) => {
      const form = await formOf(rc.request);
      const result = form ? await signDisclosure(rc.env, rc.principal.email, form) : 'invalid';
      // Whether an interest was declared is the board's record, not the audit log's.
      if (result === 'signed') log(rc, 'board.disclosure_signed', 'board_member', null);
      return seeOther(rc.base, `/board/disclosures?msg=${result}`);
    },
  },
];
