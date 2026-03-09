import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  SafeAreaView,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { Colors } from '../constants/Colors';

interface DropdownPickerProps {
  label: string;
  value: string;
  options: readonly string[] | { label: string; value: string }[];
  onSelect: (value: string) => void;
  placeholder?: string;
  hasError?: boolean;
}

export default function DropdownPicker({
  label,
  value,
  options,
  onSelect,
  placeholder = 'Select…',
  hasError = false,
}: DropdownPickerProps) {
  const [open, setOpen] = useState(false);

  // Normalize options to { label, value } format
  const items = options.map((o) =>
    typeof o === 'string' ? { label: o, value: o } : o,
  );

  const selectedLabel = items.find((i) => i.value === value)?.label ?? '';

  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <TouchableOpacity
        style={[styles.selector, hasError && styles.selectorError]}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}
      >
        <Text style={[styles.selectorText, !selectedLabel && styles.placeholder]}>
          {selectedLabel || placeholder}
        </Text>
        <FontAwesome5 name="chevron-down" size={12} color={Colors.textMuted} />
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" transparent>
        <View style={styles.backdrop}>
          <SafeAreaView style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{label}</Text>
              <TouchableOpacity onPress={() => setOpen(false)} hitSlop={12}>
                <FontAwesome5 name="times" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <FlatList
              data={items}
              keyExtractor={(i) => i.value}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.option, item.value === value && styles.optionActive]}
                  onPress={() => {
                    onSelect(item.value);
                    setOpen(false);
                  }}
                >
                  <Text
                    style={[styles.optionText, item.value === value && styles.optionTextActive]}
                  >
                    {item.label}
                  </Text>
                  {item.value === value && (
                    <FontAwesome5 name="check" size={14} color={Colors.saintsBlue} />
                  )}
                </TouchableOpacity>
              )}
            />
          </SafeAreaView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textSecondary,
    marginTop: 16,
    marginBottom: 6,
  },
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.white,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderWidth: 1.5,
    borderColor: Colors.gray,
  },
  selectorError: {
    borderColor: Colors.danger,
  },
  selectorText: {
    fontSize: 15,
    color: Colors.textPrimary,
    flex: 1,
  },
  placeholder: {
    color: Colors.textMuted,
  },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
    paddingBottom: 20,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.gray,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: Colors.saintsBlueDark,
  },

  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.gray,
  },
  optionActive: {
    backgroundColor: Colors.light,
  },
  optionText: {
    fontSize: 15,
    color: Colors.textPrimary,
  },
  optionTextActive: {
    fontWeight: '700',
    color: Colors.saintsBlue,
  },
});
