import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useAuthStore } from '../../stores/authStore';
import { Colors } from '../../constants/Colors';

export default function MoreScreen() {
  const profile = useAuthStore((s) => s.profile);
  const signOut = useAuthStore((s) => s.signOut);

  const menuItems = [
    { icon: 'images', label: 'Media Gallery', hint: 'Phase 4' },
    { icon: 'file-invoice-dollar', label: 'Invoices', hint: 'Phase 6' },
    { icon: 'chart-bar', label: 'Stats', hint: 'Phase 5' },
    { icon: 'bell', label: 'Alerts', hint: 'Phase 4' },
    { icon: 'user-edit', label: 'Edit Profile', hint: '' },
  ];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Profile summary */}
      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <FontAwesome5 name="user" size={28} color={Colors.saintsBlue} />
        </View>
        <View>
          <Text style={styles.profileName}>{profile?.name ?? 'Tennessee Saints'}</Text>
          <Text style={styles.profileEmail}>{profile?.email ?? ''}</Text>
        </View>
      </View>

      {/* Menu items */}
      {menuItems.map((item) => (
        <TouchableOpacity key={item.label} style={styles.menuRow} activeOpacity={0.6}>
          <FontAwesome5 name={item.icon} size={18} color={Colors.saintsBlue} style={styles.menuIcon} />
          <Text style={styles.menuLabel}>{item.label}</Text>
          {item.hint ? <Text style={styles.menuHint}>{item.hint}</Text> : null}
          <FontAwesome5 name="chevron-right" size={12} color={Colors.textMuted} />
        </TouchableOpacity>
      ))}

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

  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: 18,
    marginBottom: 24,
    shadowColor: '#06255c',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.light,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.gray,
  },
  profileName: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary },
  profileEmail: { fontSize: 13, color: Colors.textMuted, marginTop: 2 },

  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
  },
  menuIcon: { width: 28 },
  menuLabel: { flex: 1, fontSize: 15, fontWeight: '600', color: Colors.textPrimary },
  menuHint: {
    fontSize: 11,
    color: Colors.textMuted,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginRight: 8,
  },

  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 20,
    marginTop: 12,
  },
  signOutText: { color: Colors.danger, fontWeight: '700', fontSize: 15 },
});
