import { create } from 'zustand';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithCredential,
  User,
} from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { UserRole } from '../constants/Roles';

export interface UserProfile {
  uid: string;
  email: string;
  name: string;
  role: UserRole;
  teamIds: string[];
  avatarUrl?: string;
}

interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<boolean>;
  signInWithGoogle: (idToken: string) => Promise<void>;
  signInWithApple: (idToken: string, nonce: string) => Promise<void>;
  clearError: () => void;
  listen: () => () => void;
}

/**
 * Ensures a user profile document exists in Firestore.
 * Creates one if it doesn't exist (first SSO sign-in).
 */
async function ensureProfile(user: User): Promise<UserProfile> {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data() as UserProfile;

  const profile: UserProfile = {
    uid: user.uid,
    email: user.email ?? '',
    name: user.displayName ?? '',
    role: 'parent',
    teamIds: [],
    avatarUrl: user.photoURL ?? undefined,
  };
  await setDoc(ref, profile);
  return profile;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  profile: null,
  loading: true,
  error: null,

  signIn: async (email, password) => {
    set({ loading: true, error: null });
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  signUp: async (email, password, name) => {
    set({ loading: true, error: null });
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      const profile: UserProfile = {
        uid: cred.user.uid,
        email,
        name,
        role: 'parent',
        teamIds: [],
      };
      await setDoc(doc(db, 'users', cred.user.uid), profile);
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  signOut: async () => {
    await firebaseSignOut(auth);
    set({ user: null, profile: null });
  },

  resetPassword: async (email) => {
    set({ error: null });
    try {
      await sendPasswordResetEmail(auth, email);
      return true;
    } catch (e: any) {
      set({ error: e.message });
      return false;
    }
  },

  signInWithGoogle: async (idToken) => {
    set({ loading: true, error: null });
    try {
      const credential = GoogleAuthProvider.credential(idToken);
      await signInWithCredential(auth, credential);
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  signInWithApple: async (idToken, nonce) => {
    set({ loading: true, error: null });
    try {
      const provider = new OAuthProvider('apple.com');
      const credential = provider.credential({ idToken, rawNonce: nonce });
      await signInWithCredential(auth, credential);
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  clearError: () => set({ error: null }),

  listen: () => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const profile = await ensureProfile(user);
        set({ user, profile, loading: false });
      } else {
        set({ user: null, profile: null, loading: false });
      }
    });
    return unsubscribe;
  },
}));
