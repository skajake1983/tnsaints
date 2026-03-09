import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Platform,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors } from '../../constants/Colors';
import { useRosterStore, Player, computeAge } from '../../stores/rosterStore';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';

export default function TeamScreen() {
  const { players, loading, listen } = useRosterStore();
  const profile = useAuthStore((s) => s.profile);
  const { teams, activeTeamId, setActiveTeam, listen: listenTeams, loading: teamsLoading } = useTeamStore();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [showTeamPicker, setShowTeamPicker] = useState(false);

  const canEdit = profile?.role === 'admin' || profile?.role === 'coach';

  // Listen to user's teams
  useEffect(() => {
    if (!profile?.teamIds?.length) return;
    const unsub = listenTeams(profile.teamIds);
    return unsub;
  }, [profile?.teamIds]);

  // Listen to the active team's roster
  useEffect(() => {
    if (!activeTeamId) return;
    const unsub = listen(activeTeamId);
    return unsub;
  }, [activeTeamId]);

  const activeTeam = teams.find((t) => t.id === activeTeamId);

  const filtered = players.filter((p) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const name = `${p.firstName} ${p.lastName}`.toLowerCase();
    return (
      name.includes(q) ||
      String(p.jerseyNumber ?? '').includes(q) ||
      (p.position ?? '').toLowerCase().includes(q) ||
      (p.role ?? '').toLowerCase().includes(q)
    );
  });

  const renderPlayer = ({ item }: { item: Player }) => {
    const initials = `${item.firstName[0] ?? ''}${item.lastName[0] ?? ''}`.toUpperCase();
    const age = item.birthdate ? computeAge(item.birthdate) : null;
    const roleLabel = item.role
      ? item.role.charAt(0).toUpperCase() + item.role.slice(1)
      : 'Player';

    return (
      <TouchableOpacity
        style={styles.playerCard}
        activeOpacity={0.7}
        onPress={() =>
          router.push({
            pathname: '/player/[id]' as any,
            params: { id: item.id, teamId: activeTeamId ?? '' },
          })
        }
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>

        <View style={styles.playerInfo}>
          <Text style={styles.playerName}>
            {item.firstName} {item.lastName}
          </Text>
          <Text style={styles.playerMeta}>
            {roleLabel}
            {item.position ? ` · ${item.position}` : ''}
            {age != null ? ` · Age ${age}` : ''}
            {item.height ? ` · ${item.height}` : ''}
          </Text>
        </View>

        {item.jerseyNumber != null && (
          <View style={styles.jerseyBadge}>
            <Text style={styles.jerseyText}>#{item.jerseyNumber}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Team selector */}
      {teams.length > 1 && (
        <TouchableOpacity
          style={styles.teamSelector}
          onPress={() => setShowTeamPicker(!showTeamPicker)}
        >
          <FontAwesome5 name="users" size={14} color={Colors.saintsBlue} />
          <Text style={styles.teamSelectorText}>{activeTeam?.name ?? 'Select Team'}</Text>
          <FontAwesome5 name={showTeamPicker ? 'chevron-up' : 'chevron-down'} size={12} color={Colors.textMuted} />
        </TouchableOpacity>
      )}
      {showTeamPicker && (
        <View style={styles.teamDropdown}>
          {teams.map((t) => (
            <TouchableOpacity
              key={t.id}
              style={[styles.teamOption, t.id === activeTeamId && styles.teamOptionActive]}
              onPress={() => { setActiveTeam(t.id); setShowTeamPicker(false); }}
            >
              <Text style={[styles.teamOptionText, t.id === activeTeamId && styles.teamOptionTextActive]}>
                {t.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* No team state */}
      {!activeTeamId && !teamsLoading ? (
        <View style={styles.center}>
          <FontAwesome5 name="users" size={40} color={Colors.gray} />
          <Text style={styles.emptyTitle}>No teams yet</Text>
          <Text style={styles.emptySub}>
            {canEdit
              ? 'You haven\'t been assigned to any teams yet. Ask an admin to add you.'
              : 'You\'ll see your team here once you\'re added.'}
          </Text>
        </View>
      ) : (
        <>
      {/* Search bar */}
      <View style={styles.searchRow}>
        <FontAwesome5 name="search" size={14} color={Colors.textMuted} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name, number, position…"
          placeholderTextColor={Colors.textMuted}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <FontAwesome5 name="times-circle" size={16} color={Colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {/* Player count + Add button */}
      <View style={styles.countRow}>
        <Text style={styles.countText}>
          {filtered.length} member{filtered.length !== 1 ? 's' : ''}
        </Text>
        {canEdit && (
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() =>
              router.push({
                pathname: '/player/form' as any,
                params: { teamId: activeTeamId ?? '' },
              })
            }
          >
            <FontAwesome5 name="plus" size={12} color={Colors.white} />
            <Text style={styles.addBtnText}>Add Member</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* List */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.saintsBlue} />
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.center}>
          <FontAwesome5 name="users" size={40} color={Colors.gray} />
          <Text style={styles.emptyTitle}>
            {players.length === 0 ? 'No players yet' : 'No matches'}
          </Text>
          <Text style={styles.emptySub}>
            {players.length === 0
              ? canEdit
              ? 'Tap "Add Member" to build your roster.'
              : 'Members will appear here once added by a coach.'
              : 'Try a different search term.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => p.id}
          renderItem={renderPlayer}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
        />
      )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.light },

  teamSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: Colors.white,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.gray,
  },
  teamSelectorText: { flex: 1, fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  teamDropdown: {
    marginHorizontal: 16,
    backgroundColor: Colors.white,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.gray,
    marginTop: 4,
    overflow: 'hidden',
  },
  teamOption: { paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.gray },
  teamOptionActive: { backgroundColor: Colors.saintsBlue },
  teamOptionText: { fontSize: 15, color: Colors.textPrimary },
  teamOptionTextActive: { color: Colors.white, fontWeight: '700' },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 44,
    borderWidth: 1,
    borderColor: Colors.gray,
  },
  searchIcon: { marginRight: 8 },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: Colors.textPrimary,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },

  countRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 18,
    marginTop: 14,
    marginBottom: 8,
  },
  countText: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.saintsBlue,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  addBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },

  list: { paddingHorizontal: 16, paddingBottom: 30 },

  playerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#06255c',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.saintsBlueDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.saintsGold, fontWeight: '800', fontSize: 16 },

  playerInfo: { flex: 1, marginLeft: 14 },
  playerName: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  playerMeta: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },

  jerseyBadge: {
    backgroundColor: Colors.saintsGold,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    minWidth: 40,
    alignItems: 'center',
  },
  jerseyText: { fontWeight: '800', fontSize: 14, color: Colors.saintsBlueDark },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary, marginTop: 16 },
  emptySub: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', marginTop: 6, maxWidth: 260 },
});
