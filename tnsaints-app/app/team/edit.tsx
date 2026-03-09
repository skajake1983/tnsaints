import React, { useEffect, useRef, useState } from 'react';
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Colors } from '../../constants/Colors';
import { useTeamStore, Team, AGE_GROUPS, AgeGroup, TeamGender } from '../../stores/teamStore';
import { sanitizeText, sanitizeAddress } from '../../lib/validation';
import { cleanData } from '../../lib/firestoreHelpers';

const GENDER_OPTIONS: { label: string; value: TeamGender }[] = [
  { label: 'Boys', value: 'boys' },
  { label: 'Girls', value: 'girls' },
  { label: 'Co-ed', value: 'coed' },
];

type FieldErrors = {
  name?: string;
  season?: string;
  ageGroup?: string;
  gender?: string;
  maxRosterSize?: string;
};

export default function EditTeamScreen() {
  const { teamId } = useLocalSearchParams<{ teamId: string }>();
  const router = useRouter();
  const { updateTeam } = useTeamStore();
  const scrollRef = useRef<ScrollView>(null);

  const [loadingTeam, setLoadingTeam] = useState(true);
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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!teamId) return;
    const load = async () => {
      const snap = await getDoc(doc(db, 'teams', teamId));
      if (snap.exists()) {
        const t = snap.data() as Omit<Team, 'id'>;
        setName(t.name ?? '');
        setSeason(t.season ?? '');
        setAgeGroup(t.ageGroup ?? '');
        setGender(t.gender ?? '');
        setHeadCoach(t.headCoach ?? '');
        setPracticeFacility(t.practiceFacility ?? '');
        setFacilityAddress(t.facilityAddress ?? '');
        setLeague(t.league ?? '');
        setMaxRosterSize(t.maxRosterSize != null ? String(t.maxRosterSize) : '15');
        setDescription(t.description ?? '');
      }
      setLoadingTeam(false);
    };
    load();
  }, [teamId]);

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

    if (!season.trim()) {
      errs.season = 'Season is required.';
    } else if (season.trim().length > 50) {
      errs.season = 'Season must be 50 characters or less.';
    }

    if (!ageGroup) {
      errs.ageGroup = 'Please select an age group.';
    }

    if (!gender) {
      errs.gender = 'Please select a gender.';
    }

    const rosterStr = maxRosterSize.trim();
    if (rosterStr) {
      const parsed = parseInt(rosterStr, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 30) {
        errs.maxRosterSize = 'Must be between 1 and 30.';
      }
    }

    return errs;
  };

  const handleSave = async () => {
    setTouched(true);
    setError('');
    const errs = validate();
    setFieldErrors(errs);

    if (Object.keys(errs).length > 0) {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      return;
    }

    if (!teamId) {
      setError('No team ID provided.');
      return;
    }

    const cleanName = sanitizeText(name.trim());
    const parsedRoster = parseInt(maxRosterSize.trim() || '15', 10);

    setSaving(true);
    try {
      const data = cleanData({
        name: cleanName,
        season: sanitizeText(season.trim()) || undefined,
        ageGroup: ageGroup || undefined,
        gender: gender || undefined,
        headCoach: sanitizeText(headCoach.trim()) || undefined,
        practiceFacility: sanitizeText(practiceFacility.trim()) || undefined,
        facilityAddress: sanitizeAddress(facilityAddress.trim()) || undefined,
        league: sanitizeText(league.trim()) || undefined,
        maxRosterSize: maxRosterSize.trim() ? parsedRoster : undefined,
        description: sanitizeText(description.trim()) || undefined,
      });
      await updateTeam(teamId, data);
      router.back();
    } catch (e: any) {
      const code = e?.code ?? '';
      if (code === 'permission-denied' || code === 'PERMISSION_DENIED') {
        setError('Permission denied. You do not have access to edit this team.');
      } else if (code === 'unavailable' || code === 'deadline-exceeded') {
        setError('Network error. Please check your connection and try again.');
      } else {
        setError(e?.message ?? 'Failed to update team. Please try again.');
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

  if (loadingTeam) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.saintsBlue} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        ref={scrollRef}
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.heading}>Edit Team</Text>
        <Text style={styles.subheading}>Update your team's details.</Text>

        {error ? (
          <View style={styles.errorBox}>
            <FontAwesome5 name="exclamation-circle" size={14} color={Colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* ── Required fields ─────────────────── */}
        <Text style={styles.sectionTitle}>Team Details</Text>

        <Text style={styles.label}>Team Name *</Text>
        <TextInput
          style={[styles.input, touched && fieldErrors.name ? styles.inputError : null]}
          value={name}
          onChangeText={setName}
          placeholder="e.g. TN Saints 12U Boys"
          placeholderTextColor={Colors.textMuted}
          maxLength={80}
        />
        {fieldError('name')}

        <Text style={styles.label}>Season *</Text>
        <TextInput
          style={[styles.input, touched && fieldErrors.season ? styles.inputError : null]}
          value={season}
          onChangeText={setSeason}
          placeholder="e.g. Spring 2026"
          placeholderTextColor={Colors.textMuted}
          maxLength={50}
        />
        {fieldError('season')}

        <Text style={styles.label}>Age Group *</Text>
        <View style={styles.chipRow}>
          {AGE_GROUPS.map((ag) => (
            <TouchableOpacity
              key={ag}
              style={[
                styles.chip,
                ageGroup === ag && styles.chipActive,
                touched && fieldErrors.ageGroup && !ageGroup ? styles.chipError : null,
              ]}
              onPress={() => setAgeGroup(ag)}
            >
              <Text style={[styles.chipText, ageGroup === ag && styles.chipTextActive]}>{ag}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {fieldError('ageGroup')}

        <Text style={styles.label}>Gender *</Text>
        <View style={styles.chipRow}>
          {GENDER_OPTIONS.map((g) => (
            <TouchableOpacity
              key={g.value}
              style={[
                styles.chip,
                gender === g.value && styles.chipActive,
                touched && fieldErrors.gender && !gender ? styles.chipError : null,
              ]}
              onPress={() => setGender(g.value)}
            >
              <Text style={[styles.chipText, gender === g.value && styles.chipTextActive]}>{g.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {fieldError('gender')}

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
          style={[styles.input, { width: 100 }, touched && fieldErrors.maxRosterSize ? styles.inputError : null]}
          value={maxRosterSize}
          onChangeText={(v) => setMaxRosterSize(v.replace(/[^0-9]/g, ''))}
          placeholder="15"
          placeholderTextColor={Colors.textMuted}
          keyboardType="number-pad"
          maxLength={2}
        />
        {fieldError('maxRosterSize')}

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
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <>
              <FontAwesome5 name="check-circle" size={16} color={Colors.white} />
              <Text style={styles.saveBtnText}>Save Changes</Text>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

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
  chipError: {
    borderColor: Colors.danger,
  },
  chipText: { fontSize: 13, fontWeight: '600', color: Colors.textPrimary },
  chipTextActive: { color: Colors.white },

  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.saintsBlue,
    paddingVertical: 16,
    borderRadius: 12,
    marginTop: 28,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: Colors.white, fontSize: 16, fontWeight: '800' },

  cancelBtn: { alignItems: 'center', paddingVertical: 14 },
  cancelBtnText: { color: Colors.textMuted, fontSize: 15, fontWeight: '600' },
});
