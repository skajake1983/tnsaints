import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Link } from 'expo-router';
import { useAuthStore } from '../../stores/authStore';
import { Colors } from '../../constants/Colors';
import { FontAwesome5 } from '@expo/vector-icons';

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const { resetPassword, error, clearError } = useAuthStore();

  const handleReset = async () => {
    if (!email.trim()) return;
    clearError();
    setSending(true);
    const success = await resetPassword(email.trim());
    setSending(false);
    if (success) setSent(true);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.inner}>
        {sent ? (
          <View style={styles.successBox}>
            <FontAwesome5 name="check-circle" size={48} color={Colors.success} />
            <Text style={styles.successTitle}>Check Your Email</Text>
            <Text style={styles.successSub}>
              We sent a password reset link to{'\n'}
              <Text style={{ fontWeight: '700' }}>{email}</Text>
            </Text>
            <Link href="/(auth)/login" asChild>
              <TouchableOpacity style={styles.btn}>
                <Text style={styles.btnText}>Back to Sign In</Text>
              </TouchableOpacity>
            </Link>
          </View>
        ) : (
          <>
            <View style={styles.logoBox}>
              <FontAwesome5 name="lock" size={36} color={Colors.saintsBlue} />
              <Text style={styles.title}>Reset Password</Text>
              <Text style={styles.subtitle}>
                Enter your email and we'll send you a link to reset your password.
              </Text>
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

            <TouchableOpacity
              style={[styles.btn, sending && styles.btnDisabled]}
              onPress={handleReset}
              disabled={sending}
              activeOpacity={0.8}
            >
              {sending ? (
                <ActivityIndicator color={Colors.saintsBlueDark} />
              ) : (
                <Text style={styles.btnText}>Send Reset Link</Text>
              )}
            </TouchableOpacity>

            <View style={styles.footer}>
              <Text style={styles.footerText}>Remember your password? </Text>
              <Link href="/(auth)/login" asChild>
                <TouchableOpacity>
                  <Text style={styles.link}>Sign In</Text>
                </TouchableOpacity>
              </Link>
            </View>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.light },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },

  logoBox: { alignItems: 'center', marginBottom: 28 },
  title: { fontSize: 24, fontWeight: '800', color: Colors.saintsBlueDark, marginTop: 14 },
  subtitle: { fontSize: 14, color: Colors.textSecondary, marginTop: 6, textAlign: 'center', maxWidth: 280 },

  label: { fontWeight: '700', color: Colors.textPrimary, marginBottom: 6, marginTop: 14 },
  input: {
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.gray,
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: Colors.textPrimary,
  },
  btn: {
    backgroundColor: Colors.saintsGold,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 24,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { fontWeight: '800', fontSize: 16, color: Colors.saintsBlueDark },

  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 20 },
  footerText: { color: Colors.textSecondary },
  link: { color: Colors.saintsBlue, fontWeight: '700' },

  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 10, marginBottom: 8 },
  errorText: { color: Colors.danger, fontSize: 14 },

  successBox: { alignItems: 'center', gap: 12 },
  successTitle: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary, marginTop: 8 },
  successSub: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
});
