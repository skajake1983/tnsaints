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
import { usePermissions } from '../../hooks/usePermissions';

type RoleFilter = 'all' | 'player' | 'coach' | 'parent';
const ROLE_FILTERS: { value: RoleFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'player', label: 'Players' },
  { value: 'coach', label: 'Coaches' },
  { value: 'parent', label: 'Parents' },
];

export default function TeamScreen() {
  const { players, loading, listen } = useRosterStore();
  const profile = useAuthStore((s) => s.profile);
  const { activeTeamId, loading: teamsLoading } = useTeamStore();
  const { can } = usePermissions();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');

  const canAdd = can('roster.add');
  const canEditTeam = can('team.edit');

  // Listen to the active team's roster
  useEffect(() => {
    if (!activeTeamId) return;
    const unsub = listen(activeTeamId);
    return unsub;
  }, [activeTeamId]);

  const filtered = players.filter((p) => {
    // Exclude superadmins from the list
    if ((p.role as string) === 'superadmin') return false;
    // Apply role filter
    if (roleFilter !== 'all' && p.role !== roleFilter) return false;
    // Apply text search
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
      {/* No team state */}
      {!activeTeamId && !teamsLoading ? (
        <View style={styles.center}>
          <FontAwesome5 name="users" size={40} color={Colors.gray} />
          <Text style={styles.emptyTitle}>No teams yet</Text>
          <Text style={styles.emptySub}>
            {canAdd
              ? "You haven't been assigned to any teams yet. Ask an admin to add you."
              : "You'll see your team here once you're added."}
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

      {/* Role filter chips */}
      <View style={styles.filterRow}>
        {ROLE_FILTERS.map((f) => (
          <TouchableOpacity
            key={f.value}
            style={[styles.filterChip, roleFilter === f.value && styles.filterChipActive]}
            onPress={() => setRoleFilter(f.value)}
          >
            <Text style={[styles.filterChipText, roleFilter === f.value && styles.filterChipTextActive]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Player count + action buttons */}
      <View style={styles.countRow}>
        <Text style={styles.countText}>
          {filtered.length} member{filtered.length !== 1 ? 's' : ''}
        </Text>
        <View style={styles.actionBtns}>
          {canEditTeam && (
            <TouchableOpacity
              style={styles.editTeamBtn}
              onPress={() =>
                router.push({
                  pathname: '/team/edit' as any,
                  params: { teamId: activeTeamId ?? '' },
                })
              }
            >
              <FontAwesome5 name="cog" size={12} color={Colors.saintsBlue} />
              <Text style={styles.editTeamBtnText}>Edit Team</Text>
            </TouchableOpacity>
          )}
          {canAdd && (
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
              ? canAdd
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
    marginTop: 8,
    marginBottom: 8,
  },

  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginTop: 10,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.gray,
  },
  filterChipActive: {
    backgroundColor: Colors.saintsBlue,
    borderColor: Colors.saintsBlue,
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  filterChipTextActive: {
    color: Colors.white,
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

  editTeamBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: Colors.saintsBlue,
  },
  editTeamBtnText: { color: Colors.saintsBlue, fontWeight: '700', fontSize: 13 },

  actionBtns: {
    flexDirection: 'row',
    gap: 8,
  },

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
