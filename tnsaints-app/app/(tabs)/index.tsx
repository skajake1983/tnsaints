import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';
import { Colors } from '../../constants/Colors';

export default function HomeScreen() {
  const profile = useAuthStore((s) => s.profile);
  const signOut = useAuthStore((s) => s.signOut);
  const { teams, activeTeamId } = useTeamStore();
  const router = useRouter();

  const firstName = profile?.name?.split(' ')[0] ?? 'Saint';
  const activeTeam = teams.find((t) => t.id === activeTeamId);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Welcome header */}
      <View style={styles.welcomeCard}>
        <Text style={styles.welcomeLabel}>Welcome back,</Text>
        <Text style={styles.welcomeName}>{firstName}</Text>
        <Text style={styles.welcomeRole}>{profile?.role ?? 'Member'}</Text>
        {activeTeam && (
          <View style={styles.teamBadge}>
            <FontAwesome5 name="shield-alt" size={12} color={Colors.saintsGold} />
            <Text style={styles.teamBadgeText}>{activeTeam.name}</Text>
          </View>
        )}
      </View>

      {/* Quick actions */}
      <Text style={styles.sectionTitle}>Quick Actions</Text>
      <View style={styles.actionsGrid}>
        <TouchableOpacity style={styles.actionCard} onPress={() => router.push('/(tabs)/schedule')}>
          <FontAwesome5 name="calendar-alt" size={24} color={Colors.saintsBlue} />
          <Text style={styles.actionLabel}>Schedule</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionCard} onPress={() => router.push('/(tabs)/team')}>
          <FontAwesome5 name="users" size={24} color={Colors.saintsBlue} />
          <Text style={styles.actionLabel}>Roster</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionCard} onPress={() => router.push('/(tabs)/chat')}>
          <FontAwesome5 name="comments" size={24} color={Colors.saintsBlue} />
          <Text style={styles.actionLabel}>Chat</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionCard} onPress={() => router.push('/(tabs)/more')}>
          <FontAwesome5 name="cog" size={24} color={Colors.saintsBlue} />
          <Text style={styles.actionLabel}>Settings</Text>
        </TouchableOpacity>
      </View>

      {/* Upcoming event placeholder */}
      <Text style={styles.sectionTitle}>Next Event</Text>
      <View style={styles.eventCard}>
        <FontAwesome5 name="basketball-ball" size={20} color={Colors.saintsGold} />
        <View style={styles.eventInfo}>
          <Text style={styles.eventTitle}>No upcoming events</Text>
          <Text style={styles.eventSub}>Events will appear here once scheduled.</Text>
        </View>
      </View>

      {/* Sign out */}
      <TouchableOpacity style={styles.signOutBtn} onPress={signOut}>
        <FontAwesome5 name="sign-out-alt" size={16} color={Colors.danger} />
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.light },
  content: { padding: 20, paddingBottom: 40 },

  welcomeCard: {
    backgroundColor: Colors.saintsBlueDark,
    borderRadius: 18,
    padding: 24,
    marginBottom: 24,
  },
  welcomeLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 14 },
  welcomeName: { color: Colors.white, fontSize: 28, fontWeight: '800', marginTop: 2 },
  welcomeRole: {
    color: Colors.saintsGold,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 6,
  },
  teamBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  teamBadgeText: {
    color: Colors.white,
    fontSize: 13,
    fontWeight: '600',
  },

  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginBottom: 12,
  },

  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 24,
  },
  actionCard: {
    width: '47%',
    backgroundColor: Colors.white,
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    gap: 10,
    shadowColor: '#06255c',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  actionLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textPrimary,
  },

  eventCard: {
    backgroundColor: Colors.white,
    borderRadius: 14,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 28,
    borderLeftWidth: 4,
    borderLeftColor: Colors.saintsGold,
  },
  eventInfo: { flex: 1 },
  eventTitle: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  eventSub: { fontSize: 13, color: Colors.textMuted, marginTop: 2 },

  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
  },
  signOutText: {
    color: Colors.danger,
    fontWeight: '700',
    fontSize: 15,
  },
});
