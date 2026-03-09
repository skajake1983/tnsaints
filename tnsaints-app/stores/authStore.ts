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
import { doc, getDoc, setDoc, onSnapshot as onDocSnapshot } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { redeemPendingInvites } from '../lib/invites';
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

/** Map Firebase error codes to user-friendly messages */
function friendlyAuthError(e: any): string {
  const code: string = e?.code ?? '';
  switch (code) {
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Try signing in or resetting your password.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Contact your administrator.';
    case 'auth/user-not-found':
      return 'No account found with this email. Would you like to sign up?';
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Incorrect email or password. Please try again.';
    case 'auth/too-many-requests':
      return 'Too many failed attempts. Please wait a moment and try again.';
    case 'auth/weak-password':
      return 'Password is too weak. Please choose a stronger password.';
    case 'auth/network-request-failed':
      return 'Network error. Please check your connection and try again.';
    default:
      return e?.message ?? 'An unexpected error occurred.';
  }
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
      set({ error: friendlyAuthError(e), loading: false });
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
      set({ error: friendlyAuthError(e), loading: false });
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
    let unsubProfile: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      // Clean up any previous profile listener
      unsubProfile?.();
      unsubProfile = null;

      if (user) {
        // Ensure the profile doc exists (first-time login)
        await ensureProfile(user);

        // Auto-redeem any pending team invites for this email
        if (user.email) {
          await redeemPendingInvites(user.uid, user.email);
        }

        // Subscribe to real-time updates on the user profile
        const ref = doc(db, 'users', user.uid);
        unsubProfile = onDocSnapshot(ref, (snap) => {
          if (snap.exists()) {
            set({ user, profile: snap.data() as UserProfile, loading: false });
          }
        });
      } else {
        set({ user: null, profile: null, loading: false });
      }
    });

    return () => {
      unsubAuth();
      unsubProfile?.();
    };
  },
}));
