import { create } from 'zustand';
import {
  collection,
  addDoc,
  deleteDoc,
  updateDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  limit,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { cleanData } from '../lib/firestoreHelpers';

export interface ChatMessage {
  id: string;
  text: string;
  uid: string;
  senderName: string;
  createdAt: Timestamp;
  editedAt?: Timestamp;
}

interface ChatState {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  /** Subscribe to the latest messages for a team */
  listen: (teamId: string) => () => void;
  /** Send a new message */
  sendMessage: (teamId: string, uid: string, senderName: string, text: string) => Promise<void>;
  /** Edit a message (own only — enforced by Firestore rules) */
  editMessage: (teamId: string, messageId: string, newText: string) => Promise<void>;
  /** Delete a message (own or admin+ — enforced by Firestore rules) */
  deleteMessage: (teamId: string, messageId: string) => Promise<void>;
}

const MESSAGE_LIMIT = 100;

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  loading: true,
  error: null,

  listen: (teamId: string) => {
    set({ loading: true, error: null, messages: [] });
    const ref = collection(db, 'teams', teamId, 'messages');
    const q = query(ref, orderBy('createdAt', 'asc'), limit(MESSAGE_LIMIT));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const messages = snap.docs.map(
          (d) => ({ id: d.id, ...d.data() } as ChatMessage),
        );
        set({ messages, loading: false });
      },
      (err) => {
        set({ error: err.message, loading: false });
      },
    );
    return unsub;
  },

  sendMessage: async (teamId, uid, senderName, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ref = collection(db, 'teams', teamId, 'messages');
    await addDoc(ref, cleanData({
      text: trimmed,
      uid,
      senderName,
      createdAt: Timestamp.now(),
    }));
  },

  editMessage: async (teamId, messageId, newText) => {
    const trimmed = newText.trim();
    if (!trimmed) return;
    const ref = doc(db, 'teams', teamId, 'messages', messageId);
    await updateDoc(ref, { text: trimmed, editedAt: Timestamp.now() });
  },

  deleteMessage: async (teamId, messageId) => {
    const ref = doc(db, 'teams', teamId, 'messages', messageId);
    await deleteDoc(ref);
  },
}));
