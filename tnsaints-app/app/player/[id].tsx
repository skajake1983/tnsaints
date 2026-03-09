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
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Colors } from '../../constants/Colors';
import { useRosterStore, Player, computeAge, SiblingLink, fetchTeamPlayers } from '../../stores/rosterStore';
import { useTeamStore } from '../../stores/teamStore';
import { usePermissions } from '../../hooks/usePermissions';

export default function PlayerDetailScreen() {
  const { id, teamId } = useLocalSearchParams<{ id: string; teamId: string }>();
  const router = useRouter();
  const { can } = usePermissions();
  const removePlayer = useRosterStore((s) => s.removePlayer);
  const allMembers = useRosterStore((s) => s.players);
  const allTeams = useTeamStore((s) => s.teams);
  const [player, setPlayer] = useState<Player | null>(null);
  const [loading, setLoading] = useState(true);
  // Cross-team sibling info (fetched lazily)
  const [crossTeamSiblings, setCrossTeamSiblings] = useState<
    Map<string, { player: Player; teamName: string }>
  >(new Map());

  const canEditRoster = can('roster.edit');
  const canRemove = can('roster.remove');

  useEffect(() => {
    if (!id || !teamId) return;
    const ref = doc(db, 'teams', teamId, 'players', id);
    const unsub = onSnapshot(ref, (snap) => {
      if (snap.exists()) {
        setPlayer({ id: snap.id, ...snap.data() } as Player);
      }
      setLoading(false);
    });
    return unsub;
  }, [id, teamId]);

  // Fetch cross-team sibling data lazily
  useEffect(() => {
    if (!player?.linkedSiblingIds?.length) return;
    const crossTeam = player.linkedSiblingIds.filter((s) => s.teamId !== teamId);
    if (crossTeam.length === 0) return;

    // Group by teamId to do one fetch per team
    const byTeam = new Map<string, string[]>();
    for (const s of crossTeam) {
      const arr = byTeam.get(s.teamId) ?? [];
      arr.push(s.playerId);
      byTeam.set(s.teamId, arr);
    }

    (async () => {
      const result = new Map<string, { player: Player; teamName: string }>();
      for (const [tid, pids] of byTeam) {
        const teamName = allTeams.find((t) => t.id === tid)?.name ?? tid;
        try {
          const players = await fetchTeamPlayers(tid);
          for (const p of players) {
            if (pids.includes(p.id)) {
              result.set(`${tid}/${p.id}`, { player: p, teamName });
            }
          }
        } catch { /* skip unavailable teams */ }
      }
      setCrossTeamSiblings(result);
    })();
  }, [player?.linkedSiblingIds, teamId, allTeams]);

  const confirmDelete = () => {
    const doDelete = async () => {
      if (!teamId || !id) return;
      await removePlayer(teamId, id);
      router.back();
    };

    if (Platform.OS === 'web') {
      if (window.confirm(`Remove ${player?.firstName} ${player?.lastName} from the roster?`)) {
        doDelete();
      }
    } else {
      Alert.alert(
        'Remove Player',
        `Remove ${player?.firstName} ${player?.lastName} from the roster?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: doDelete },
        ],
      );
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.saintsBlue} />
      </View>
    );
  }

  if (!player) {
    return (
      <View style={styles.center}>
        <FontAwesome5 name="user-slash" size={40} color={Colors.gray} />
        <Text style={styles.emptyTitle}>Player not found</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const initials = `${player.firstName[0] ?? ''}${player.lastName[0] ?? ''}`.toUpperCase();
  const roleLabel = player.role
    ? player.role.charAt(0).toUpperCase() + player.role.slice(1)
    : 'Player';
  const age = player.birthdate ? computeAge(player.birthdate) : null;

  // Compute linked guardians from BOTH directions so the display is resilient
  // to one-sided sync gaps. Union of:
  //   1. player.linkedParentIds (reverse links stored on this player)
  //   2. any parent/coach in the roster whose linkedPlayerIds includes this player
  const resolvedGuardianIds: string[] = (() => {
    if (player.role !== 'player') return [];
    const fromPlayer = new Set(player.linkedParentIds ?? []);
    for (const m of allMembers) {
      if ((m.role === 'parent' || m.role === 'coach') && m.linkedPlayerIds?.includes(player.id)) {
        fromPlayer.add(m.id);
      }
    }
    return Array.from(fromPlayer);
  })();

  // Compute linked players from BOTH directions (for parents/coaches)
  const resolvedPlayerIds: string[] = (() => {
    if (player.role !== 'parent' && player.role !== 'coach') return [];
    const fromMember = new Set(player.linkedPlayerIds ?? []);
    for (const m of allMembers) {
      if (m.role === 'player' && m.linkedParentIds?.includes(player.id)) {
        fromMember.add(m.id);
      }
    }
    return Array.from(fromMember);
  })();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header card */}
      <View style={styles.headerCard}>
        <View style={styles.avatarLg}>
          <Text style={styles.avatarLgText}>{initials}</Text>
        </View>
        <Text style={styles.playerName}>
          {player.firstName} {player.lastName}
        </Text>
        <View style={styles.badgeRow}>
          <View style={styles.roleBadge}>
            <Text style={styles.roleText}>{roleLabel}</Text>
          </View>
          {player.jerseyNumber != null && (
            <View style={styles.jerseyBadge}>
              <Text style={styles.jerseyText}>#{player.jerseyNumber}</Text>
            </View>
          )}
          {player.position && (
            <View style={styles.positionBadge}>
              <Text style={styles.positionText}>{player.position}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Personal Info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Personal Info</Text>
        {age != null ? <DetailRow icon="birthday-cake" label="Age" value={`${age} (born ${player.birthdate})`} /> : null}
        {player.gender ? <DetailRow icon="venus-mars" label="Gender" value={player.gender === 'male' ? 'Male' : 'Female'} /> : null}
        {player.height ? <DetailRow icon="ruler-vertical" label="Height" value={player.height} /> : null}
        {player.weight ? <DetailRow icon="weight" label="Weight" value={`${player.weight} lbs`} /> : null}
        <DetailRow
          icon={player.active ? 'check-circle' : 'times-circle'}
          label="Status"
          value={player.active ? 'Active' : 'Inactive'}
          valueColor={player.active ? Colors.success : Colors.danger}
        />
      </View>

      {/* Contact Info */}
      {(player.email || player.phone || player.address) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Contact</Text>
          {player.email ? <DetailRow icon="envelope" label="Email" value={player.email} /> : null}
          {player.phone ? <DetailRow icon="phone" label="Phone" value={player.phone} /> : null}
          {player.address ? <DetailRow icon="map-marker-alt" label="Address" value={player.address} /> : null}
        </View>
      )}

      {/* Parent / Guardian */}
      {(player.parentName || player.parentEmail || player.parentPhone) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Parent / Guardian</Text>
          {player.parentName ? <DetailRow icon="user" label="Name" value={player.parentName} /> : null}
          {player.parentEmail ? <DetailRow icon="envelope" label="Email" value={player.parentEmail} /> : null}
          {player.parentPhone ? <DetailRow icon="phone" label="Phone" value={player.parentPhone} /> : null}
        </View>
      )}

      {/* Linked Parents / Guardians from roster */}
      {resolvedGuardianIds.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Linked Guardians</Text>
          {resolvedGuardianIds.map((pid) => {
            const member = allMembers.find((m) => m.id === pid);
            const memberInitials = member
              ? (member.firstName[0] ?? '') + (member.lastName[0] ?? '')
              : '??';
            const memberName = member
              ? `${member.firstName} ${member.lastName}`
              : 'Unknown member';
            const label = member?.role === 'coach' ? 'Coach' : 'Parent';
            return (
              <TouchableOpacity
                key={pid}
                style={styles.linkedMemberRow}
                onPress={() =>
                  router.replace({
                    pathname: '/player/[id]' as any,
                    params: { id: pid, teamId },
                  })
                }
              >
                <View style={styles.linkedAvatar}>
                  <Text style={styles.linkedAvatarText}>
                    {memberInitials}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.linkedName}>{memberName}</Text>
                  <Text style={styles.linkedRole}>{label}</Text>
                </View>
                <FontAwesome5 name="chevron-right" size={12} color={Colors.textMuted} />
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Linked Players (for parents/coaches) */}
      {resolvedPlayerIds.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Linked Players</Text>
          {resolvedPlayerIds.map((pid) => {
            const member = allMembers.find((m) => m.id === pid);
            const memberInitials = member
              ? (member.firstName[0] ?? '') + (member.lastName[0] ?? '')
              : '??';
            const memberName = member
              ? `${member.firstName} ${member.lastName}`
              : 'Unknown player';
            return (
              <TouchableOpacity
                key={pid}
                style={styles.linkedMemberRow}
                onPress={() =>
                  router.replace({
                    pathname: '/player/[id]' as any,
                    params: { id: pid, teamId },
                  })
                }
              >
                <View style={styles.linkedAvatar}>
                  <Text style={styles.linkedAvatarText}>
                    {memberInitials}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.linkedName}>{memberName}</Text>
                  <Text style={styles.linkedRole}>
                    {member?.jerseyNumber != null ? `#${member.jerseyNumber} · ` : ''}{member?.position ?? 'Player'}
                  </Text>
                </View>
                <FontAwesome5 name="chevron-right" size={12} color={Colors.textMuted} />
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Siblings */}
      {player.role === 'player' && (player.linkedSiblingIds?.length ?? 0) > 0 && (() => {
        const sameTeam = (player.linkedSiblingIds ?? []).filter((s) => s.teamId === teamId);
        const crossTeam = (player.linkedSiblingIds ?? []).filter((s) => s.teamId !== teamId);
        return (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Siblings</Text>
            {sameTeam.map((s) => {
              const member = allMembers.find((m) => m.id === s.playerId);
              const memberInitials = member
                ? (member.firstName[0] ?? '') + (member.lastName[0] ?? '')
                : '??';
              const memberName = member
                ? `${member.firstName} ${member.lastName}`
                : 'Unknown player';
              return (
                <TouchableOpacity
                  key={s.playerId}
                  style={styles.linkedMemberRow}
                  onPress={() =>
                    router.replace({
                      pathname: '/player/[id]' as any,
                      params: { id: s.playerId, teamId },
                    })
                  }
                >
                  <View style={styles.linkedAvatar}>
                    <Text style={styles.linkedAvatarText}>
                      {memberInitials}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.linkedName}>{memberName}</Text>
                    <Text style={styles.linkedRole}>
                      {member?.jerseyNumber != null ? `#${member.jerseyNumber} · ` : ''}{member?.position ?? 'Player'}
                    </Text>
                  </View>
                  <FontAwesome5 name="chevron-right" size={12} color={Colors.textMuted} />
                </TouchableOpacity>
              );
            })}
            {crossTeam.map((s) => {
              const info = crossTeamSiblings.get(`${s.teamId}/${s.playerId}`);
              const name = info
                ? `${info.player.firstName} ${info.player.lastName}`
                : 'Loading…';
              const teamLabel = info?.teamName ?? s.teamId;
              const initials = info
                ? (info.player.firstName[0] ?? '') + (info.player.lastName[0] ?? '')
                : '??';
              return (
                <TouchableOpacity
                  key={`${s.teamId}/${s.playerId}`}
                  style={styles.linkedMemberRow}
                  onPress={() =>
                    router.replace({
                      pathname: '/player/[id]' as any,
                      params: { id: s.playerId, teamId: s.teamId },
                    })
                  }
                >
                  <View style={[styles.linkedAvatar, { backgroundColor: Colors.saintsGold }]}>
                    <Text style={[styles.linkedAvatarText, { color: Colors.saintsBlueDark }]}>
                      {initials}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.linkedName}>{name}</Text>
                    <Text style={styles.linkedRole}>{teamLabel}</Text>
                  </View>
                  <FontAwesome5 name="chevron-right" size={12} color={Colors.textMuted} />
                </TouchableOpacity>
              );
            })}
          </View>
        );
      })()}

      {/* Stats placeholder */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Stats</Text>
        <View style={styles.statsPlaceholder}>
          <FontAwesome5 name="chart-bar" size={24} color={Colors.gray} />
          <Text style={styles.statsText}>Player stats will be available in a future update.</Text>
        </View>
      </View>

      {/* Admin actions */}
      {(canEditRoster || canRemove) && (
        <View style={styles.actions}>
          {canEditRoster && (
          <TouchableOpacity
            style={styles.editBtn}
            onPress={() =>
              router.push({
                pathname: '/player/form' as any,
                params: { teamId, playerId: id },
              })
            }
          >
            <FontAwesome5 name="edit" size={14} color={Colors.white} />
            <Text style={styles.editBtnText}>Edit {roleLabel}</Text>
          </TouchableOpacity>
          )}

          {canRemove && (
          <TouchableOpacity style={styles.deleteBtn} onPress={confirmDelete}>
            <FontAwesome5 name="trash-alt" size={14} color={Colors.danger} />
            <Text style={styles.deleteBtnText}>Remove</Text>
          </TouchableOpacity>
          )}
        </View>
      )}
    </ScrollView>
  );
}

function DetailRow({
  icon,
  label,
  value,
  valueColor,
}: {
  icon: string;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={rowStyles.row}>
      <FontAwesome5 name={icon} size={14} color={Colors.textMuted} style={rowStyles.icon} solid />
      <Text style={rowStyles.label}>{label}</Text>
      <Text style={[rowStyles.value, valueColor ? { color: valueColor } : undefined]}>{value}</Text>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.gray },
  icon: { width: 22 },
  label: { flex: 1, fontSize: 14, color: Colors.textSecondary },
  value: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.light },
  content: { paddingBottom: 40 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary, marginTop: 16 },
  backBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: Colors.saintsBlue, borderRadius: 8 },
  backBtnText: { color: Colors.white, fontWeight: '700' },

  headerCard: {
    backgroundColor: Colors.saintsBlueDark,
    alignItems: 'center',
    paddingTop: 32,
    paddingBottom: 28,
    paddingHorizontal: 20,
  },
  avatarLg: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.saintsBlue,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: Colors.saintsGold,
  },
  avatarLgText: { color: Colors.saintsGold, fontWeight: '800', fontSize: 28 },
  playerName: { color: Colors.white, fontSize: 24, fontWeight: '800', marginTop: 12 },
  badgeRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  roleBadge: {
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  roleText: { fontWeight: '700', fontSize: 14, color: Colors.white },
  jerseyBadge: {
    backgroundColor: Colors.saintsGold,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  jerseyText: { fontWeight: '800', fontSize: 14, color: Colors.saintsBlueDark },
  positionBadge: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  positionText: { fontWeight: '700', fontSize: 14, color: Colors.white },

  section: {
    backgroundColor: Colors.white,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 14,
    padding: 18,
  },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary, marginBottom: 6 },

  statsPlaceholder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  statsText: { flex: 1, fontSize: 13, color: Colors.textMuted },

  actions: {
    flexDirection: 'row',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 20,
  },
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
  editBtnText: { color: Colors.white, fontWeight: '700', fontSize: 15 },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  deleteBtnText: { color: Colors.danger, fontWeight: '700', fontSize: 15 },

  linkedMemberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.gray,
  },
  linkedAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.saintsBlue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkedAvatarText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  linkedName: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  linkedRole: { fontSize: 12, color: Colors.textMuted, marginTop: 1 },
});
