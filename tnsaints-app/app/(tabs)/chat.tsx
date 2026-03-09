import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { Colors } from '../../constants/Colors';

export default function ChatScreen() {
  return (
    <View style={styles.container}>
      <FontAwesome5 name="comments" size={48} color={Colors.gray} />
      <Text style={styles.title}>Team Chat</Text>
      <Text style={styles.sub}>
        Real-time messaging with coaches and teammates will live here.
      </Text>
      <Text style={styles.hint}>Phase 3 — Coming soon</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginTop: 16,
  },
  sub: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    maxWidth: 260,
  },
  hint: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 16,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
});
