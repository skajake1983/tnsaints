import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

// ---------------------------------------------------------------
// Replace these values with your Firebase project config.
// Find them at: Firebase Console → Project Settings → General → Your apps
// ---------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyDzcDWRTjhZl_XE0Ih-A6jbsnnlPNPOCTk",
  authDomain: "tn-saints.firebaseapp.com",
  projectId: "tn-saints",
  storageBucket: "tn-saints.firebasestorage.app",
  messagingSenderId: "928282556850",
  appId: "1:928282556850:web:cb577d45ea6f282ff30cab",
  measurementId: "G-9S68Y8VV0L",
};

// Initialize Firebase only once
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// Auth — Firebase v12 handles persistence automatically on React Native
export const auth = getAuth(app);

// Firestore database
export const db = getFirestore(app);

// Cloud Storage (photos, videos)
export const storage = getStorage(app);

export default app;
