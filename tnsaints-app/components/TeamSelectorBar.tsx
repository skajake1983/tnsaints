import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  Platform,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Colors } from '../constants/Colors';
import { useTeamStore, Team } from '../stores/teamStore';
import { usePermissions } from '../hooks/usePermissions';

export default function TeamSelectorBar() {
  const { teams, activeTeamId, setActiveTeam } = useTeamStore();
  const { can } = usePermissions();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const activeTeam = teams.find((t) => t.id === activeTeamId);

  const handleSelect = (teamId: string) => {
    setActiveTeam(teamId);
    setOpen(false);
  };

  const handleCreate = () => {
    setOpen(false);
    router.push('/team/create' as any);
  };

  return (
    <View style={styles.wrapper}>
      <TouchableOpacity style={styles.bar} onPress={() => setOpen(!open)} activeOpacity={0.7}>
        <FontAwesome5 name="shield-alt" size={14} color={Colors.saintsGold} />
        <Text style={styles.teamName} numberOfLines={1}>
          {activeTeam?.name ?? 'Select Team'}
        </Text>
        <FontAwesome5 name={open ? 'chevron-up' : 'chevron-down'} size={11} color={Colors.textMuted} />
      </TouchableOpacity>

      {open && (
        Platform.OS === 'web' ? (
          <View style={styles.dropdown}>
            {teams.map((t) => (
              <TouchableOpacity
                key={t.id}
                style={[styles.option, t.id === activeTeamId && styles.optionActive]}
                onPress={() => handleSelect(t.id)}
              >
                <FontAwesome5
                  name="shield-alt"
                  size={12}
                  color={t.id === activeTeamId ? Colors.white : Colors.saintsBlue}
                />
                <Text style={[styles.optionText, t.id === activeTeamId && styles.optionTextActive]}>
                  {t.name}
                </Text>
                {t.id === activeTeamId && (
                  <FontAwesome5 name="check" size={12} color={Colors.white} style={{ marginLeft: 'auto' }} />
                )}
              </TouchableOpacity>
            ))}
            {can('team.create') && (
              <TouchableOpacity style={styles.createOption} onPress={handleCreate}>
                <FontAwesome5 name="plus-circle" size={14} color={Colors.saintsBlue} />
                <Text style={styles.createOptionText}>Create New Team</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <Modal transparent animationType="fade" visible={open} onRequestClose={() => setOpen(false)}>
            <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setOpen(false)}>
              <View style={styles.modalSheet}>
                <Text style={styles.modalTitle}>Switch Team</Text>
                <FlatList
                  data={teams}
                  keyExtractor={(t) => t.id}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={[styles.modalOption, item.id === activeTeamId && styles.modalOptionActive]}
                      onPress={() => handleSelect(item.id)}
                    >
                      <FontAwesome5
                        name="shield-alt"
                        size={14}
                        color={item.id === activeTeamId ? Colors.white : Colors.saintsBlue}
                      />
                      <Text
                        style={[
                          styles.modalOptionText,
                          item.id === activeTeamId && styles.modalOptionTextActive,
                        ]}
                      >
                        {item.name}
                      </Text>
                      {item.id === activeTeamId && (
                        <FontAwesome5 name="check" size={14} color={Colors.white} style={{ marginLeft: 'auto' }} />
                      )}
                    </TouchableOpacity>
                  )}
                  ListFooterComponent={
                    can('team.create') ? (
                      <TouchableOpacity style={styles.modalCreate} onPress={handleCreate}>
                        <FontAwesome5 name="plus-circle" size={16} color={Colors.saintsBlue} />
                        <Text style={styles.modalCreateText}>Create New Team</Text>
                      </TouchableOpacity>
                    ) : null
                  }
                />
              </View>
            </TouchableOpacity>
          </Modal>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { zIndex: 100 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    backgroundColor: Colors.saintsBlueDark,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  teamName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: Colors.white,
  },

  // Web dropdown
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 16,
    right: 16,
    backgroundColor: Colors.white,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.gray,
    marginTop: 4,
    shadowColor: '#06255c',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.gray,
  },
  optionActive: { backgroundColor: Colors.saintsBlue },
  optionText: { fontSize: 15, color: Colors.textPrimary, fontWeight: '600' },
  optionTextActive: { color: Colors.white },
  createOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  createOptionText: { fontSize: 15, fontWeight: '700', color: Colors.saintsBlue },

  // Native modal
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 16,
    paddingBottom: 34,
    maxHeight: '60%',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: 12,
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.gray,
  },
  modalOptionActive: { backgroundColor: Colors.saintsBlue },
  modalOptionText: { fontSize: 16, fontWeight: '600', color: Colors.textPrimary },
  modalOptionTextActive: { color: Colors.white },
  modalCreate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  modalCreateText: { fontSize: 16, fontWeight: '700', color: Colors.saintsBlue },
});
