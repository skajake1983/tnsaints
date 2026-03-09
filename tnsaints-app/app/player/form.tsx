import React, { useEffect, useState } from 'react';
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
  Switch,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Colors } from '../../constants/Colors';
import { useRosterStore, Player, PlayerInput, MemberRole, Gender, SiblingLink, fetchTeamPlayers } from '../../stores/rosterStore';
import { useTeamStore } from '../../stores/teamStore';
import { usePermissions } from '../../hooks/usePermissions';
import {
  sanitizeText,
  sanitizeAddress,
  isValidEmail,
  isValidPhone,
  isValidBirthdate,
  isValidJersey,
  isValidHeight,
  isValidWeight,
  isValidName,
  formatPhone,
} from '../../lib/validation';

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
const ROLES: { value: MemberRole; label: string; icon: string }[] = [
  { value: 'player', label: 'Player', icon: 'basketball-ball' },
  { value: 'parent', label: 'Parent', icon: 'user-friends' },
  { value: 'coach', label: 'Coach', icon: 'clipboard-list' },
];
const GENDERS: { value: Gender; label: string }[] = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
];

export default function PlayerFormScreen() {
  const { teamId, playerId } = useLocalSearchParams<{ teamId: string; playerId?: string }>();
  const router = useRouter();
  const { addPlayer, updatePlayer } = useRosterStore();
  const { can } = usePermissions();
  const isSuperAdmin = usePermissions().role === 'superadmin';

  const isEdit = !!playerId;

  // Core fields
  const [role, setRole] = useState<MemberRole>('player');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [birthdate, setBirthdate] = useState(''); // YYYY-MM-DD
  const [email, setEmail] = useState('');
  const [gender, setGender] = useState<Gender>('male');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');

  // Player-specific fields
  const [jerseyNumber, setJerseyNumber] = useState('');
  const [position, setPosition] = useState('PG');
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');

  // Parent/Guardian info (for players)
  const [parentName, setParentName] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [parentPhone, setParentPhone] = useState('');

  const [active, setActive] = useState(true);
  const [sendInvite, setSendInvite] = useState(false);
  const [isParentOfPlayer, setIsParentOfPlayer] = useState(false);
  const [linkedPlayerIds, setLinkedPlayerIds] = useState<string[]>([]);
  const [linkedParentIds, setLinkedParentIds] = useState<string[]>([]);
  const [linkedSiblingIds, setLinkedSiblingIds] = useState<SiblingLink[]>([]);
  const [crossTeamMode, setCrossTeamMode] = useState(false);
  const [crossTeamId, setCrossTeamId] = useState<string | null>(null);
  const [crossTeamPlayers, setCrossTeamPlayers] = useState<Player[]>([]);
  const [loadingCrossTeam, setLoadingCrossTeam] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingPlayer, setLoadingPlayer] = useState(isEdit);
  const [formError, setFormError] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [birthdateObj, setBirthdateObj] = useState<Date | null>(null);

  // Get the roster's players for the "Parent of Player" dropdown
  const rosterPlayers = useRosterStore((s) => s.players).filter(
    (p) => p.role === 'player' && (!playerId || p.id !== playerId),
  );

  // Get parents/coaches for linking from a player
  const rosterParents = useRosterStore((s) => s.players).filter(
    (p) => (p.role === 'parent' || p.role === 'coach') && (!playerId || p.id !== playerId),
  );

  // Get players for sibling linking (exclude self)
  const rosterSiblingCandidates = useRosterStore((s) => s.players).filter(
    (p) => p.role === 'player' && (!playerId || p.id !== playerId),
  );

  // Teams for cross-team sibling selector (exclude current team)
  const allTeams = useTeamStore((s) => s.teams);
  const otherTeams = allTeams.filter((t) => t.id !== teamId);

  // Load existing player for edit mode
  useEffect(() => {
    if (!isEdit || !teamId || !playerId) return;
    const load = async () => {
      const ref = doc(db, 'teams', teamId, 'players', playerId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const p = snap.data() as Omit<Player, 'id'>;
        setRole(p.role ?? 'player');
        setFirstName(p.firstName);
        setLastName(p.lastName);
        setBirthdate(p.birthdate ?? '');
        setEmail(p.email ?? '');
        setGender(p.gender ?? 'male');
        setPhone(p.phone ?? '');
        setAddress(p.address ?? '');
        setJerseyNumber(p.jerseyNumber != null ? String(p.jerseyNumber) : '');
        setPosition(p.position ?? 'PG');
        setHeight(p.height ?? '');
        setWeight(p.weight ? String(p.weight) : '');
        setParentName(p.parentName ?? '');
        setParentEmail(p.parentEmail ?? '');
        setParentPhone(p.parentPhone ?? '');
        setActive(p.active);
        setSendInvite(p.sendInvite ?? false);
        setLinkedPlayerIds(p.linkedPlayerIds ?? []);
        setLinkedParentIds(p.linkedParentIds ?? []);
        setLinkedSiblingIds(p.linkedSiblingIds ?? []);
        if ((p.linkedSiblingIds ?? []).some((s: SiblingLink) => s.teamId !== teamId)) {
          setCrossTeamMode(true);
        }
        if (p.role === 'coach' && (p.linkedPlayerIds?.length ?? 0) > 0) {
          setIsParentOfPlayer(true);
        }
        if (p.birthdate) {
          setBirthdateObj(new Date(p.birthdate + 'T00:00:00'));
        }
      }
      setLoadingPlayer(false);
    };
    load();
  }, [isEdit, teamId, playerId]);

  const handleSave = async () => {
    setFormError('');

    // Sanitize text inputs
    const cleanFirst = sanitizeText(firstName);
    const cleanLast = sanitizeText(lastName);
    const cleanEmail = sanitizeText(email);
    const cleanPhone = sanitizeText(phone);
    const cleanAddress = sanitizeAddress(address);
    const cleanParentName = sanitizeText(parentName);
    const cleanParentEmail = sanitizeText(parentEmail);
    const cleanParentPhone = sanitizeText(parentPhone);

    // Name validation
    if (!cleanFirst || !cleanLast) {
      setFormError('First and last name are required.');
      return;
    }
    if (!isValidName(cleanFirst)) {
      setFormError('First name contains invalid characters.');
      return;
    }
    if (!isValidName(cleanLast)) {
      setFormError('Last name contains invalid characters.');
      return;
    }

    // Birthdate validation
    if (!birthdate.trim()) {
      setFormError('Birthdate is required.');
      return;
    }
    if (!isValidBirthdate(birthdate)) {
      setFormError('Birthdate must be a valid past date (YYYY-MM-DD).');
      return;
    }

    // Email validation (optional but must be valid if provided)
    if (cleanEmail && !isValidEmail(cleanEmail)) {
      setFormError('Please enter a valid email address.');
      return;
    }

    // Phone validation (optional but must be valid if provided)
    if (cleanPhone && !isValidPhone(cleanPhone)) {
      setFormError('Please enter a valid phone number.');
      return;
    }

    // Player-specific validations
    let jersey: number | undefined;
    if (role === 'player') {
      if (jerseyNumber.trim()) {
        if (!isValidJersey(jerseyNumber.trim())) {
          setFormError('Jersey number must be 0–99.');
          return;
        }
        jersey = parseInt(jerseyNumber, 10);
      }
      if (height.trim() && !isValidHeight(height.trim())) {
        setFormError('Height format should be like 5\'10" or 6\'2.');
        return;
      }
      if (weight.trim() && !isValidWeight(weight.trim())) {
        setFormError('Weight must be a valid number (lbs).');
        return;
      }
      // Parent info validation
      if (cleanParentEmail && !isValidEmail(cleanParentEmail)) {
        setFormError('Parent email is not valid.');
        return;
      }
      if (cleanParentPhone && !isValidPhone(cleanParentPhone)) {
        setFormError('Parent phone is not valid.');
        return;
      }
    }

    // Invite requires email
    if (sendInvite && !cleanEmail) {
      setFormError('An email address is required to send an invite.');
      return;
    }

    const data: PlayerInput = {
      role,
      firstName: cleanFirst,
      lastName: cleanLast,
      birthdate: birthdate.trim(),
      email: cleanEmail || undefined,
      gender,
      phone: cleanPhone ? formatPhone(cleanPhone) : undefined,
      address: cleanAddress || undefined,
      jerseyNumber: jersey,
      position: role === 'player' ? position : undefined,
      height: height.trim() || undefined,
      weight: weight.trim() ? parseInt(weight, 10) : undefined,
      parentName: role === 'player' ? cleanParentName || undefined : undefined,
      parentEmail: role === 'player' ? cleanParentEmail || undefined : undefined,
      parentPhone: role === 'player' ? (cleanParentPhone ? formatPhone(cleanParentPhone) : undefined) : undefined,
      active: role === 'player' ? active : true,
      sendInvite: sendInvite && !!cleanEmail,
      linkedPlayerIds:
        role === 'parent'
          ? linkedPlayerIds
          : role === 'coach' && isParentOfPlayer
            ? linkedPlayerIds
            : undefined,
      linkedParentIds:
        role === 'player' ? linkedParentIds : undefined,
      linkedSiblingIds:
        role === 'player' ? linkedSiblingIds : undefined,
    };

    setSaving(true);
    if (isEdit && playerId) {
      await updatePlayer(teamId!, playerId, data);
    } else {
      await addPlayer(teamId!, data);
    }
    setSaving(false);
    router.back();
  };

  if (loadingPlayer) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.saintsBlue} />
      </View>
    );
  }

  const roleLabel = ROLES.find((r) => r.value === role)?.label ?? 'Member';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <Text style={styles.heading}>{isEdit ? `Edit ${roleLabel}` : 'Add to Roster'}</Text>

        {formError ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{formError}</Text>
          </View>
        ) : null}

        {/* Role Picker */}
        <Text style={styles.sectionLabel}>Role *</Text>
        <View style={styles.roleRow}>
          {ROLES.map((r) => (
            <TouchableOpacity
              key={r.value}
              style={[styles.roleChip, role === r.value && styles.roleChipActive]}
              onPress={() => setRole(r.value)}
            >
              <FontAwesome5
                name={r.icon}
                size={16}
                color={role === r.value ? Colors.white : Colors.textSecondary}
              />
              <Text style={[styles.roleChipText, role === r.value && styles.roleChipTextActive]}>
                {r.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Personal Info */}
        <Text style={styles.sectionLabel}>Personal Information</Text>

        <View style={styles.row}>
          <View style={styles.halfField}>
            <Text style={styles.label}>First Name *</Text>
            <TextInput style={styles.input} value={firstName} onChangeText={setFirstName} placeholder="First" placeholderTextColor={Colors.textMuted} autoCapitalize="words" />
          </View>
          <View style={styles.halfField}>
            <Text style={styles.label}>Last Name *</Text>
            <TextInput style={styles.input} value={lastName} onChangeText={setLastName} placeholder="Last" placeholderTextColor={Colors.textMuted} autoCapitalize="words" />
          </View>
        </View>

        <Text style={styles.label}>Birthdate *</Text>
        {Platform.OS === 'web' ? (
          <View style={styles.datePickerBtn}>
            <FontAwesome5 name="calendar-alt" size={16} color={Colors.saintsBlue} />
            <input
              type="date"
              value={birthdate}
              max={new Date().toISOString().split('T')[0]}
              min="1920-01-01"
              onChange={(e: any) => {
                const val = e.target.value;
                setBirthdate(val);
                if (val) setBirthdateObj(new Date(val + 'T00:00:00'));
              }}
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                fontSize: 15,
                color: Colors.textPrimary,
                backgroundColor: 'transparent',
                fontFamily: 'inherit',
              }}
            />
          </View>
        ) : (
          <>
            <TouchableOpacity
              style={styles.datePickerBtn}
              onPress={() => setShowDatePicker(true)}
            >
              <FontAwesome5 name="calendar-alt" size={16} color={Colors.saintsBlue} />
              <Text style={[styles.datePickerText, !birthdate && styles.datePickerPlaceholder]}>
                {birthdate || 'Select date'}
              </Text>
            </TouchableOpacity>
            {showDatePicker && (
              <DateTimePicker
                value={birthdateObj ?? new Date(2010, 0, 1)}
                mode="date"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                maximumDate={new Date()}
                minimumDate={new Date(1920, 0, 1)}
                onChange={(event, selectedDate) => {
                  setShowDatePicker(Platform.OS === 'ios');
                  if (selectedDate) {
                    setBirthdateObj(selectedDate);
                    const y = selectedDate.getFullYear();
                    const m = String(selectedDate.getMonth() + 1).padStart(2, '0');
                    const d = String(selectedDate.getDate()).padStart(2, '0');
                    setBirthdate(`${y}-${m}-${d}`);
                  }
                }}
              />
            )}
          </>
        )}

        {/* Gender */}
        <Text style={styles.label}>Gender *</Text>
        <View style={styles.genderRow}>
          {GENDERS.map((g) => (
            <TouchableOpacity
              key={g.value}
              style={[styles.genderChip, gender === g.value && styles.genderChipActive]}
              onPress={() => setGender(g.value)}
            >
              <Text style={[styles.genderChipText, gender === g.value && styles.genderChipTextActive]}>
                {g.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Contact Info */}
        <Text style={styles.sectionLabel}>Contact Information</Text>

        <Text style={styles.label}>Email (for invites)</Text>
        <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="name@email.com" placeholderTextColor={Colors.textMuted} keyboardType="email-address" autoCapitalize="none" />

        <Text style={styles.label}>Phone</Text>
        <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="(615) 555-1234" placeholderTextColor={Colors.textMuted} keyboardType="phone-pad" />

        <Text style={styles.label}>Address</Text>
        <TextInput
          style={[styles.input, styles.multilineInput]}
          value={address}
          onChangeText={setAddress}
          placeholder="Street, City, State ZIP"
          placeholderTextColor={Colors.textMuted}
          multiline
          numberOfLines={2}
        />

        {/* Player-specific fields */}
        {role === 'player' && (
          <>
            <Text style={styles.sectionLabel}>Player Details</Text>

            <View style={styles.row}>
              <View style={styles.halfField}>
                <Text style={styles.label}>Jersey #</Text>
                <TextInput style={styles.input} value={jerseyNumber} onChangeText={setJerseyNumber} placeholder="0–99" placeholderTextColor={Colors.textMuted} keyboardType="number-pad" maxLength={2} />
              </View>
              <View style={styles.halfField}>
                <Text style={styles.label}>Height</Text>
                <TextInput style={styles.input} value={height} onChangeText={setHeight} placeholder={`5'10"`} placeholderTextColor={Colors.textMuted} />
              </View>
            </View>

            <Text style={styles.label}>Position</Text>
            <View style={styles.positionRow}>
              {POSITIONS.map((pos) => (
                <TouchableOpacity
                  key={pos}
                  style={[styles.posChip, position === pos && styles.posChipActive]}
                  onPress={() => setPosition(pos)}
                >
                  <Text style={[styles.posChipText, position === pos && styles.posChipTextActive]}>
                    {pos}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>Weight (lbs)</Text>
            <TextInput style={styles.input} value={weight} onChangeText={setWeight} placeholder="150" placeholderTextColor={Colors.textMuted} keyboardType="number-pad" />

            {/* Parent/Guardian info (for players) */}
            <Text style={styles.sectionLabel}>Parent / Guardian</Text>

            <Text style={styles.label}>Parent Name</Text>
            <TextInput style={styles.input} value={parentName} onChangeText={setParentName} placeholder="Full name" placeholderTextColor={Colors.textMuted} autoCapitalize="words" />

            <Text style={styles.label}>Parent Email</Text>
            <TextInput style={styles.input} value={parentEmail} onChangeText={setParentEmail} placeholder="parent@email.com" placeholderTextColor={Colors.textMuted} keyboardType="email-address" autoCapitalize="none" />

            <Text style={styles.label}>Parent Phone</Text>
            <TextInput style={styles.input} value={parentPhone} onChangeText={setParentPhone} placeholder="(615) 555-1234" placeholderTextColor={Colors.textMuted} keyboardType="phone-pad" />

            {/* Link to existing parent/coach on roster */}
            {rosterParents.length > 0 && (
              <View style={styles.linkedSection}>
                <Text style={[styles.sectionLabel, { marginTop: 24 }]}>Link to Parent / Guardian</Text>
                <Text style={styles.linkedHint}>Select which parent or coach on the roster is this player's guardian.</Text>
                <View style={styles.linkedList}>
                  {rosterParents.map((p) => {
                    const selected = linkedParentIds.includes(p.id);
                    const roleTag = p.role === 'coach' ? ' (Coach)' : '';
                    return (
                      <TouchableOpacity
                        key={p.id}
                        style={[styles.linkedChip, selected && styles.linkedChipActive]}
                        onPress={() =>
                          setLinkedParentIds((prev) =>
                            selected ? prev.filter((id) => id !== p.id) : [...prev, p.id],
                          )
                        }
                      >
                        <FontAwesome5
                          name={selected ? 'check-circle' : 'circle'}
                          size={14}
                          color={selected ? Colors.white : Colors.textMuted}
                          solid={selected}
                        />
                        <Text style={[styles.linkedChipText, selected && styles.linkedChipTextActive]}>
                          {p.firstName} {p.lastName}{roleTag}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Sibling links (same team) */}
            {rosterSiblingCandidates.length > 0 && (
              <View style={styles.linkedSection}>
                <Text style={[styles.sectionLabel, { marginTop: 24 }]}>Siblings on This Team</Text>
                <Text style={styles.linkedHint}>Select any siblings of this player on the same team.</Text>
                <View style={styles.linkedList}>
                  {rosterSiblingCandidates.map((p) => {
                    const selected = linkedSiblingIds.some(
                      (s) => s.playerId === p.id && s.teamId === teamId,
                    );
                    return (
                      <TouchableOpacity
                        key={p.id}
                        style={[styles.linkedChip, selected && styles.linkedChipActive]}
                        onPress={() =>
                          setLinkedSiblingIds((prev) =>
                            selected
                              ? prev.filter((s) => !(s.playerId === p.id && s.teamId === teamId))
                              : [...prev, { playerId: p.id, teamId: teamId! }],
                          )
                        }
                      >
                        <FontAwesome5
                          name={selected ? 'check-circle' : 'circle'}
                          size={14}
                          color={selected ? Colors.white : Colors.textMuted}
                          solid={selected}
                        />
                        <Text style={[styles.linkedChipText, selected && styles.linkedChipTextActive]}>
                          {p.firstName} {p.lastName}
                          {p.jerseyNumber != null ? ` #${p.jerseyNumber}` : ''}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Cross-team sibling linking (superadmin only) */}
            {isSuperAdmin && otherTeams.length > 0 && (
              <>
                <View style={styles.toggleRow}>
                  <View style={styles.toggleLabelGroup}>
                    <Text style={styles.toggleLabel}>Sibling on Another Team</Text>
                    <Text style={styles.toggleHint}>
                      Link this player to a sibling on a different team.
                    </Text>
                  </View>
                  <Switch
                    value={crossTeamMode}
                    onValueChange={(v) => {
                      setCrossTeamMode(v);
                      if (!v) {
                        setCrossTeamId(null);
                        setCrossTeamPlayers([]);
                      }
                    }}
                    trackColor={{ false: Colors.gray, true: Colors.saintsBlue }}
                    thumbColor={crossTeamMode ? Colors.saintsGold : Colors.white}
                  />
                </View>
                {crossTeamMode && (
                  <View style={styles.linkedSection}>
                    <Text style={styles.label}>Select Team</Text>
                    <View style={styles.linkedList}>
                      {otherTeams.map((t) => {
                        const selected = crossTeamId === t.id;
                        return (
                          <TouchableOpacity
                            key={t.id}
                            style={[styles.linkedChip, selected && styles.linkedChipActive]}
                            onPress={async () => {
                              setCrossTeamId(t.id);
                              setLoadingCrossTeam(true);
                              try {
                                const players = await fetchTeamPlayers(t.id);
                                setCrossTeamPlayers(
                                  players.filter((p) => p.role === 'player'),
                                );
                              } catch {
                                setCrossTeamPlayers([]);
                              }
                              setLoadingCrossTeam(false);
                            }}
                          >
                            <FontAwesome5
                              name={selected ? 'check-circle' : 'circle'}
                              size={14}
                              color={selected ? Colors.white : Colors.textMuted}
                              solid={selected}
                            />
                            <Text
                              style={[
                                styles.linkedChipText,
                                selected && styles.linkedChipTextActive,
                              ]}
                            >
                              {t.name}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    {crossTeamId && (
                      <>
                        <Text style={[styles.label, { marginTop: 16 }]}>Select Sibling</Text>
                        {loadingCrossTeam ? (
                          <ActivityIndicator
                            size="small"
                            color={Colors.saintsBlue}
                            style={{ marginTop: 8 }}
                          />
                        ) : crossTeamPlayers.length === 0 ? (
                          <Text style={styles.linkedEmpty}>
                            No players on that team yet.
                          </Text>
                        ) : (
                          <View style={styles.linkedList}>
                            {crossTeamPlayers.map((p) => {
                              const selected = linkedSiblingIds.some(
                                (s) =>
                                  s.playerId === p.id && s.teamId === crossTeamId,
                              );
                              return (
                                <TouchableOpacity
                                  key={p.id}
                                  style={[
                                    styles.linkedChip,
                                    selected && styles.linkedChipActive,
                                  ]}
                                  onPress={() =>
                                    setLinkedSiblingIds((prev) =>
                                      selected
                                        ? prev.filter(
                                            (s) =>
                                              !(
                                                s.playerId === p.id &&
                                                s.teamId === crossTeamId
                                              ),
                                          )
                                        : [
                                            ...prev,
                                            {
                                              playerId: p.id,
                                              teamId: crossTeamId!,
                                            },
                                          ],
                                    )
                                  }
                                >
                                  <FontAwesome5
                                    name={selected ? 'check-circle' : 'circle'}
                                    size={14}
                                    color={
                                      selected ? Colors.white : Colors.textMuted
                                    }
                                    solid={selected}
                                  />
                                  <Text
                                    style={[
                                      styles.linkedChipText,
                                      selected && styles.linkedChipTextActive,
                                    ]}
                                  >
                                    {p.firstName} {p.lastName}
                                    {p.jerseyNumber != null
                                      ? ` #${p.jerseyNumber}`
                                      : ''}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        )}
                      </>
                    )}
                  </View>
                )}
              </>
            )}
          </>
        )}

        {/* Active toggle — only for players */}
        {role === 'player' && (
          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Active on Roster</Text>
            <Switch
              value={active}
              onValueChange={setActive}
              trackColor={{ false: Colors.gray, true: Colors.saintsBlue }}
              thumbColor={active ? Colors.saintsGold : Colors.white}
            />
          </View>
        )}

        {/* Coach: Parent of Player toggle */}
        {role === 'coach' && (
          <>
            <View style={styles.toggleRow}>
              <View style={styles.toggleLabelGroup}>
                <Text style={styles.toggleLabel}>Parent of Player</Text>
                <Text style={styles.toggleHint}>
                  Is this coach also a parent of a player on this team?
                </Text>
              </View>
              <Switch
                value={isParentOfPlayer}
                onValueChange={(v) => {
                  setIsParentOfPlayer(v);
                  if (!v) setLinkedPlayerIds([]);
                }}
                trackColor={{ false: Colors.gray, true: Colors.saintsBlue }}
                thumbColor={isParentOfPlayer ? Colors.saintsGold : Colors.white}
              />
            </View>
            {isParentOfPlayer && (
              <View style={styles.linkedSection}>
                <Text style={styles.label}>Select Child</Text>
                {rosterPlayers.length === 0 ? (
                  <Text style={styles.linkedEmpty}>No players on the roster yet.</Text>
                ) : (
                  <View style={styles.linkedList}>
                    {rosterPlayers.map((p) => {
                      const selected = linkedPlayerIds.includes(p.id);
                      return (
                        <TouchableOpacity
                          key={p.id}
                          style={[styles.linkedChip, selected && styles.linkedChipActive]}
                          onPress={() =>
                            setLinkedPlayerIds((prev) =>
                              selected ? prev.filter((id) => id !== p.id) : [...prev, p.id],
                            )
                          }
                        >
                          <FontAwesome5
                            name={selected ? 'check-circle' : 'circle'}
                            size={14}
                            color={selected ? Colors.white : Colors.textMuted}
                            solid={selected}
                          />
                          <Text style={[styles.linkedChipText, selected && styles.linkedChipTextActive]}>
                            {p.firstName} {p.lastName}
                            {p.jerseyNumber != null ? ` #${p.jerseyNumber}` : ''}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </View>
            )}
          </>
        )}

        {/* Parent: Linked Player (child) */}
        {role === 'parent' && (
          <View style={styles.linkedSection}>
            <Text style={styles.sectionLabel}>Linked Player (Child)</Text>
            <Text style={styles.linkedHint}>Select which player(s) this parent is a guardian of.</Text>
            {rosterPlayers.length === 0 ? (
              <Text style={styles.linkedEmpty}>No players on the roster yet. Add players first.</Text>
            ) : (
              <View style={styles.linkedList}>
                {rosterPlayers.map((p) => {
                  const selected = linkedPlayerIds.includes(p.id);
                  return (
                    <TouchableOpacity
                      key={p.id}
                      style={[styles.linkedChip, selected && styles.linkedChipActive]}
                      onPress={() =>
                        setLinkedPlayerIds((prev) =>
                          selected ? prev.filter((id) => id !== p.id) : [...prev, p.id],
                        )
                      }
                    >
                      <FontAwesome5
                        name={selected ? 'check-circle' : 'circle'}
                        size={14}
                        color={selected ? Colors.white : Colors.textMuted}
                        solid={selected}
                      />
                      <Text style={[styles.linkedChipText, selected && styles.linkedChipTextActive]}>
                        {p.firstName} {p.lastName}
                        {p.jerseyNumber != null ? ` #${p.jerseyNumber}` : ''}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        )}

        {/* Invite toggle — for players, parents, and coaches */}
        {(role === 'player' || role === 'parent' || role === 'coach') && (
          <View style={styles.toggleRow}>
            <View style={styles.toggleLabelGroup}>
              <Text style={styles.toggleLabel}>Send Invite to Sign Up</Text>
              <Text style={styles.toggleHint}>
                {role === 'parent'
                  ? "Invited parents can view this team's roster and schedules."
                  : role === 'coach'
                    ? 'Invited coaches can manage this team.'
                    : 'Invited players can view their schedule and RSVP.'}
              </Text>
            </View>
            <Switch
              value={sendInvite}
              onValueChange={setSendInvite}
              trackColor={{ false: Colors.gray, true: Colors.saintsBlue }}
              thumbColor={sendInvite ? Colors.saintsGold : Colors.white}
            />
          </View>
        )}

        {/* Save button */}
        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.8}
        >
          {saving ? (
            <ActivityIndicator color={Colors.saintsBlueDark} />
          ) : (
            <>
              <FontAwesome5 name="check" size={14} color={Colors.saintsBlueDark} />
              <Text style={styles.saveBtnText}>{isEdit ? 'Save Changes' : `Add ${roleLabel}`}</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Cancel */}
        <TouchableOpacity style={styles.cancelBtn} onPress={() => router.back()}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.light },
  inner: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  heading: {
    fontSize: 24,
    fontWeight: '800',
    color: Colors.saintsBlueDark,
    marginBottom: 20,
  },

  errorBox: {
    backgroundColor: '#fdecea',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  errorText: { color: Colors.danger, fontWeight: '600', fontSize: 13 },

  label: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textSecondary,
    marginBottom: 4,
    marginTop: 12,
  },
  sectionLabel: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginTop: 24,
    marginBottom: 4,
    borderTopWidth: 1,
    borderTopColor: Colors.gray,
    paddingTop: 20,
  },

  input: {
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.gray,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: Colors.textPrimary,
  },
  multilineInput: {
    minHeight: 60,
    textAlignVertical: 'top',
  },

  row: { flexDirection: 'row', gap: 12 },
  halfField: { flex: 1 },

  roleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  roleChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: Colors.gray,
    backgroundColor: Colors.white,
  },
  roleChipActive: {
    borderColor: Colors.saintsBlue,
    backgroundColor: Colors.saintsBlue,
  },
  roleChipText: { fontWeight: '700', fontSize: 14, color: Colors.textSecondary },
  roleChipTextActive: { color: Colors.white },

  genderRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  genderChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: Colors.gray,
    backgroundColor: Colors.white,
  },
  genderChipActive: {
    borderColor: Colors.saintsBlue,
    backgroundColor: Colors.saintsBlue,
  },
  genderChipText: { fontWeight: '700', fontSize: 14, color: Colors.textSecondary },
  genderChipTextActive: { color: Colors.white },

  positionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  posChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: Colors.gray,
    backgroundColor: Colors.white,
  },
  posChipActive: {
    borderColor: Colors.saintsBlue,
    backgroundColor: Colors.saintsBlue,
  },
  posChipText: { fontWeight: '700', fontSize: 14, color: Colors.textSecondary },
  posChipTextActive: { color: Colors.white },

  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 24,
    paddingVertical: 8,
  },
  toggleLabel: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  toggleLabelGroup: { flex: 1, marginRight: 12 },
  toggleHint: { fontSize: 12, color: Colors.textMuted, marginTop: 2 },

  linkedSection: {
    marginTop: 8,
  },
  linkedHint: {
    fontSize: 12,
    color: Colors.textMuted,
    marginBottom: 8,
  },
  linkedEmpty: {
    fontSize: 13,
    color: Colors.textMuted,
    fontStyle: 'italic',
    marginTop: 4,
  },
  linkedList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  linkedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Colors.white,
    borderWidth: 1.5,
    borderColor: Colors.gray,
  },
  linkedChipActive: {
    backgroundColor: Colors.saintsBlue,
    borderColor: Colors.saintsBlue,
  },
  linkedChipText: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  linkedChipTextActive: {
    color: Colors.white,
  },

  datePickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.gray,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  datePickerText: { fontSize: 15, color: Colors.textPrimary },
  datePickerPlaceholder: { color: Colors.textMuted },

  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.saintsGold,
    paddingVertical: 16,
    borderRadius: 12,
    marginTop: 28,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { fontWeight: '800', fontSize: 16, color: Colors.saintsBlueDark },

  cancelBtn: {
    alignItems: 'center',
    paddingVertical: 14,
    marginTop: 8,
  },
  cancelBtnText: { color: Colors.textMuted, fontWeight: '700', fontSize: 15 },
});
