import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors } from '../../constants/Colors';
import { useEventStore, TeamEvent, getEventMeta, formatEventDate, formatEventTime, filterUpcoming, filterPast, groupEventsByDate } from '../../stores/eventStore';
import { useAvailabilityStore, summariseRsvps } from '../../stores/availabilityStore';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { usePermissions } from '../../hooks/usePermissions';
import SwipeableRow from '../../components/SwipeableRow';

type TabFilter = 'upcoming' | 'past';

export default function ScheduleScreen() {
  const { events, loading, listen, removeEvent } = useEventStore();
  const { byEvent, listenTeam } = useAvailabilityStore();
  const { activeTeamId } = useTeamStore();
  const profile = useAuthStore((s) => s.profile);
  const { can } = usePermissions();
  const router = useRouter();
  const [tab, setTab] = useState<TabFilter>('upcoming');

  // Bulk selection state
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const canEdit = can('event.edit');
  const canDelete = can('event.delete');

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

  // Reset selection when tab changes or leaving select mode
  useEffect(() => {
    setSelected(new Set());
    setSelectMode(false);
  }, [tab]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(filtered.map((e) => e.id)));
  }, [filtered]);

  const handleDeleteSingle = useCallback((eventId: string) => {
    if (!activeTeamId) return;
    const doDelete = async () => {
      try {
        await removeEvent(activeTeamId, eventId);
      } catch {}
    };
    if (Platform.OS === 'web') {
      if (window.confirm('Delete this event?')) doDelete();
    } else {
      Alert.alert('Delete Event', 'Are you sure you want to delete this event?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: doDelete },
      ]);
    }
  }, [activeTeamId, removeEvent]);

  const handleBulkDelete = useCallback(() => {
    if (!activeTeamId || selected.size === 0) return;
    const doDelete = async () => {
      setDeleting(true);
      try {
        for (const id of selected) {
          await removeEvent(activeTeamId, id);
        }
      } catch {} finally {
        setDeleting(false);
        setSelected(new Set());
        setSelectMode(false);
      }
    };
    const count = selected.size;
    if (Platform.OS === 'web') {
      if (window.confirm(`Delete ${count} event${count !== 1 ? 's' : ''}?`)) doDelete();
    } else {
      Alert.alert(
        'Delete Events',
        `Are you sure you want to delete ${count} event${count !== 1 ? 's' : ''}?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: doDelete },
        ],
      );
    }
  }, [activeTeamId, selected, removeEvent]);

  const handleEditEvent = useCallback((eventId: string) => {
    if (!activeTeamId) return;
    router.push({
      pathname: '/event/form' as any,
      params: { teamId: activeTeamId, eventId },
    });
  }, [activeTeamId, router]);

  const renderEvent = ({ item }: { item: TeamEvent }) => {
    const meta = getEventMeta(item.type);
    const rsvps = byEvent[item.id];
    const summary = rsvps ? summariseRsvps(rsvps) : null;
    const myRsvp = rsvps?.find((r) => r.uid === profile?.uid);
    const isSelected = selected.has(item.id);

    const card = (
      <TouchableOpacity
        style={styles.eventCard}
        activeOpacity={0.7}
        onPress={() => {
          if (selectMode) {
            toggleSelect(item.id);
            return;
          }
          router.push({
            pathname: '/event/[id]' as any,
            params: { id: item.id, teamId: activeTeamId ?? '' },
          });
        }}
      >
        {selectMode && (
          <View style={styles.checkboxCol}>
            <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
              {isSelected && <FontAwesome5 name="check" size={10} color={Colors.white} />}
            </View>
          </View>
        )}
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
            {canEdit && !selectMode && (
              <TouchableOpacity
                style={styles.editIconBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => handleEditEvent(item.id)}
              >
                <FontAwesome5 name="pencil-alt" size={12} color={Colors.textMuted} />
              </TouchableOpacity>
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

    if (selectMode) return card;

    return (
      <SwipeableRow
        onEdit={canEdit ? () => handleEditEvent(item.id) : undefined}
        onDelete={canDelete ? () => handleDeleteSingle(item.id) : undefined}
      >
        {card}
      </SwipeableRow>
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

        {can('event.create') && !selectMode && (
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

      {/* Bulk selection toolbar */}
      {canDelete && sections.length > 0 && (
        <View style={styles.bulkBar}>
          {selectMode ? (
            <>
              <TouchableOpacity onPress={selectAll} style={styles.bulkLink}>
                <Text style={styles.bulkLinkText}>Select All</Text>
              </TouchableOpacity>
              <Text style={styles.bulkCount}>{selected.size} selected</Text>
              <TouchableOpacity
                onPress={handleBulkDelete}
                disabled={selected.size === 0 || deleting}
                style={[styles.bulkDeleteBtn, (selected.size === 0 || deleting) && { opacity: 0.4 }]}
              >
                {deleting ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <>
                    <FontAwesome5 name="trash-alt" size={11} color={Colors.white} />
                    <Text style={styles.bulkDeleteText}>Delete</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { setSelectMode(false); setSelected(new Set()); }}
                style={styles.bulkLink}
              >
                <Text style={[styles.bulkLinkText, { color: Colors.textMuted }]}>Cancel</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              onPress={() => setSelectMode(true)}
              style={styles.bulkLink}
            >
              <FontAwesome5 name="check-square" size={12} color={Colors.saintsBlue} />
              <Text style={styles.bulkLinkText}>Select</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

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

  editIconBtn: {
    marginLeft: 'auto',
    padding: 4,
  },

  checkboxCol: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 12,
    paddingRight: 4,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: Colors.gray,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: Colors.saintsBlue,
    borderColor: Colors.saintsBlue,
  },

  bulkBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 10,
  },
  bulkLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
  },
  bulkLinkText: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.saintsBlue,
  },
  bulkCount: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
    flex: 1,
  },
  bulkDeleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.danger,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  bulkDeleteText: {
    color: Colors.white,
    fontSize: 12,
    fontWeight: '700',
  },
});
