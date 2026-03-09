import { create } from 'zustand';
import {
  collection,
  doc,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  Timestamp,
  arrayUnion,
  arrayRemove,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { cleanData } from '../lib/firestoreHelpers';
import { createInvite } from '../lib/invites';

export type MemberRole = 'player' | 'parent' | 'coach';
export type Gender = 'male' | 'female';

/** A sibling link that may span teams */
export interface SiblingLink {
  playerId: string;
  teamId: string;
}

export interface Player {
  id: string;
  role: MemberRole;
  firstName: string;
  lastName: string;
  birthdate: string;        // ISO date string e.g. "2012-05-15"
  email?: string;           // for invites
  gender: Gender;
  jerseyNumber?: number;    // optional — coaches/parents don't have one
  position?: string;        // optional — coaches/parents don't have one
  phone?: string;
  address?: string;
  height?: string;          // e.g. "5'10"
  weight?: number;          // lbs
  parentName?: string;
  parentEmail?: string;
  parentPhone?: string;
  avatarUrl?: string;
  active: boolean;
  /** Whether an invite email should be sent to the member */
  sendInvite?: boolean;
  /** The UID of the linked Firebase Auth user (set when they accept invite) */
  linkedUserId?: string;
  /** IDs of player docs this parent/coach is linked to as a guardian */
  linkedPlayerIds?: string[];
  /** IDs of parent/coach docs linked to this player as guardians */
  linkedParentIds?: string[];
  /** Sibling links — may span teams */
  linkedSiblingIds?: SiblingLink[];
  createdAt: Timestamp;
}

/** Compute age from ISO birthdate string */
export function computeAge(birthdate: string): number {
  const today = new Date();
  const dob = new Date(birthdate);
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

// Fields required when adding a new player
export type PlayerInput = Omit<Player, 'id' | 'createdAt'>;

/** One-shot fetch of all players on a team (for cross-team sibling picker). */
export async function fetchTeamPlayers(teamId: string): Promise<Player[]> {
  const ref = collection(db, 'teams', teamId, 'players');
  const snap = await getDocs(ref);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Player));
}

/**
 * Sync bidirectional links between a member and related players/parents/siblings.
 * - Parent/coach sets linkedPlayerIds → each linked player gets this member in linkedParentIds.
 * - Player sets linkedParentIds → each linked parent/coach gets this player in linkedPlayerIds.
 * - Player sets linkedSiblingIds → each linked sibling gets a reverse SiblingLink.
 */
async function syncLinks(
  teamId: string,
  memberId: string,
  role: MemberRole,
  newLinkedPlayerIds?: string[],
  newLinkedParentIds?: string[],
  oldLinkedPlayerIds?: string[],
  oldLinkedParentIds?: string[],
  newLinkedSiblingIds?: SiblingLink[],
  oldLinkedSiblingIds?: SiblingLink[],
) {
  const playerDoc = (id: string) => doc(db, 'teams', teamId, 'players', id);

  // ── Parent/Coach → Player links ──
  if (role === 'parent' || role === 'coach') {
    const newIds = new Set(newLinkedPlayerIds ?? []);
    const oldIds = new Set(oldLinkedPlayerIds ?? []);
    for (const pid of newIds) {
      if (!oldIds.has(pid)) {
        await updateDoc(playerDoc(pid), { linkedParentIds: arrayUnion(memberId) });
      }
    }
    for (const pid of oldIds) {
      if (!newIds.has(pid)) {
        await updateDoc(playerDoc(pid), { linkedParentIds: arrayRemove(memberId) });
      }
    }
  }

  // ── Player → Parent/Coach links ──
  if (role === 'player') {
    const newIds = new Set(newLinkedParentIds ?? []);
    const oldIds = new Set(oldLinkedParentIds ?? []);
    for (const pid of newIds) {
      if (!oldIds.has(pid)) {
        await updateDoc(playerDoc(pid), { linkedPlayerIds: arrayUnion(memberId) });
      }
    }
    for (const pid of oldIds) {
      if (!newIds.has(pid)) {
        await updateDoc(playerDoc(pid), { linkedPlayerIds: arrayRemove(memberId) });
      }
    }
  }

  // ── Sibling links (may span teams) ──
  if (role === 'player') {
    const sibKey = (s: SiblingLink) => `${s.teamId}/${s.playerId}`;
    const newSibs = new Map((newLinkedSiblingIds ?? []).map((s) => [sibKey(s), s]));
    const oldSibs = new Map((oldLinkedSiblingIds ?? []).map((s) => [sibKey(s), s]));
    const reverseLink: SiblingLink = { playerId: memberId, teamId };

    // Add reverse link on newly-added siblings
    for (const [key, sib] of newSibs) {
      if (!oldSibs.has(key)) {
        const sibDoc = doc(db, 'teams', sib.teamId, 'players', sib.playerId);
        await updateDoc(sibDoc, { linkedSiblingIds: arrayUnion(reverseLink) });
      }
    }
    // Remove reverse link from removed siblings
    for (const [key, sib] of oldSibs) {
      if (!newSibs.has(key)) {
        const sibDoc = doc(db, 'teams', sib.teamId, 'players', sib.playerId);
        await updateDoc(sibDoc, { linkedSiblingIds: arrayRemove(reverseLink) });
      }
    }
  }
}

interface RosterState {
  players: Player[];
  loading: boolean;
  error: string | null;
  /** Subscribe to real-time roster updates. Returns unsubscribe fn. */
  listen: (teamId: string) => () => void;
  addPlayer: (teamId: string, data: PlayerInput) => Promise<void>;
  updatePlayer: (teamId: string, playerId: string, data: Partial<PlayerInput>) => Promise<void>;
  removePlayer: (teamId: string, playerId: string) => Promise<void>;
}

export const useRosterStore = create<RosterState>((set) => ({
  players: [],
  loading: true,
  error: null,

  listen: (teamId: string) => {
    set({ loading: true, error: null });
    const ref = collection(db, 'teams', teamId, 'players');
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const players = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Player));
        // Sort by role (player first) then jersey number
        players.sort((a, b) => {
          const roleOrder = { player: 0, coach: 1, parent: 2 };
          const rDiff = (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3);
          if (rDiff !== 0) return rDiff;
          return (a.jerseyNumber ?? 999) - (b.jerseyNumber ?? 999);
        });
        set({ players, loading: false });
      },
      (err) => {
        set({ error: err.message, loading: false });
      },
    );
    return unsub;
  },

  addPlayer: async (teamId, data) => {
    try {
      const ref = collection(db, 'teams', teamId, 'players');
      const docRef = await addDoc(ref, { ...cleanData(data as Record<string, unknown>), createdAt: Timestamp.now() });

      // Sync bidirectional links
      await syncLinks(
        teamId, docRef.id, data.role,
        data.linkedPlayerIds, data.linkedParentIds,
        undefined, undefined,
        data.linkedSiblingIds, undefined,
      );

      // If invite requested and email provided, create a pending invite
      if (data.sendInvite && data.email) {
        // Fetch team name for the invite record
        const teamSnap = await getDoc(doc(db, 'teams', teamId));
        const teamName = teamSnap.exists() ? (teamSnap.data().name as string) : teamId;

        await createInvite({
          email: data.email,
          teamId,
          teamName,
          role: data.role,
          playerId: docRef.id,
        });
      }
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  updatePlayer: async (teamId, playerId, data) => {
    try {
      // Get existing doc to diff links
      const existingSnap = await getDoc(doc(db, 'teams', teamId, 'players', playerId));
      const existing = existingSnap.exists() ? (existingSnap.data() as Player) : undefined;

      const ref = doc(db, 'teams', teamId, 'players', playerId);
      await updateDoc(ref, cleanData(data as Record<string, unknown>));

      // Sync bidirectional links (diff-based)
      const role = data.role ?? existing?.role ?? 'player';
      await syncLinks(
        teamId,
        playerId,
        role,
        data.linkedPlayerIds ?? existing?.linkedPlayerIds,
        data.linkedParentIds ?? existing?.linkedParentIds,
        existing?.linkedPlayerIds,
        existing?.linkedParentIds,
        data.linkedSiblingIds ?? existing?.linkedSiblingIds,
        existing?.linkedSiblingIds,
      );
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  removePlayer: async (teamId, playerId) => {
    try {
      const ref = doc(db, 'teams', teamId, 'players', playerId);
      await deleteDoc(ref);
    } catch (e: any) {
      set({ error: e.message });
    }
  },
}));
