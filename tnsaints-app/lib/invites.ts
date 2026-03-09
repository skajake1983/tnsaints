import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  updateDoc,
  doc,
  arrayUnion,
  Timestamp,
} from 'firebase/firestore';
import { db } from './firebase';

export interface Invite {
  id: string;
  email: string;            // normalised lower-case email of invitee
  teamId: string;
  teamName: string;
  role: 'player' | 'parent' | 'coach'; // what role the invite grants
  playerId?: string;        // roster entry id to link after acceptance
  status: 'pending' | 'accepted';
  createdAt: Timestamp;
  acceptedAt?: Timestamp;
}

/**
 * Create a pending invite so that when the user signs up (or next
 * signs in) with the matching email, they are automatically added
 * to the team.
 */
export async function createInvite(params: {
  email: string;
  teamId: string;
  teamName: string;
  role: 'player' | 'parent' | 'coach';
  playerId?: string;
}): Promise<string> {
  const normalEmail = params.email.trim().toLowerCase();

  // Check if an invite already exists for this email + team
  const q = query(
    collection(db, 'invites'),
    where('email', '==', normalEmail),
    where('teamId', '==', params.teamId),
    where('status', '==', 'pending'),
  );
  const existing = await getDocs(q);
  if (!existing.empty) {
    // Already invited — return existing invite id
    return existing.docs[0].id;
  }

  const ref = await addDoc(collection(db, 'invites'), {
    email: normalEmail,
    teamId: params.teamId,
    teamName: params.teamName,
    role: params.role,
    playerId: params.playerId ?? null,
    status: 'pending',
    createdAt: Timestamp.now(),
  });
  return ref.id;
}

/**
 * Called after a user signs in / signs up. Checks for any pending
 * invites matching their email and:
 *  1. Adds the team to the user's teamIds
 *  2. Updates the roster entry's linkedUserId
 *  3. Marks the invite as accepted
 */
export async function redeemPendingInvites(uid: string, email: string): Promise<void> {
  const normalEmail = email.trim().toLowerCase();
  const q = query(
    collection(db, 'invites'),
    where('email', '==', normalEmail),
    where('status', '==', 'pending'),
  );
  const snap = await getDocs(q);
  if (snap.empty) return;

  for (const inviteDoc of snap.docs) {
    const invite = inviteDoc.data() as Omit<Invite, 'id'>;

    // 1. Add teamId to user's profile
    const userRef = doc(db, 'users', uid);
    await updateDoc(userRef, {
      teamIds: arrayUnion(invite.teamId),
    });

    // 2. Link roster entry if one exists
    if (invite.playerId) {
      const playerRef = doc(db, 'teams', invite.teamId, 'players', invite.playerId);
      await updateDoc(playerRef, { linkedUserId: uid });
    }

    // 3. Mark invite accepted
    await updateDoc(inviteDoc.ref, {
      status: 'accepted',
      acceptedAt: Timestamp.now(),
    });
  }
}
