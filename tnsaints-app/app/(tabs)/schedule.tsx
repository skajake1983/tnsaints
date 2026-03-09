import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors } from '../../constants/Colors';
import { useEventStore, TeamEvent, getEventMeta, formatEventDate, formatEventTime, filterUpcoming, filterPast, groupEventsByDate } from '../../stores/eventStore';
import { useAvailabilityStore, summariseRsvps } from '../../stores/availabilityStore';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { usePermissions } from '../../hooks/usePermissions';

type TabFilter = 'upcoming' | 'past';

export default function ScheduleScreen() {
  const { events, loading, listen } = useEventStore();
  const { byEvent, listenTeam } = useAvailabilityStore();
  const { activeTeamId } = useTeamStore();
  const profile = useAuthStore((s) => s.profile);
  const { can } = usePermissions();
  const router = useRouter();
  const [tab, setTab] = useState<TabFilter>('upcoming');

  useEffect(() => {
    if (!activeTeamId) return;
    const unsub = listen(activeTeamId);
    return unsub;
  }, [activeTeamId]);

  useEffect(() => {
    if (!activeTeamId) return;
    const unsub = listenTeam(activeTeamId);
    return unsub;
  }, [activeTeamId]);

  const filtered = tab === 'upcoming' ? filterUpcoming(events) : filterPast(events);
  const grouped = groupEventsByDate(filtered);
  const sections = Array.from(grouped.entries()).map(([date, items]) => ({
    title: formatEventDate(items[0].startDate),
    dateKey: date,
    data: items,
  }));

  const renderEvent = ({ item }: { item: TeamEvent }) => {
    const meta = getEventMeta(item.type);
    const rsvps = byEvent[item.id];
    const summary = rsvps ? summariseRsvps(rsvps) : null;
    const myRsvp = rsvps?.find((r) => r.uid === profile?.uid);

    return (
      <TouchableOpacity
        style={styles.eventCard}
        activeOpacity={0.7}
        onPress={() =>
          router.push({
            pathname: '/event/[id]' as any,
            params: { id: item.id, teamId: activeTeamId ?? '' },
          })
        }
      >
        <View style={[styles.eventTypeStrip, { backgroundColor: meta.color }]} />
        <View style={styles.eventBody}>
          <View style={styles.eventHeader}>
            <FontAwesome5 name={meta.icon} size={14} color={meta.color} />
            <Text style={styles.eventTypeLabel}>{meta.label}</Text>
            {item.homeAway && (
              <View style={styles.homeAwayBadge}>
                <Text style={styles.homeAwayText}>{item.homeAway.toUpperCase()}</Text>
              </View>
            )}
          </View>

          <Text style={styles.eventTitle}>{item.title}</Text>

          <View style={styles.eventMeta}>
            <FontAwesome5 name="clock" size={11} color={Colors.textMuted} />
            <Text style={styles.eventMetaText}>
              {item.isAllDay ? 'All Day' : `${formatEventTime(item.startDate)} – ${formatEventTime(item.endDate)}`}
            </Text>
          </View>

          {item.location && (
            <View style={styles.eventMeta}>
              <FontAwesome5 name="map-marker-alt" size={11} color={Colors.textMuted} />
              <Text style={styles.eventMetaText} numberOfLines={1}>{item.location}</Text>
            </View>
          )}

          {item.opponent && (
            <View style={styles.eventMeta}>
              <FontAwesome5 name="basketball-ball" size={11} color={Colors.textMuted} />
              <Text style={styles.eventMetaText}>vs {item.opponent}</Text>
            </View>
          )}

          {/* RSVP summary row */}
          <View style={styles.rsvpRow}>
            {summary ? (
              <>
                <View style={styles.rsvpChip}>
                  <FontAwesome5 name="check-circle" size={11} color={Colors.success} />
                  <Text style={[styles.rsvpChipText, { color: Colors.success }]}>{summary.inCount}</Text>
                </View>
                <View style={styles.rsvpChip}>
                  <FontAwesome5 name="question-circle" size={11} color={Colors.saintsGoldDark} />
                  <Text style={[styles.rsvpChipText, { color: Colors.saintsGoldDark }]}>{summary.maybeCount}</Text>
                </View>
                <View style={styles.rsvpChip}>
                  <FontAwesome5 name="times-circle" size={11} color={Colors.danger} />
                  <Text style={[styles.rsvpChipText, { color: Colors.danger }]}>{summary.outCount}</Text>
                </View>
              </>
            ) : (
              <Text style={styles.noRsvpText}>No responses yet</Text>
            )}

            {myRsvp && (
              <View style={[styles.myRsvpBadge, myRsvp.status === 'in' && styles.myRsvpIn, myRsvp.status === 'out' && styles.myRsvpOut, myRsvp.status === 'maybe' && styles.myRsvpMaybe]}>
                <Text style={styles.myRsvpText}>
                  {myRsvp.status === 'in' ? "I'm In" : myRsvp.status === 'out' ? "I'm Out" : 'Maybe'}
                </Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  if (!activeTeamId) {
    return (
      <View style={styles.center}>
        <FontAwesome5 name="calendar-alt" size={40} color={Colors.gray} />
        <Text style={styles.emptyTitle}>No team selected</Text>
        <Text style={styles.emptySub}>Select a team from the Team tab to see events.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Tab bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'upcoming' && styles.tabBtnActive]}
          onPress={() => setTab('upcoming')}
        >
          <Text style={[styles.tabBtnText, tab === 'upcoming' && styles.tabBtnTextActive]}>Upcoming</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'past' && styles.tabBtnActive]}
          onPress={() => setTab('past')}
        >
          <Text style={[styles.tabBtnText, tab === 'past' && styles.tabBtnTextActive]}>Past</Text>
        </TouchableOpacity>

        {can('event.create') && (
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() =>
              router.push({
                pathname: '/event/form' as any,
                params: { teamId: activeTeamId },
              })
            }
          >
            <FontAwesome5 name="plus" size={12} color={Colors.white} />
            <Text style={styles.addBtnText}>Add Event</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.saintsBlue} />
        </View>
      ) : sections.length === 0 ? (
        <View style={styles.center}>
          <FontAwesome5 name="calendar-alt" size={40} color={Colors.gray} />
          <Text style={styles.emptyTitle}>
            {tab === 'upcoming' ? 'No upcoming events' : 'No past events'}
          </Text>
          <Text style={styles.emptySub}>
            {can('event.create')
              ? 'Tap "Add Event" to schedule a practice or game.'
              : 'Events will appear here once scheduled.'}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderEvent}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          stickySectionHeadersEnabled={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.light },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary, marginTop: 16 },
  emptySub: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', marginTop: 6, maxWidth: 260 },

  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 8,
  },
  tabBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.gray,
  },
  tabBtnActive: {
    backgroundColor: Colors.saintsBlue,
    borderColor: Colors.saintsBlue,
  },
  tabBtnText: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },
  tabBtnTextActive: { color: Colors.white },

  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.saintsBlue,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
    marginLeft: 'auto',
  },
  addBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },

  list: { paddingHorizontal: 16, paddingBottom: 30 },

  sectionHeader: {
    fontSize: 14,
    fontWeight: '800',
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 18,
    marginBottom: 8,
  },

  eventCard: {
    flexDirection: 'row',
    backgroundColor: Colors.white,
    borderRadius: 14,
    marginBottom: 10,
    shadowColor: '#06255c',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
    overflow: 'hidden',
  },
  eventTypeStrip: { width: 5 },
  eventBody: { flex: 1, padding: 14 },

  eventHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  eventTypeLabel: { fontSize: 11, fontWeight: '700', color: Colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  homeAwayBadge: {
    backgroundColor: Colors.light,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  homeAwayText: { fontSize: 10, fontWeight: '800', color: Colors.textMuted },

  eventTitle: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary, marginBottom: 6 },

  eventMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  eventMetaText: { fontSize: 13, color: Colors.textSecondary },

  rsvpRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  rsvpChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  rsvpChipText: { fontSize: 12, fontWeight: '700' },
  noRsvpText: { fontSize: 12, color: Colors.textMuted },

  myRsvpBadge: {
    marginLeft: 'auto',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  myRsvpIn: { backgroundColor: '#e8f5e9' },
  myRsvpOut: { backgroundColor: '#fdecea' },
  myRsvpMaybe: { backgroundColor: '#fff8e1' },
  myRsvpText: { fontSize: 11, fontWeight: '700', color: Colors.textPrimary },
});
