import { create } from 'zustand';
import {
  collection,
  doc,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { createInvite } from '../lib/invites';

export type MemberRole = 'player' | 'parent' | 'coach';
export type Gender = 'male' | 'female';

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
      const docRef = await addDoc(ref, { ...data, createdAt: Timestamp.now() });

      // If invite requested and email provided, create a pending invite
      if (data.sendInvite && data.email) {
        // Fetch team name for the invite record
        const teamSnap = await getDoc(doc(db, 'teams', teamId));
        const teamName = teamSnap.exists() ? (teamSnap.data().name as string) : teamId;

        await createInvite({
          email: data.email,
          teamId,
          teamName,
          role: data.role === 'coach' ? 'coach' : 'parent',
          playerId: docRef.id,
        });
      }
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  updatePlayer: async (teamId, playerId, data) => {
    try {
      const ref = doc(db, 'teams', teamId, 'players', playerId);
      await updateDoc(ref, data);
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
