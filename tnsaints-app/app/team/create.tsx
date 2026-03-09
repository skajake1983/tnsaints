import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { doc, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Colors } from '../../constants/Colors';
import { useTeamStore, TeamInput } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { sanitizeText } from '../../lib/validation';

export default function CreateTeamScreen() {
  const router = useRouter();
  const { addTeam, setActiveTeam } = useTeamStore();
  const profile = useAuthStore((s) => s.profile);

  const [name, setName] = useState('');
  const [season, setSeason] = useState('');
  const [ageGroup, setAgeGroup] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    setError('');
    const cleanName = sanitizeText(name.trim());
    if (!cleanName) {
      setError('Team name is required.');
      return;
    }
    if (cleanName.length < 2 || cleanName.length > 80) {
      setError('Team name must be 2–80 characters.');
      return;
    }

    if (!profile) {
      setError('You must be signed in.');
      return;
    }

    setSaving(true);
    try {
      const data: TeamInput = {
        name: cleanName,
        orgId: 'tn-saints',
        season: sanitizeText(season.trim()) || undefined,
        ageGroup: sanitizeText(ageGroup.trim()) || undefined,
      };
      const teamId = await addTeam(data);

      // Add the new team to the creator's teamIds
      const userRef = doc(db, 'users', profile.uid);
      await updateDoc(userRef, { teamIds: arrayUnion(teamId) });

      // Switch to the newly created team
      setActiveTeam(teamId);
      router.back();
    } catch {
      setError('Failed to create team. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.heading}>Create a New Team</Text>
        <Text style={styles.subheading}>Set up a new team under your organization.</Text>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>Team Name *</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="e.g. TN Saints 12U Boys"
          placeholderTextColor={Colors.textMuted}
          maxLength={80}
          autoFocus
        />

        <Text style={styles.label}>Season (optional)</Text>
        <TextInput
          style={styles.input}
          value={season}
          onChangeText={setSeason}
          placeholder="e.g. Spring 2026"
          placeholderTextColor={Colors.textMuted}
          maxLength={50}
        />

        <Text style={styles.label}>Age Group (optional)</Text>
        <TextInput
          style={styles.input}
          value={ageGroup}
          onChangeText={setAgeGroup}
          placeholder="e.g. 12U, 14U, High School"
          placeholderTextColor={Colors.textMuted}
          maxLength={30}
        />

        <TouchableOpacity
          style={[styles.createBtn, saving && styles.createBtnDisabled]}
          onPress={handleCreate}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <>
              <FontAwesome5 name="plus-circle" size={16} color={Colors.white} />
              <Text style={styles.createBtnText}>Create Team</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.cancelBtn} onPress={() => router.back()}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.light },
  content: { padding: 20, paddingBottom: 40 },

  heading: { fontSize: 24, fontWeight: '800', color: Colors.saintsBlueDark, marginBottom: 4 },
  subheading: { fontSize: 14, color: Colors.textSecondary, marginBottom: 20 },

  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 10, marginBottom: 16 },
  errorText: { color: Colors.danger, fontWeight: '600', textAlign: 'center' },

  label: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, marginTop: 16, marginBottom: 6 },
  input: {
    backgroundColor: Colors.white,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: Colors.textPrimary,
    borderWidth: 1.5,
    borderColor: Colors.gray,
  },

  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.saintsBlue,
    paddingVertical: 16,
    borderRadius: 12,
    marginTop: 28,
  },
  createBtnDisabled: { opacity: 0.6 },
  createBtnText: { color: Colors.white, fontSize: 16, fontWeight: '800' },

  cancelBtn: { alignItems: 'center', paddingVertical: 14 },
  cancelBtnText: { color: Colors.textMuted, fontSize: 15, fontWeight: '600' },
});
