import React, { useRef, useState } from 'react';
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
import {
  useTeamStore,
  TeamInput,
  SPORTS,
  Sport,
  AGE_GROUPS,
  AgeGroup,
  COUNTRIES,
  Country,
  TIME_ZONES,
  TimeZone,
} from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { sanitizeText } from '../../lib/validation';
import { cleanData } from '../../lib/firestoreHelpers';
import DropdownPicker from '../../components/DropdownPicker';

type FieldErrors = {
  name?: string;
  sport?: string;
  ageGroup?: string;
  country?: string;
  timeZone?: string;
};

export default function CreateTeamScreen() {
  const router = useRouter();
  const { addTeam, setActiveTeam } = useTeamStore();
  const profile = useAuthStore((s) => s.profile);
  const scrollRef = useRef<ScrollView>(null);

  const [name, setName] = useState('');
  const [sport, setSport] = useState<Sport | ''>('');
  const [ageGroup, setAgeGroup] = useState<AgeGroup | ''>('');
  const [country, setCountry] = useState<Country | ''>('');
  const [timeZone, setTimeZone] = useState<TimeZone | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState(false);

  const validate = (): FieldErrors => {
    const errs: FieldErrors = {};
    const cleanName = sanitizeText(name.trim());
    if (!cleanName) {
      errs.name = 'Team name is required.';
    } else if (cleanName.length < 2) {
      errs.name = 'Team name must be at least 2 characters.';
    } else if (cleanName.length > 80) {
      errs.name = 'Team name must be 80 characters or less.';
    }

    if (!sport) errs.sport = 'Please select a sport.';
    if (!ageGroup) errs.ageGroup = 'Please select a team age.';
    if (!country) errs.country = 'Please select a country.';
    if (!timeZone) errs.timeZone = 'Please select a time zone.';

    return errs;
  };

  const handleCreate = async () => {
    setTouched(true);
    setError('');
    const errs = validate();
    setFieldErrors(errs);

    if (Object.keys(errs).length > 0) {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      return;
    }

    if (!profile) {
      setError('You must be signed in.');
      return;
    }

    const cleanName = sanitizeText(name.trim());

    setSaving(true);
    try {
      const data: TeamInput = cleanData({
        name: cleanName,
        orgId: 'tn-saints',
        sport: sport || undefined,
        ageGroup: ageGroup || undefined,
        country: country || undefined,
        timeZone: timeZone || undefined,
      });
      const teamId = await addTeam(data);

      // Add the new team to the creator's teamIds
      const userRef = doc(db, 'users', profile.uid);
      await updateDoc(userRef, { teamIds: arrayUnion(teamId) });

      // Switch to the newly created team
      setActiveTeam(teamId);
      router.back();
    } catch (e: any) {
      const code = e?.code ?? '';
      if (code === 'permission-denied' || code === 'PERMISSION_DENIED') {
        setError('Permission denied. Only Super Admins can create teams.');
      } else if (code === 'unavailable' || code === 'deadline-exceeded') {
        setError('Network error. Please check your connection and try again.');
      } else {
        setError(e?.message ?? 'Failed to create team. Please try again.');
      }
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    } finally {
      setSaving(false);
    }
  };

  const fieldError = (key: keyof FieldErrors) =>
    touched && fieldErrors[key] ? (
      <Text style={styles.fieldError}>{fieldErrors[key]}</Text>
    ) : null;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        ref={scrollRef}
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.heading}>Create a New Team</Text>
        <Text style={styles.subheading}>Set up a new team under your organization.</Text>

        {error ? (
          <View style={styles.errorBox}>
            <FontAwesome5 name="exclamation-circle" size={14} color={Colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>Team Details</Text>

        <Text style={styles.label}>Team Name *</Text>
        <TextInput
          style={[styles.input, touched && fieldErrors.name ? styles.inputError : null]}
          value={name}
          onChangeText={setName}
          placeholder="e.g. TN Saints 12U Boys"
          placeholderTextColor={Colors.textMuted}
          maxLength={80}
          autoFocus
        />
        {fieldError('name')}

        <DropdownPicker
          label="Sport *"
          value={sport}
          options={SPORTS}
          onSelect={(v) => setSport(v as Sport)}
          placeholder="Select a sport…"
          hasError={touched && !!fieldErrors.sport}
        />
        {fieldError('sport')}

        <DropdownPicker
          label="Team Age *"
          value={ageGroup}
          options={AGE_GROUPS}
          onSelect={(v) => setAgeGroup(v as AgeGroup)}
          placeholder="Select age group…"
          hasError={touched && !!fieldErrors.ageGroup}
        />
        {fieldError('ageGroup')}

        <DropdownPicker
          label="Country *"
          value={country}
          options={COUNTRIES}
          onSelect={(v) => setCountry(v as Country)}
          placeholder="Select country…"
          hasError={touched && !!fieldErrors.country}
        />
        {fieldError('country')}

        <DropdownPicker
          label="Time Zone *"
          value={timeZone}
          options={TIME_ZONES.map((tz) => ({ label: tz.label, value: tz.value }))}
          onSelect={(v) => setTimeZone(v as TimeZone)}
          placeholder="Select time zone…"
          hasError={touched && !!fieldErrors.timeZone}
        />
        {fieldError('timeZone')}

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

  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fdecea',
    padding: 12,
    borderRadius: 10,
    marginBottom: 16,
  },
  errorText: { color: Colors.danger, fontWeight: '600', flex: 1 },

  fieldError: { color: Colors.danger, fontSize: 12, fontWeight: '600', marginTop: 4 },

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
  inputError: {
    borderColor: Colors.danger,
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
