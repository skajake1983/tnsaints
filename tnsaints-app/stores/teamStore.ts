import { create } from 'zustand';
import {
  collection,
  doc,
  onSnapshot,
  addDoc,
  updateDoc,
  query,
  where,
  documentId,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { cleanData } from '../lib/firestoreHelpers';

export type TeamGender = 'boys' | 'girls' | 'coed';

export const SPORTS = [
  'Baseball', 'Basketball', 'Cheerleading', 'Cricket', 'Field Hockey',
  'Football', 'Golf', 'Gymnastics', 'Ice Hockey', 'Lacrosse',
  'Rugby', 'Soccer', 'Softball', 'Swimming', 'Tennis',
  'Track & Field', 'Volleyball', 'Water Polo', 'Wrestling', 'Other',
] as const;
export type Sport = (typeof SPORTS)[number];

export const AGE_GROUPS = [
  '6U', '7U', '8U', '9U', '10U', '11U', '12U', '13U', '14U', '15U', '16U', '17U', '18U', 'High School', 'Adult',
] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

export const COUNTRIES = [
  'United States', 'Canada', 'United Kingdom', 'Australia', 'Mexico',
  'France', 'Germany', 'Spain', 'Italy', 'Japan', 'South Korea',
  'Brazil', 'Argentina', 'New Zealand', 'Ireland', 'Other',
] as const;
export type Country = (typeof COUNTRIES)[number];

export const TIME_ZONES = [
  { label: 'Eastern (ET)', value: 'America/New_York' },
  { label: 'Central (CT)', value: 'America/Chicago' },
  { label: 'Mountain (MT)', value: 'America/Denver' },
  { label: 'Pacific (PT)', value: 'America/Los_Angeles' },
  { label: 'Alaska (AKT)', value: 'America/Anchorage' },
  { label: 'Hawaii (HT)', value: 'Pacific/Honolulu' },
  { label: 'Atlantic (AT)', value: 'America/Halifax' },
  { label: 'Newfoundland (NT)', value: 'America/St_Johns' },
  { label: 'GMT / UTC', value: 'Europe/London' },
  { label: 'Central European (CET)', value: 'Europe/Berlin' },
  { label: 'Australian Eastern (AET)', value: 'Australia/Sydney' },
  { label: 'Japan (JST)', value: 'Asia/Tokyo' },
] as const;
export type TimeZone = (typeof TIME_ZONES)[number]['value'];

export interface Team {
  id: string;
  name: string;
  /** Organization this team belongs to (e.g. "tn-saints") */
  orgId: string;
  sport?: Sport;
  ageGroup?: AgeGroup;
  country?: Country;
  timeZone?: TimeZone;
  /** @deprecated Use sport instead. Kept for backward compatibility. */
  season?: string;
  /** @deprecated Kept for backward compatibility. */
  gender?: TeamGender;
  headCoach?: string;
  practiceFacility?: string;
  facilityAddress?: string;
  league?: string;
  maxRosterSize?: number;
  description?: string;
  createdAt: Timestamp;
}

export type TeamInput = Omit<Team, 'id' | 'createdAt'>;

interface TeamState {
  teams: Team[];
  activeTeamId: string | null;
  loading: boolean;
  error: string | null;
  /** Subscribe to teams the current user has access to */
  listen: (teamIds: string[]) => () => void;
  setActiveTeam: (teamId: string) => void;
  addTeam: (data: TeamInput) => Promise<string>;
  updateTeam: (teamId: string, data: Partial<TeamInput>) => Promise<void>;
}

export const useTeamStore = create<TeamState>((set, get) => ({
  teams: [],
  activeTeamId: null,
  loading: true,
  error: null,

  listen: (teamIds: string[]) => {
    if (teamIds.length === 0) {
      set({ teams: [], loading: false });
      return () => {};
    }

    set({ loading: true, error: null });

    // Firestore 'in' queries support max 30 items per batch
    const batches = [];
    for (let i = 0; i < teamIds.length; i += 30) {
      batches.push(teamIds.slice(i, i + 30));
    }

    const allTeams: Map<string, Team> = new Map();
    const unsubscribers: (() => void)[] = [];

    for (const batch of batches) {
      const q = query(collection(db, 'teams'), where(documentId(), 'in', batch));
      const unsub = onSnapshot(
        q,
        (snap) => {
          for (const d of snap.docs) {
            allTeams.set(d.id, { id: d.id, ...d.data() } as Team);
          }
          const teams = Array.from(allTeams.values()).sort((a, b) =>
            a.name.localeCompare(b.name),
          );
          set({ teams, loading: false });

          // Auto-select first team if none selected
          const current = get().activeTeamId;
          if (!current && teams.length > 0) {
            set({ activeTeamId: teams[0].id });
          }
        },
        (err) => {
          set({ error: err.message, loading: false });
        },
      );
      unsubscribers.push(unsub);
    }

    return () => unsubscribers.forEach((fn) => fn());
  },

  setActiveTeam: (teamId) => set({ activeTeamId: teamId }),

  addTeam: async (data) => {
    const ref = await addDoc(collection(db, 'teams'), {
      ...cleanData(data as Record<string, unknown>),
      createdAt: Timestamp.now(),
    });
    return ref.id;
  },

  updateTeam: async (teamId, data) => {
    const ref = doc(db, 'teams', teamId);
    await updateDoc(ref, cleanData(data as Record<string, unknown>));
  },
}));
