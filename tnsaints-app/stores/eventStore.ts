import { create } from 'zustand';
import {
  collection,
  doc,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

// Re-export pure helpers for backward compatibility
export { getEventMeta, formatEventDate, formatEventTime, groupEventsByDate, filterUpcoming, filterPast } from '../lib/eventHelpers';
export type { EventType } from '../lib/eventHelpers';

import type { EventType } from '../lib/eventHelpers';

export interface TeamEvent {
  id: string;
  title: string;
  type: EventType;
  startDate: string;   // ISO datetime  e.g. "2026-03-15T18:00:00"
  endDate: string;      // ISO datetime
  location?: string;
  locationUrl?: string; // Google Maps link
  description?: string;
  opponent?: string;    // for games
  homeAway?: 'home' | 'away' | 'neutral';
  isAllDay?: boolean;
  createdBy: string;    // uid
  createdAt: Timestamp;
}

export type EventInput = Omit<TeamEvent, 'id' | 'createdAt'>;

interface EventState {
  events: TeamEvent[];
  loading: boolean;
  error: string | null;
  listen: (teamId: string) => () => void;
  addEvent: (teamId: string, data: EventInput) => Promise<string>;
  updateEvent: (teamId: string, eventId: string, data: Partial<EventInput>) => Promise<void>;
  removeEvent: (teamId: string, eventId: string) => Promise<void>;
}

export const useEventStore = create<EventState>((set) => ({
  events: [],
  loading: true,
  error: null,

  listen: (teamId: string) => {
    set({ loading: true, error: null });
    const ref = collection(db, 'teams', teamId, 'events');
    const q = query(ref, orderBy('startDate', 'asc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const events = snap.docs.map((d) => ({ id: d.id, ...d.data() } as TeamEvent));
        set({ events, loading: false });
      },
      (err) => {
        set({ error: err.message, loading: false });
      },
    );
    return unsub;
  },

  addEvent: async (teamId, data) => {
    const ref = collection(db, 'teams', teamId, 'events');
    const docRef = await addDoc(ref, { ...data, createdAt: Timestamp.now() });
    return docRef.id;
  },

  updateEvent: async (teamId, eventId, data) => {
    const ref = doc(db, 'teams', teamId, 'events', eventId);
    await updateDoc(ref, data);
  },

  removeEvent: async (teamId, eventId) => {
    const ref = doc(db, 'teams', teamId, 'events', eventId);
    await deleteDoc(ref);
  },
}));
