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
import { validatePassword, PASSWORD_RULES } from '../../lib/passwordValidation';
import { useGoogleAuth, handleAppleSignIn } from '../../lib/ssoAuth';
import * as AppleAuthentication from 'expo-apple-authentication';

export default function SignUpScreen() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { signUp, loading, error, clearError } = useAuthStore();
  const [localError, setLocalError] = useState('');
  const { handleGoogleSignIn, googleReady } = useGoogleAuth();
  const [appleAvailable, setAppleAvailable] = useState(false);

  const pwCheck = validatePassword(password);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
    }
  }, []);

  const handleSignUp = () => {
    setLocalError('');
    clearError();

    if (!name.trim()) {
      setLocalError('Please enter your name.');
      return;
    }
    if (!email.trim()) {
      setLocalError('Please enter your email.');
      return;
    }
    if (!pwCheck.valid) {
      setLocalError('Password does not meet all requirements.');
      return;
    }
    if (password !== confirm) {
      setLocalError('Passwords do not match.');
      return;
    }

    signUp(email.trim(), password, name.trim());
  };

  const displayError = localError || error;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <View style={styles.logoBox}>
          <Text style={styles.title}>Create Account</Text>
          <Text style={styles.subtitle}>Join the Tennessee Saints</Text>
        </View>

        {displayError ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{displayError}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>Full Name</Text>
        <TextInput
          style={styles.input}
          placeholder="Your full name"
          placeholderTextColor={Colors.textMuted}
          autoCapitalize="words"
          autoComplete="name"
          value={name}
          onChangeText={setName}
        />

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
          placeholder="Strong password"
          placeholderTextColor={Colors.textMuted}
          secureTextEntry
          autoComplete="new-password"
          value={password}
          onChangeText={setPassword}
        />

        {/* Password strength checklist */}
        {password.length > 0 && (
          <View style={styles.checkList}>
            {PASSWORD_RULES.map((rule) => {
              const passed = pwCheck.checks[rule.key];
              return (
                <View key={rule.key} style={styles.checkRow}>
                  <FontAwesome5
                    name={passed ? 'check-circle' : 'circle'}
                    size={14}
                    color={passed ? Colors.success : Colors.textMuted}
                    solid={passed}
                  />
                  <Text style={[styles.checkLabel, passed && styles.checkLabelPassed]}>
                    {rule.label}
                  </Text>
                </View>
              );
            })}
          </View>
        )}

        <Text style={styles.label}>Confirm Password</Text>
        <TextInput
          style={styles.input}
          placeholder="Re-enter password"
          placeholderTextColor={Colors.textMuted}
          secureTextEntry
          value={confirm}
          onChangeText={setConfirm}
        />

        <TouchableOpacity
          style={[styles.btn, loading && styles.btnDisabled]}
          onPress={handleSignUp}
          disabled={loading}
          activeOpacity={0.8}
        >
          {loading ? (
            <ActivityIndicator color={Colors.saintsBlueDark} />
          ) : (
            <Text style={styles.btnText}>Create Account</Text>
          )}
        </TouchableOpacity>

        {/* SSO Divider */}
        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or sign up with</Text>
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
          <Text style={styles.footerText}>Already have an account? </Text>
          <Link href="/(auth)/login" asChild>
            <TouchableOpacity>
              <Text style={styles.link}>Sign In</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.light },
  inner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 40 },

  logoBox: { alignItems: 'center', marginBottom: 28 },
  title: { fontSize: 26, fontWeight: '800', color: Colors.saintsBlueDark },
  subtitle: { fontSize: 14, color: Colors.textSecondary, marginTop: 4 },

  label: { fontWeight: '700', color: Colors.textPrimary, marginBottom: 6, marginTop: 12 },
  input: {
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.gray,
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: Colors.textPrimary,
  },

  checkList: {
    backgroundColor: '#f8f9fc',
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
    gap: 6,
  },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkLabel: { fontSize: 13, color: Colors.textMuted },
  checkLabelPassed: { color: Colors.success },

  btn: { backgroundColor: Colors.saintsGold, borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 20 },
  btnDisabled: { opacity: 0.6 },
  btnText: { fontWeight: '800', fontSize: 16, color: Colors.saintsBlueDark },

  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 22 },
  dividerLine: { flex: 1, height: 1, backgroundColor: Colors.gray },
  dividerText: { color: Colors.textMuted, fontSize: 13, marginHorizontal: 12 },

  ssoRow: { flexDirection: 'row', gap: 12 },
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
  ssoBtnText: { fontWeight: '700', fontSize: 15, color: Colors.textPrimary },

  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 24 },
  footerText: { color: Colors.textSecondary },
  link: { color: Colors.saintsBlue, fontWeight: '700' },

  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 10, marginBottom: 8 },
  errorText: { color: Colors.danger, fontSize: 14 },
});
