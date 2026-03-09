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
import { useEventStore, EventType, EventInput, TeamEvent, getEventMeta } from '../../stores/eventStore';
import { useAuthStore } from '../../stores/authStore';
import { sanitizeText } from '../../lib/validation';

const EVENT_TYPES: { value: EventType; label: string; icon: string }[] = [
  { value: 'practice', label: 'Practice', icon: 'running' },
  { value: 'game', label: 'Game', icon: 'basketball-ball' },
  { value: 'tournament', label: 'Tournament', icon: 'trophy' },
  { value: 'meeting', label: 'Meeting', icon: 'users' },
  { value: 'other', label: 'Other', icon: 'calendar' },
];

const HOME_AWAY_OPTIONS: { value: 'home' | 'away' | 'neutral'; label: string }[] = [
  { value: 'home', label: 'Home' },
  { value: 'away', label: 'Away' },
  { value: 'neutral', label: 'Neutral' },
];

/** Pad a number to 2 digits */
function pad(n: number) {
  return n.toString().padStart(2, '0');
}

/** Build local ISO string without timezone (YYYY-MM-DDTHH:mm:ss) */
function toLocalISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

/** Format Date for display */
function displayDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function displayTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export default function EventFormScreen() {
  const { teamId, eventId } = useLocalSearchParams<{ teamId: string; eventId?: string }>();
  const router = useRouter();
  const profile = useAuthStore((s) => s.profile);
  const { addEvent, updateEvent } = useEventStore();

  const isEdit = !!eventId;

  // Form state
  const [type, setType] = useState<EventType>('practice');
  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState(new Date());
  const [endDate, setEndDate] = useState(new Date(Date.now() + 2 * 60 * 60 * 1000)); // +2h
  const [location, setLocation] = useState('');
  const [locationUrl, setLocationUrl] = useState('');
  const [description, setDescription] = useState('');
  const [opponent, setOpponent] = useState('');
  const [homeAway, setHomeAway] = useState<'home' | 'away' | 'neutral'>('home');
  const [isAllDay, setIsAllDay] = useState(false);

  // Native picker visibility
  const [showPicker, setShowPicker] = useState<null | 'startDate' | 'startTime' | 'endDate' | 'endTime'>(null);

  const [saving, setSaving] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(isEdit);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Load existing event for editing
  useEffect(() => {
    if (!isEdit || !teamId || !eventId) return;
    (async () => {
      const snap = await getDoc(doc(db, 'teams', teamId, 'events', eventId));
      if (snap.exists()) {
        const ev = snap.data() as TeamEvent;
        setType(ev.type);
        setTitle(ev.title);
        setStartDate(new Date(ev.startDate));
        setEndDate(new Date(ev.endDate));
        setLocation(ev.location ?? '');
        setLocationUrl(ev.locationUrl ?? '');
        setDescription(ev.description ?? '');
        setOpponent(ev.opponent ?? '');
        setHomeAway(ev.homeAway ?? 'home');
        setIsAllDay(ev.isAllDay ?? false);
      }
      setLoadingExisting(false);
    })();
  }, [isEdit, teamId, eventId]);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    const trimmedTitle = title.trim();
    if (!trimmedTitle) e.title = 'Title is required';
    else if (trimmedTitle.length < 2) e.title = 'Title must be at least 2 characters';
    if (!isAllDay && endDate <= startDate) e.endDate = 'End time must be after start time';
    if (locationUrl.trim() && !/^https?:\/\/.+/i.test(locationUrl.trim())) {
      e.locationUrl = 'Must be a valid URL (https://...)';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async () => {
    if (!validate() || !teamId || !profile) return;
    setSaving(true);
    try {
      const data: EventInput = {
        title: sanitizeText(title.trim()),
        type,
        startDate: toLocalISO(startDate),
        endDate: toLocalISO(endDate),
        location: sanitizeText(location.trim()) || undefined,
        locationUrl: locationUrl.trim() || undefined,
        description: sanitizeText(description.trim()) || undefined,
        opponent: (type === 'game' || type === 'tournament') ? sanitizeText(opponent.trim()) || undefined : undefined,
        homeAway: (type === 'game' || type === 'tournament') ? homeAway : undefined,
        isAllDay: isAllDay || undefined,
        createdBy: profile.uid,
      };

      if (isEdit && eventId) {
        await updateEvent(teamId, eventId, data);
      } else {
        await addEvent(teamId, data);
      }
      router.back();
    } catch {
      setErrors({ form: 'Failed to save event. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  // Native picker handler
  const handlePickerChange = (pickerType: string, selectedDate?: Date) => {
    setShowPicker(null);
    if (!selectedDate) return;
    if (pickerType === 'startDate' || pickerType === 'startTime') {
      const updated = new Date(startDate);
      if (pickerType === 'startDate') {
        updated.setFullYear(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
      } else {
        updated.setHours(selectedDate.getHours(), selectedDate.getMinutes());
      }
      setStartDate(updated);
      // Auto-adjust end if it's before start
      if (endDate <= updated) setEndDate(new Date(updated.getTime() + 2 * 60 * 60 * 1000));
    } else {
      const updated = new Date(endDate);
      if (pickerType === 'endDate') {
        updated.setFullYear(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
      } else {
        updated.setHours(selectedDate.getHours(), selectedDate.getMinutes());
      }
      setEndDate(updated);
    }
  };

  if (loadingExisting) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.saintsBlue} />
      </View>
    );
  }

  const isGameType = type === 'game' || type === 'tournament';

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {errors.form && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{errors.form}</Text>
          </View>
        )}

        {/* Event Type */}
        <Text style={styles.label}>Event Type</Text>
        <View style={styles.typeRow}>
          {EVENT_TYPES.map((t) => {
            const meta = getEventMeta(t.value);
            const active = type === t.value;
            return (
              <TouchableOpacity
                key={t.value}
                style={[styles.typeChip, active && { backgroundColor: meta.color, borderColor: meta.color }]}
                onPress={() => setType(t.value)}
              >
                <FontAwesome5 name={t.icon} size={13} color={active ? Colors.white : Colors.textSecondary} />
                <Text style={[styles.typeChipText, active && { color: Colors.white }]}>{t.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Title */}
        <Text style={styles.label}>Title *</Text>
        <TextInput
          style={[styles.input, errors.title && styles.inputError]}
          placeholder="e.g. Practice at Wilson Gym"
          placeholderTextColor={Colors.textMuted}
          value={title}
          onChangeText={setTitle}
          maxLength={120}
        />
        {errors.title && <Text style={styles.errorText}>{errors.title}</Text>}

        {/* All Day Toggle */}
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>All Day Event</Text>
          <Switch
            value={isAllDay}
            onValueChange={setIsAllDay}
            trackColor={{ false: Colors.gray, true: Colors.saintsBlue }}
            thumbColor={Colors.white}
          />
        </View>

        {/* Start Date / Time */}
        <Text style={styles.label}>Start</Text>
        {Platform.OS === 'web' ? (
          <View style={styles.webDateTimeRow}>
            <input
              type="date"
              value={startDate.toISOString().slice(0, 10)}
              onChange={(e) => {
                const d = new Date(e.target.value + 'T' + pad(startDate.getHours()) + ':' + pad(startDate.getMinutes()));
                if (!isNaN(d.getTime())) setStartDate(d);
              }}
              style={webInputStyle}
            />
            {!isAllDay && (
              <input
                type="time"
                step="900"
                value={`${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number);
                  const d = new Date(startDate);
                  d.setHours(h, m);
                  setStartDate(d);
                }}
                style={webInputStyle}
              />
            )}
          </View>
        ) : (
          <View style={styles.dateTimeRow}>
            <TouchableOpacity style={styles.dateBtn} onPress={() => setShowPicker('startDate')}>
              <FontAwesome5 name="calendar-alt" size={14} color={Colors.saintsBlue} />
              <Text style={styles.dateBtnText}>{displayDate(startDate)}</Text>
            </TouchableOpacity>
            {!isAllDay && (
              <TouchableOpacity style={styles.dateBtn} onPress={() => setShowPicker('startTime')}>
                <FontAwesome5 name="clock" size={14} color={Colors.saintsBlue} />
                <Text style={styles.dateBtnText}>{displayTime(startDate)}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* End Date / Time */}
        {!isAllDay && (
          <>
            <Text style={styles.label}>End</Text>
            {Platform.OS === 'web' ? (
              <View style={styles.webDateTimeRow}>
                <input
                  type="date"
                  value={endDate.toISOString().slice(0, 10)}
                  onChange={(e) => {
                    const d = new Date(e.target.value + 'T' + pad(endDate.getHours()) + ':' + pad(endDate.getMinutes()));
                    if (!isNaN(d.getTime())) setEndDate(d);
                  }}
                  style={webInputStyle}
                />
                <input
                  type="time"
                  step="900"
                  value={`${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(':').map(Number);
                    const d = new Date(endDate);
                    d.setHours(h, m);
                    setEndDate(d);
                  }}
                  style={webInputStyle}
                />
              </View>
            ) : (
              <View style={styles.dateTimeRow}>
                <TouchableOpacity style={styles.dateBtn} onPress={() => setShowPicker('endDate')}>
                  <FontAwesome5 name="calendar-alt" size={14} color={Colors.saintsBlue} />
                  <Text style={styles.dateBtnText}>{displayDate(endDate)}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.dateBtn} onPress={() => setShowPicker('endTime')}>
                  <FontAwesome5 name="clock" size={14} color={Colors.saintsBlue} />
                  <Text style={styles.dateBtnText}>{displayTime(endDate)}</Text>
                </TouchableOpacity>
              </View>
            )}
            {errors.endDate && <Text style={styles.errorText}>{errors.endDate}</Text>}
          </>
        )}

        {/* Native Pickers (iOS/Android only) */}
        {showPicker && Platform.OS !== 'web' && (
          <DateTimePicker
            value={showPicker.startsWith('start') ? startDate : endDate}
            mode={showPicker.endsWith('Date') ? 'date' : 'time'}
            minuteInterval={15}
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(_e: any, date?: Date) => handlePickerChange(showPicker, date)}
          />
        )}

        {/* Location */}
        <Text style={styles.label}>Location</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Wilson Gym, 123 Court Ave"
          placeholderTextColor={Colors.textMuted}
          value={location}
          onChangeText={setLocation}
          maxLength={200}
        />

        {/* Location URL */}
        <Text style={styles.label}>Map Link (optional)</Text>
        <TextInput
          style={[styles.input, errors.locationUrl && styles.inputError]}
          placeholder="https://maps.google.com/..."
          placeholderTextColor={Colors.textMuted}
          value={locationUrl}
          onChangeText={setLocationUrl}
          autoCapitalize="none"
          keyboardType="url"
          maxLength={500}
        />
        {errors.locationUrl && <Text style={styles.errorText}>{errors.locationUrl}</Text>}

        {/* Opponent & Home/Away (games only) */}
        {isGameType && (
          <>
            <Text style={styles.label}>Opponent</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Nashville Hawks"
              placeholderTextColor={Colors.textMuted}
              value={opponent}
              onChangeText={setOpponent}
              maxLength={100}
            />

            <Text style={styles.label}>Home / Away</Text>
            <View style={styles.typeRow}>
              {HOME_AWAY_OPTIONS.map((opt) => {
                const active = homeAway === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.typeChip, active && { backgroundColor: Colors.saintsBlue, borderColor: Colors.saintsBlue }]}
                    onPress={() => setHomeAway(opt.value)}
                  >
                    <Text style={[styles.typeChipText, active && { color: Colors.white }]}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}

        {/* Description */}
        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          placeholder="Additional details..."
          placeholderTextColor={Colors.textMuted}
          value={description}
          onChangeText={setDescription}
          multiline
          numberOfLines={4}
          maxLength={1000}
        />

        {/* Save Button */}
        <TouchableOpacity style={[styles.saveBtn, saving && styles.saveBtnDisabled]} onPress={handleSave} disabled={saving}>
          {saving ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <>
              <FontAwesome5 name={isEdit ? 'save' : 'plus-circle'} size={16} color={Colors.white} />
              <Text style={styles.saveBtnText}>{isEdit ? 'Save Changes' : 'Create Event'}</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const webInputStyle: React.CSSProperties = {
  fontSize: 15,
  padding: '10px 14px',
  borderRadius: 10,
  border: `1.5px solid ${Colors.gray}`,
  backgroundColor: Colors.white,
  color: Colors.textPrimary,
  flex: 1,
  outline: 'none',
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.light },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  errorBanner: { backgroundColor: '#fdecea', padding: 12, borderRadius: 10, marginBottom: 16 },
  errorBannerText: { color: Colors.danger, fontWeight: '600', textAlign: 'center' },

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
  inputError: { borderColor: Colors.danger },
  errorText: { color: Colors.danger, fontSize: 12, fontWeight: '600', marginTop: 4 },
  textArea: { minHeight: 90, textAlignVertical: 'top' },

  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: Colors.gray,
    backgroundColor: Colors.white,
  },
  typeChipText: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },

  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  switchLabel: { fontSize: 15, fontWeight: '600', color: Colors.textPrimary },

  dateTimeRow: { flexDirection: 'row', gap: 10 },
  dateBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.white,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.gray,
  },
  dateBtnText: { fontSize: 15, color: Colors.textPrimary },

  webDateTimeRow: {
    flexDirection: 'row',
    gap: 10,
  },

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
});
