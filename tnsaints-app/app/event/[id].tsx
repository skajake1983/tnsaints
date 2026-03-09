import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
  Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Colors } from '../../constants/Colors';
import { TeamEvent, getEventMeta, formatEventDate, formatEventTime } from '../../stores/eventStore';
import { useEventStore } from '../../stores/eventStore';
import {
  useAvailabilityStore,
  Availability,
  RsvpStatus,
  summariseRsvps,
} from '../../stores/availabilityStore';
import { useAuthStore } from '../../stores/authStore';
import { usePermissions } from '../../hooks/usePermissions';

export default function EventDetailScreen() {
  const { id, teamId } = useLocalSearchParams<{ id: string; teamId: string }>();
  const router = useRouter();
  const profile = useAuthStore((s) => s.profile);
  const { can } = usePermissions();
  const removeEvent = useEventStore((s) => s.removeEvent);
  const { byEvent, listenEvent, setRsvp } = useAvailabilityStore();

  const [event, setEvent] = useState<TeamEvent | null>(null);
  const [loading, setLoading] = useState(true);

  // Listen to event document
  useEffect(() => {
    if (!id || !teamId) return;
    const ref = doc(db, 'teams', teamId, 'events', id);
    const unsub = onSnapshot(ref, (snap) => {
      if (snap.exists()) {
        setEvent({ id: snap.id, ...snap.data() } as TeamEvent);
      }
      setLoading(false);
    });
    return unsub;
  }, [id, teamId]);

  // Listen to availability for this event
  useEffect(() => {
    if (!id || !teamId) return;
    const unsub = listenEvent(teamId, id);
    return unsub;
  }, [id, teamId]);

  const rsvps: Availability[] = byEvent[id ?? ''] ?? [];
  const summary = summariseRsvps(rsvps);
  const myRsvp = rsvps.find((r) => r.uid === profile?.uid);

  const handleRsvp = async (status: RsvpStatus) => {
    if (!teamId || !id || !profile) return;
    await setRsvp(teamId, id, profile.uid, profile.name ?? '', status);
  };

  const handleDelete = () => {
    const doDelete = async () => {
      if (!teamId || !id) return;
      await removeEvent(teamId, id);
      router.back();
    };

    if (Platform.OS === 'web') {
      if (window.confirm(`Delete "${event?.title}"? This cannot be undone.`)) {
        doDelete();
      }
    } else {
      Alert.alert('Delete Event', `Delete "${event?.title}"? This cannot be undone.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.saintsBlue} />
      </View>
    );
  }

  if (!event) {
    return (
      <View style={styles.center}>
        <FontAwesome5 name="calendar-times" size={40} color={Colors.gray} />
        <Text style={styles.emptyTitle}>Event not found</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const meta = getEventMeta(event.type);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header card */}
      <View style={styles.headerCard}>
        <View style={[styles.typeStrip, { backgroundColor: meta.color }]} />
        <View style={styles.headerBody}>
          <View style={styles.typeRow}>
            <FontAwesome5 name={meta.icon} size={14} color={meta.color} />
            <Text style={styles.typeLabel}>{meta.label}</Text>
            {event.homeAway && (
              <View style={styles.homeAwayBadge}>
                <Text style={styles.homeAwayText}>{event.homeAway.toUpperCase()}</Text>
              </View>
            )}
          </View>
          <Text style={styles.title}>{event.title}</Text>
          {event.opponent && (
            <Text style={styles.opponent}>vs {event.opponent}</Text>
          )}
        </View>
      </View>

      {/* Details */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Details</Text>

        <View style={styles.detailRow}>
          <FontAwesome5 name="calendar-alt" size={14} color={Colors.saintsBlue} style={styles.detailIcon} />
          <Text style={styles.detailText}>{formatEventDate(event.startDate)}</Text>
        </View>

        <View style={styles.detailRow}>
          <FontAwesome5 name="clock" size={14} color={Colors.saintsBlue} style={styles.detailIcon} />
          <Text style={styles.detailText}>
            {event.isAllDay
              ? 'All Day'
              : `${formatEventTime(event.startDate)} – ${formatEventTime(event.endDate)}`}
          </Text>
        </View>

        {event.location && (
          <TouchableOpacity
            style={styles.detailRow}
            onPress={() => {
              if (event.locationUrl) Linking.openURL(event.locationUrl);
            }}
            disabled={!event.locationUrl}
          >
            <FontAwesome5 name="map-marker-alt" size={14} color={Colors.saintsBlue} style={styles.detailIcon} />
            <Text style={[styles.detailText, event.locationUrl && styles.linkText]}>
              {event.location}
            </Text>
            {event.locationUrl && (
              <FontAwesome5 name="external-link-alt" size={10} color={Colors.saintsBlue} style={{ marginLeft: 6 }} />
            )}
          </TouchableOpacity>
        )}

        {event.description && (
          <View style={[styles.detailRow, { alignItems: 'flex-start', marginTop: 8 }]}>
            <FontAwesome5 name="align-left" size={14} color={Colors.saintsBlue} style={styles.detailIcon} />
            <Text style={styles.detailText}>{event.description}</Text>
          </View>
        )}
      </View>

      {/* RSVP Section — any member can mark their own */}
      {can('availability.markOwn') && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Your RSVP</Text>
          <View style={styles.rsvpButtonRow}>
            {(['in', 'out', 'maybe'] as RsvpStatus[]).map((status) => {
              const isActive = myRsvp?.status === status;
              const btnStyle =
                status === 'in'
                  ? styles.rsvpBtnIn
                  : status === 'out'
                    ? styles.rsvpBtnOut
                    : styles.rsvpBtnMaybe;
              const activeStyle =
                status === 'in'
                  ? styles.rsvpBtnInActive
                  : status === 'out'
                    ? styles.rsvpBtnOutActive
                    : styles.rsvpBtnMaybeActive;
              const label = status === 'in' ? "I'm In" : status === 'out' ? "I'm Out" : 'Maybe';
              const icon = status === 'in' ? 'check-circle' : status === 'out' ? 'times-circle' : 'question-circle';

              return (
                <TouchableOpacity
                  key={status}
                  style={[styles.rsvpBtn, btnStyle, isActive && activeStyle]}
                  onPress={() => handleRsvp(status)}
                >
                  <FontAwesome5
                    name={icon}
                    size={16}
                    color={isActive ? Colors.white : (status === 'in' ? Colors.success : status === 'out' ? Colors.danger : Colors.saintsGoldDark)}
                  />
                  <Text
                    style={[
                      styles.rsvpBtnLabel,
                      { color: isActive ? Colors.white : Colors.textPrimary },
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* Team Availability Summary — coaches / admins */}
      {can('availability.viewTeam') && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Team Availability</Text>

          {/* Summary bar */}
          <View style={styles.summaryBar}>
            <View style={styles.summaryChip}>
              <FontAwesome5 name="check-circle" size={14} color={Colors.success} />
              <Text style={[styles.summaryCount, { color: Colors.success }]}>{summary.inCount}</Text>
              <Text style={styles.summaryLabel}>In</Text>
            </View>
            <View style={styles.summaryChip}>
              <FontAwesome5 name="question-circle" size={14} color={Colors.saintsGoldDark} />
              <Text style={[styles.summaryCount, { color: Colors.saintsGoldDark }]}>{summary.maybeCount}</Text>
              <Text style={styles.summaryLabel}>Maybe</Text>
            </View>
            <View style={styles.summaryChip}>
              <FontAwesome5 name="times-circle" size={14} color={Colors.danger} />
              <Text style={[styles.summaryCount, { color: Colors.danger }]}>{summary.outCount}</Text>
              <Text style={styles.summaryLabel}>Out</Text>
            </View>
          </View>

          {/* Individual list */}
          {rsvps.length === 0 ? (
            <Text style={styles.noRsvpText}>No responses yet</Text>
          ) : (
            rsvps.map((r) => {
              const statusIcon =
                r.status === 'in' ? 'check-circle' : r.status === 'out' ? 'times-circle' : 'question-circle';
              const statusColor =
                r.status === 'in' ? Colors.success : r.status === 'out' ? Colors.danger : Colors.saintsGoldDark;
              return (
                <View key={r.id} style={styles.rsvpListItem}>
                  <FontAwesome5 name={statusIcon} size={14} color={statusColor} />
                  <Text style={styles.rsvpListName}>{r.playerName || 'Unknown'}</Text>
                  <Text style={[styles.rsvpListStatus, { color: statusColor }]}>
                    {r.status === 'in' ? 'In' : r.status === 'out' ? 'Out' : 'Maybe'}
                  </Text>
                </View>
              );
            })
          )}
        </View>
      )}

      {/* Action buttons */}
      {(can('event.edit') || can('event.delete')) && (
        <View style={styles.actionRow}>
          {can('event.edit') && (
            <TouchableOpacity
              style={styles.editBtn}
              onPress={() =>
                router.push({
                  pathname: '/event/form' as any,
                  params: { teamId, eventId: id },
                })
              }
            >
              <FontAwesome5 name="edit" size={14} color={Colors.white} />
              <Text style={styles.editBtnText}>Edit Event</Text>
            </TouchableOpacity>
          )}
          {can('event.delete') && (
            <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
              <FontAwesome5 name="trash-alt" size={14} color={Colors.danger} />
              <Text style={styles.deleteBtnText}>Delete</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.light },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary, marginTop: 16 },
  backBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: Colors.saintsBlue, borderRadius: 8 },
  backBtnText: { color: Colors.white, fontWeight: '700' },

  // Header card
  headerCard: {
    flexDirection: 'row',
    backgroundColor: Colors.white,
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 16,
    shadowColor: '#06255c',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
  typeStrip: { width: 6 },
  headerBody: { flex: 1, padding: 18 },
  typeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  typeLabel: { fontSize: 12, fontWeight: '700', color: Colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  homeAwayBadge: { backgroundColor: Colors.light, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  homeAwayText: { fontSize: 10, fontWeight: '800', color: Colors.textMuted },
  title: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary, marginBottom: 2 },
  opponent: { fontSize: 15, fontWeight: '600', color: Colors.textSecondary },

  // Section
  section: {
    backgroundColor: Colors.white,
    borderRadius: 14,
    padding: 18,
    marginBottom: 16,
    shadowColor: '#06255c',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
  sectionTitle: { fontSize: 14, fontWeight: '800', color: Colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 14 },

  detailRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  detailIcon: { width: 22 },
  detailText: { fontSize: 15, color: Colors.textPrimary, flex: 1 },
  linkText: { color: Colors.saintsBlue, textDecorationLine: 'underline' },

  // RSVP buttons
  rsvpButtonRow: { flexDirection: 'row', gap: 10 },
  rsvpBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  rsvpBtnIn: { borderColor: Colors.success, backgroundColor: '#f0faf0' },
  rsvpBtnOut: { borderColor: Colors.danger, backgroundColor: '#fef5f4' },
  rsvpBtnMaybe: { borderColor: Colors.saintsGoldDark, backgroundColor: '#fffcf0' },
  rsvpBtnInActive: { backgroundColor: Colors.success, borderColor: Colors.success },
  rsvpBtnOutActive: { backgroundColor: Colors.danger, borderColor: Colors.danger },
  rsvpBtnMaybeActive: { backgroundColor: Colors.saintsGoldDark, borderColor: Colors.saintsGoldDark },
  rsvpBtnLabel: { fontSize: 14, fontWeight: '700' },

  // Summary
  summaryBar: { flexDirection: 'row', gap: 16, marginBottom: 16 },
  summaryChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  summaryCount: { fontSize: 18, fontWeight: '800' },
  summaryLabel: { fontSize: 13, color: Colors.textMuted },

  noRsvpText: { fontSize: 14, color: Colors.textMuted, textAlign: 'center', paddingVertical: 12 },

  // RSVP list
  rsvpListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.gray,
  },
  rsvpListName: { flex: 1, fontSize: 14, fontWeight: '600', color: Colors.textPrimary },
  rsvpListStatus: { fontSize: 13, fontWeight: '700' },

  // Actions
  actionRow: { flexDirection: 'row', gap: 12, marginTop: 4 },
  editBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.saintsBlue,
    paddingVertical: 14,
    borderRadius: 10,
  },
  editBtnText: { color: Colors.white, fontSize: 15, fontWeight: '700' },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.danger,
  },
  deleteBtnText: { color: Colors.danger, fontSize: 15, fontWeight: '700' },
});
