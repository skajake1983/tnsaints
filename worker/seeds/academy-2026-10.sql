-- Seed: the academy's first group and its approved waiver (2026-10-12).
--
-- Not a migration: data for production, applied once after migrations
-- 007-019, with the owner's go:
--   npx wrangler d1 execute tnsaints --remote --file=./seeds/academy-2026-10.sql
-- Safe to re-run: neither row is added twice, and the program's waiver is
-- only set if it has none.
--
-- The group (owner, 2026-10-12): one group meeting both days, from
-- Tuesday 20 October 2026, at Grassland Heights Baptist Church, 10 seats.
-- The waiver: waivers/academy-v1.md, approved by the owner on 2026-10-10,
-- body below its heading as plain text; body_sha256 is SHA-256 of that text
-- (generated, not typed). A saved waiver can never be edited.

INSERT OR IGNORE INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at)
VALUES ('academy-v1', 'Tennessee Saints Basketball Academy LLC', 'Academy participation agreement, assumption of risk and release',
'This agreement is between you, the parent or legal guardian signing below, and Tennessee Saints Basketball Academy LLC ("Tennessee Saints"). It covers your child''s participation in the Tennessee Saints academy.

1. What it covers. Your child''s practices, skills sessions, scrimmages, games, tournaments, and the time before and after them at the gyms and other places Tennessee Saints uses ("activities").

2. The risks. Basketball is a physical sport. Taking part can lead to injuries, including sprains, strains, broken bones, dental and eye injuries, cuts, heat illness, concussions and other head injuries, and, rarely, serious or permanent injury or death. Injuries can come from the game itself, other players, the condition of a gym or its equipment, and from the ordinary mistakes of coaches, staff and volunteers. I understand these risks, and I accept them for my child and for myself.

3. My child''s health. My child is physically able to take part. I have told Tennessee Saints, through the parent portal, about any medical condition, allergy or medication its coaches should know about, and I will keep that information up to date. I am responsible for my child''s health insurance and medical costs.

4. Concussions. I have reviewed the Tennessee Department of Health''s concussion and head injury information sheet with my child, as Tennessee law asks each year. A child who shows signs of a concussion or head injury will be removed from activity that day and may return only with written clearance from a licensed health care provider, following a gradual return to play. I will tell the coaches about any head injury my child has, including one that happens away from Tennessee Saints.

5. Emergency care. If my child needs urgent medical care and I cannot be reached, I authorise Tennessee Saints'' coaches and staff to obtain emergency treatment and transport for my child. I am responsible for the cost of that care.

6. Safety and conduct. My child will follow the coaches'' instructions and safety rules. Tennessee Saints may remove my child from an activity, for that day or longer, if it believes this is needed for my child''s safety or the safety of others.

7. Release. To the fullest extent the law allows, I release Tennessee Saints, its owners, coaches, staff and volunteers, and the owners of the facilities it uses, from any claim I have, for myself, for injury, illness, loss or damage arising from my child''s participation in the activities, including claims based on their ordinary negligence. This release does not cover gross negligence, recklessness or intentional misconduct.

8. General. This agreement is governed by the laws of the State of Tennessee. If any part of it cannot be enforced, the rest still applies. It stays in effect for as long as my child has a place in the academy, unless I sign a newer version.

9. Signing. I am the parent or legal guardian of this child, I am 18 or older, and I have read and understood this agreement. I agree that typing my name is my signature.',
'e52f177a58a155a0712db0669ad7dec8bfb5a2ce392ec4d474d4eb46af63c440', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE programs SET waiver_version_id = 'academy-v1', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = 'academy' AND waiver_version_id IS NULL;

INSERT INTO program_groups (program_id, name, schedule_summary, location, starts_on, capacity, status, created_at, updated_at)
SELECT 'academy', 'Tuesday & Saturday', 'Tuesdays 6:00-7:30 PM and Saturdays 9:00-10:30 AM',
       'Grassland Heights Baptist Church, Franklin', '2026-10-20', 10, 'active',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE NOT EXISTS (SELECT 1 FROM program_groups WHERE program_id = 'academy' AND name = 'Tuesday & Saturday');
