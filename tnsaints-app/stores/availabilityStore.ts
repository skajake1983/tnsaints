import { create } from 'zustand';
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  query,
  where,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

// Re-export pure helpers for backward compatibility
export { summariseRsvps } from '../lib/availabilityHelpers';
export type { RsvpSummary } from '../lib/availabilityHelpers';

export type RsvpStatus = 'in' | 'out' | 'maybe';

export interface Availability {
  id: string;           // doc id = `${eventId}_${uid}`
  eventId: string;
  uid: string;
  playerName: string;   // denormalised for quick display
  status: RsvpStatus;
  updatedAt: Timestamp;
}

interface AvailabilityState {
  /** Map of eventId → Availability[] */
  byEvent: Record<string, Availability[]>;
  loading: boolean;
  error: string | null;
  /** Listen to all availability entries for one event */
  listenEvent: (teamId: string, eventId: string) => () => void;
  /** Listen to availability for all events in a team (for summary view) */
  listenTeam: (teamId: string) => () => void;
  /** Set RSVP for current user on an event */
  setRsvp: (teamId: string, eventId: string, uid: string, playerName: string, status: RsvpStatus) => Promise<void>;
}

export const useAvailabilityStore = create<AvailabilityState>((set, get) => ({
  byEvent: {},
  loading: true,
  error: null,

  listenEvent: (teamId, eventId) => {
    const ref = collection(db, 'teams', teamId, 'availability');
    const q = query(ref, where('eventId', '==', eventId));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const entries = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Availability));
        set((s) => ({
          byEvent: { ...s.byEvent, [eventId]: entries },
          loading: false,
        }));
      },
      (err) => set({ error: err.message, loading: false }),
    );
    return unsub;
  },

  listenTeam: (teamId) => {
    const ref = collection(db, 'teams', teamId, 'availability');
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const grouped: Record<string, Availability[]> = {};
        for (const d of snap.docs) {
          const entry = { id: d.id, ...d.data() } as Availability;
          if (!grouped[entry.eventId]) grouped[entry.eventId] = [];
          grouped[entry.eventId].push(entry);
        }
        set({ byEvent: grouped, loading: false });
      },
      (err) => set({ error: err.message, loading: false }),
    );
    return unsub;
  },

  setRsvp: async (teamId, eventId, uid, playerName, status) => {
    // Use deterministic doc id so each user has exactly one entry per event
    const docId = `${eventId}_${uid}`;
    const ref = doc(db, 'teams', teamId, 'availability', docId);
    await setDoc(ref, {
      eventId,
      uid,
      playerName,
      status,
      updatedAt: Timestamp.now(),
    });
  },
}));
