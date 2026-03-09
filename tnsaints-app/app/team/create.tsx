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
import { useTeamStore, TeamInput, AGE_GROUPS, AgeGroup, TeamGender } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { sanitizeText, sanitizeAddress } from '../../lib/validation';

const GENDER_OPTIONS: { label: string; value: TeamGender }[] = [
  { label: 'Boys', value: 'boys' },
  { label: 'Girls', value: 'girls' },
  { label: 'Co-ed', value: 'coed' },
];

export default function CreateTeamScreen() {
  const router = useRouter();
  const { addTeam, setActiveTeam } = useTeamStore();
  const profile = useAuthStore((s) => s.profile);

  const [name, setName] = useState('');
  const [season, setSeason] = useState('');
  const [ageGroup, setAgeGroup] = useState<AgeGroup | ''>('');
  const [gender, setGender] = useState<TeamGender | ''>('');
  const [headCoach, setHeadCoach] = useState('');
  const [practiceFacility, setPracticeFacility] = useState('');
  const [facilityAddress, setFacilityAddress] = useState('');
  const [league, setLeague] = useState('');
  const [maxRosterSize, setMaxRosterSize] = useState('15');
  const [description, setDescription] = useState('');
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
    if (!season.trim()) {
      setError('Season is required.');
      return;
    }
    if (!ageGroup) {
      setError('Age group is required.');
      return;
    }
    if (!gender) {
      setError('Gender is required.');
      return;
    }

    const parsedRoster = parseInt(maxRosterSize, 10);
    if (maxRosterSize.trim() && (isNaN(parsedRoster) || parsedRoster < 1 || parsedRoster > 30)) {
      setError('Max roster size must be between 1 and 30.');
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
        ageGroup: ageGroup || undefined,
        gender: gender || undefined,
        headCoach: sanitizeText(headCoach.trim()) || undefined,
        practiceFacility: sanitizeText(practiceFacility.trim()) || undefined,
        facilityAddress: sanitizeAddress(facilityAddress.trim()) || undefined,
        league: sanitizeText(league.trim()) || undefined,
        maxRosterSize: maxRosterSize.trim() ? parsedRoster : undefined,
        description: sanitizeText(description.trim()) || undefined,
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

        {/* ── Required fields ─────────────────── */}
        <Text style={styles.sectionTitle}>Team Details</Text>

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

        <Text style={styles.label}>Season *</Text>
        <TextInput
          style={styles.input}
          value={season}
          onChangeText={setSeason}
          placeholder="e.g. Spring 2026"
          placeholderTextColor={Colors.textMuted}
          maxLength={50}
        />

        <Text style={styles.label}>Age Group *</Text>
        <View style={styles.chipRow}>
          {AGE_GROUPS.map((ag) => (
            <TouchableOpacity
              key={ag}
              style={[styles.chip, ageGroup === ag && styles.chipActive]}
              onPress={() => setAgeGroup(ag)}
            >
              <Text style={[styles.chipText, ageGroup === ag && styles.chipTextActive]}>{ag}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>Gender *</Text>
        <View style={styles.chipRow}>
          {GENDER_OPTIONS.map((g) => (
            <TouchableOpacity
              key={g.value}
              style={[styles.chip, gender === g.value && styles.chipActive]}
              onPress={() => setGender(g.value)}
            >
              <Text style={[styles.chipText, gender === g.value && styles.chipTextActive]}>{g.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Optional fields ─────────────────── */}
        <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Additional Info</Text>

        <Text style={styles.label}>Head Coach</Text>
        <TextInput
          style={styles.input}
          value={headCoach}
          onChangeText={setHeadCoach}
          placeholder="e.g. Coach Williams"
          placeholderTextColor={Colors.textMuted}
          maxLength={80}
        />

        <Text style={styles.label}>Practice Facility</Text>
        <TextInput
          style={styles.input}
          value={practiceFacility}
          onChangeText={setPracticeFacility}
          placeholder="e.g. Franklin Road Academy Gym"
          placeholderTextColor={Colors.textMuted}
          maxLength={100}
        />

        <Text style={styles.label}>Facility Address</Text>
        <TextInput
          style={styles.input}
          value={facilityAddress}
          onChangeText={setFacilityAddress}
          placeholder="e.g. 114 Libertyville Rd, Franklin, TN"
          placeholderTextColor={Colors.textMuted}
          maxLength={200}
        />

        <Text style={styles.label}>League / Circuit</Text>
        <TextInput
          style={styles.input}
          value={league}
          onChangeText={setLeague}
          placeholder="e.g. Nike EYBL, AAU District"
          placeholderTextColor={Colors.textMuted}
          maxLength={80}
        />

        <Text style={styles.label}>Max Roster Size</Text>
        <TextInput
          style={[styles.input, { width: 100 }]}
          value={maxRosterSize}
          onChangeText={(v) => setMaxRosterSize(v.replace(/[^0-9]/g, ''))}
          placeholder="15"
          placeholderTextColor={Colors.textMuted}
          keyboardType="number-pad"
          maxLength={2}
        />

        <Text style={styles.label}>Team Description</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="Notes, bio, or anything relevant to this team..."
          placeholderTextColor={Colors.textMuted}
          multiline
          numberOfLines={4}
          maxLength={500}
          textAlignVertical="top"
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

  sectionTitle: { fontSize: 16, fontWeight: '800', color: Colors.saintsBlue, marginBottom: 8, marginTop: 4 },

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
  multiline: {
    minHeight: 100,
    paddingTop: 12,
  },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: Colors.white,
    borderWidth: 1.5,
    borderColor: Colors.gray,
  },
  chipActive: {
    backgroundColor: Colors.saintsBlue,
    borderColor: Colors.saintsBlue,
  },
  chipText: { fontSize: 13, fontWeight: '600', color: Colors.textPrimary },
  chipTextActive: { color: Colors.white },

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
