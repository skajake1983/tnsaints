import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { Link } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { useAuthStore } from '../../stores/authStore';
import { Colors } from '../../constants/Colors';
import { useGoogleAuth, handleAppleSignIn } from '../../lib/ssoAuth';
import * as AppleAuthentication from 'expo-apple-authentication';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { signIn, loading, error, clearError } = useAuthStore();
  const { handleGoogleSignIn, googleReady } = useGoogleAuth();
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
    }
  }, []);

  const handleLogin = () => {
    if (!email.trim() || !password) return;
    clearError();
    signIn(email.trim(), password);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <View style={styles.logoBox}>
          <Text style={styles.title}>Tennessee Saints</Text>
          <Text style={styles.subtitle}>Faith. Grit. Community.</Text>
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          placeholder="you@example.com"
          placeholderTextColor={Colors.textMuted}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          value={email}
          onChangeText={setEmail}
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          placeholder="Your password"
          placeholderTextColor={Colors.textMuted}
          secureTextEntry
          autoComplete="password"
          value={password}
          onChangeText={setPassword}
        />

        <Link href="/(auth)/forgot-password" asChild>
          <TouchableOpacity style={styles.forgotRow}>
            <Text style={styles.forgotText}>Forgot password?</Text>
          </TouchableOpacity>
        </Link>

        <TouchableOpacity
          style={[styles.btn, loading && styles.btnDisabled]}
          onPress={handleLogin}
          disabled={loading}
          activeOpacity={0.8}
        >
          {loading ? (
            <ActivityIndicator color={Colors.saintsBlueDark} />
          ) : (
            <Text style={styles.btnText}>Sign In</Text>
          )}
        </TouchableOpacity>

        {/* SSO Divider */}
        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or continue with</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* SSO Buttons */}
        <View style={styles.ssoRow}>
          <TouchableOpacity
            style={styles.ssoBtn}
            onPress={handleGoogleSignIn}
            disabled={!googleReady}
            activeOpacity={0.7}
          >
            <FontAwesome5 name="google" size={20} color="#DB4437" />
            <Text style={styles.ssoBtnText}>Google</Text>
          </TouchableOpacity>

          {appleAvailable && (
            <TouchableOpacity
              style={styles.ssoBtn}
              onPress={handleAppleSignIn}
              activeOpacity={0.7}
            >
              <FontAwesome5 name="apple" size={20} color="#000" />
              <Text style={styles.ssoBtnText}>Apple</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Don't have an account? </Text>
          <Link href="/(auth)/signup" asChild>
            <TouchableOpacity>
              <Text style={styles.link}>Sign Up</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light,
  },
  inner: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingVertical: 40,
  },
  logoBox: {
    alignItems: 'center',
    marginBottom: 36,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.saintsBlueDark,
  },
  subtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  label: {
    fontWeight: '700',
    color: Colors.textPrimary,
    marginBottom: 6,
    marginTop: 14,
  },
  input: {
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.gray,
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: Colors.textPrimary,
  },
  forgotRow: {
    alignSelf: 'flex-end',
    marginTop: 8,
  },
  forgotText: {
    color: Colors.saintsBlue,
    fontWeight: '600',
    fontSize: 13,
  },
  btn: {
    backgroundColor: Colors.saintsGold,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 20,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  btnText: {
    fontWeight: '800',
    fontSize: 16,
    color: Colors.saintsBlueDark,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 22,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.gray,
  },
  dividerText: {
    color: Colors.textMuted,
    fontSize: 13,
    marginHorizontal: 12,
  },
  ssoRow: {
    flexDirection: 'row',
    gap: 12,
  },
  ssoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.gray,
    borderRadius: 12,
    padding: 14,
  },
  ssoBtnText: {
    fontWeight: '700',
    fontSize: 15,
    color: Colors.textPrimary,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 24,
  },
  footerText: {
    color: Colors.textSecondary,
  },
  link: {
    color: Colors.saintsBlue,
    fontWeight: '700',
  },
  errorBox: {
    backgroundColor: '#fdecea',
    padding: 12,
    borderRadius: 10,
    marginBottom: 8,
  },
  errorText: {
    color: Colors.danger,
    fontSize: 14,
  },
});
