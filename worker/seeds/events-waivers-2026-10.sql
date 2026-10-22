-- Seed: the event waiver and the tournament team entry agreement (2026-10-22).
--
-- Not a migration: data for production, applied once after migrations
-- 022-026, with the owner's go (2026-10-22):
--   npx wrangler d1 execute tnsaints --remote --file=./seeds/events-waivers-2026-10.sql
-- Safe to re-run: neither row is added twice.
--
-- The texts: waivers/event-v1.md and waivers/tournament-team-v1.md, both
-- approved by the owner on 2026-10-21 as drafted; body below each heading as
-- plain text, generated from the markdown the way academy-v1 was;
-- body_sha256 is SHA-256 of that text (generated, not typed). A saved waiver
-- can never be edited: a change is a new version.

INSERT OR IGNORE INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at)
VALUES ('event-v1', 'Tennessee Saints Basketball Academy LLC', 'Event participation agreement, assumption of risk and release',
'This agreement is between you, the parent or legal guardian signing below, and Tennessee Saints Basketball Academy LLC ("Tennessee Saints"). It covers your child''s participation in the Tennessee Saints event you are signing up for: an evaluation, open gym, camp, scrimmage or similar session, on every day it runs.

1. What it covers. The event''s sessions, drills, games and scrimmages, and the time before and after them at the gym or other place where the event is held ("the event").

2. The risks. Basketball is a physical sport. Taking part can lead to injuries, including sprains, strains, broken bones, dental and eye injuries, cuts, heat illness, concussions and other head injuries, and, rarely, serious or permanent injury or death. Injuries can come from the game itself, other players, the condition of a gym or its equipment, and from the ordinary mistakes of coaches, staff and volunteers. I understand these risks, and I accept them for my child and for myself.

3. My child''s health. My child is physically able to take part. On this form I have told Tennessee Saints about any medical condition, allergy or medication its coaches should know about for the event. I am responsible for my child''s health insurance and medical costs.

4. Concussions. I have reviewed the Tennessee Department of Health''s concussion and head injury information sheet with my child, as Tennessee law asks. A child who shows signs of a concussion or head injury will be removed from activity that day and may return only with written clearance from a licensed health care provider. I will tell the coaches about any recent head injury my child has had, including one that happened away from Tennessee Saints.

5. Emergency care. If my child needs urgent medical care and I cannot be reached, I authorise Tennessee Saints'' coaches and staff to obtain emergency treatment and transport for my child, and to share the medical notes on this form with the people treating them. I am responsible for the cost of that care.

6. Safety and conduct. My child will follow the coaches'' instructions and safety rules. Tennessee Saints may remove my child from the event, for that day or longer, if it believes this is needed for my child''s safety or the safety of others.

7. Release. To the fullest extent the law allows, I release Tennessee Saints, its owners, coaches, staff and volunteers, and the owners of the facilities it uses, from any claim I have, for myself, for injury, illness, loss or damage arising from my child''s participation in the event, including claims based on their ordinary negligence. This release does not cover gross negligence, recklessness or intentional misconduct.

8. General. This agreement is governed by the laws of the State of Tennessee. If any part of it cannot be enforced, the rest still applies. It covers the event named on the sign-up, on every day it runs.

9. Signing. I am the parent or legal guardian of this child, I am 18 or older, and I have read and understood this agreement. I agree that typing my name is my signature.',
'eff213e3e13ce759c37e4a8f5f6c7448c3b2b161dfecee586a723dd9bc1eb8e5', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z');

INSERT OR IGNORE INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at)
VALUES ('tournament-team-v1', 'Tennessee Saints Basketball Academy LLC', 'Tournament team entry agreement',
'This agreement is between you, the coach or team representative signing below, and Tennessee Saints Basketball Academy LLC ("Tennessee Saints"). It covers your team''s entry in the tournament named on the entry form, which Tennessee Saints hosts ("the tournament").

1. Who is signing. I am the team''s coach or am authorised to enter it, and I am 18 or older. I will be responsible for the team, its players and the adults who come with it during the tournament.

2. The risks. Basketball is a physical sport. Taking part can lead to injuries, including sprains, broken bones, dental and eye injuries, concussions and other head injuries, and, rarely, serious or permanent injury or death. I understand these risks and will make sure the players'' parents or guardians know them.

3. Players'' consent. Before a player takes the court, their parent or legal guardian will have accepted the risks of the tournament and authorised emergency medical care for them, by signing Tennessee Saints'' event waiver online or at check-in. A player whose parent or guardian has not done so will not play.

4. Health and concussions. I will bring a roster with each player''s emergency contact. Any player who shows signs of a concussion or head injury will be removed from play that day and will return only with written clearance from a licensed health care provider, as Tennessee law requires.

5. Rules and conduct. The team will play under the tournament''s rules and accept the officials'' decisions. Players, coaches and spectators will treat everyone with respect. Tennessee Saints may remove any player, coach or spectator from the tournament, without refund, for conduct that it believes puts anyone''s safety or the tournament at risk.

6. Entry fee. The entry fee is due as shown on the entry form. A full refund if the team withdraws at least 7 days before the tournament; none after that, except where Tennessee Saints cancels the tournament.

7. Facilities. The team will respect the facilities and follow their rules, and is responsible for any damage it causes beyond ordinary wear.

8. Release. To the fullest extent the law allows, I release Tennessee Saints, its owners, coaches, staff and volunteers, and the owners of the facilities it uses, from any claim I have, for myself, for injury, illness, loss or damage arising from the tournament, including claims based on their ordinary negligence. This release does not cover gross negligence, recklessness or intentional misconduct.

9. General. This agreement is governed by the laws of the State of Tennessee. If any part of it cannot be enforced, the rest still applies.

10. Signing. I have read and understood this agreement, and I agree to it for myself and for the team. I agree that typing my name is my signature.',
'2184cae0785ed2e58283b1b3820b72b6a2ab3145ad104098f6350aca460a0f5a', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z');
