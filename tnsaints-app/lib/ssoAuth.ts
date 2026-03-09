import { Platform } from 'react-native';
import * as Google from 'expo-auth-session/providers/google';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { useAuthStore } from '../stores/authStore';

// ---------------------------------------------------------------
// Google Sign-In hook
// Fill in your Client IDs from Google Cloud Console:
//   APIs & Services → Credentials → OAuth 2.0 Client IDs
// You need a Web client ID (required) and optionally iOS/Android IDs.
// ---------------------------------------------------------------
const GOOGLE_WEB_CLIENT_ID = '928282556850-jkrhck7bfsr4adb4gp4c4ujaomntfqk8.apps.googleusercontent.com';

export function useGoogleAuth() {
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    clientId: GOOGLE_WEB_CLIENT_ID,
  });

  const handleGoogleSignIn = async () => {
    const result = await promptAsync();
    if (result.type === 'success') {
      const idToken = result.params.id_token;
      await useAuthStore.getState().signInWithGoogle(idToken);
    }
  };

  return { handleGoogleSignIn, googleReady: !!request };
}

// ---------------------------------------------------------------
// Apple Sign-In (iOS only, uses native Apple auth)
// ---------------------------------------------------------------
export async function handleAppleSignIn() {
  // Generate a random nonce for security
  const nonce = Math.random().toString(36).substring(2, 18);
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    nonce,
  );

  const appleCredential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
    nonce: hashedNonce,
  });

  if (appleCredential.identityToken) {
    await useAuthStore.getState().signInWithApple(appleCredential.identityToken, nonce);
  }
}

export const isAppleAuthAvailable =
  Platform.OS === 'ios' && AppleAuthentication.isAvailableAsync;
