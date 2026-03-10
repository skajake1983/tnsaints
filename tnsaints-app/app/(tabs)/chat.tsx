import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { Colors } from '../../constants/Colors';
import { useChatStore, ChatMessage } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';
import { usePermissions } from '../../hooks/usePermissions';

export default function ChatScreen() {
  const profile = useAuthStore((s) => s.profile);
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const { messages, loading, sendMessage, editMessage, deleteMessage, listen } = useChatStore();
  const { can } = usePermissions();

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [editingMsg, setEditingMsg] = useState<ChatMessage | null>(null);
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    if (!activeTeamId) return;
    const unsub = listen(activeTeamId);
    return unsub;
  }, [activeTeamId]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  const handleSend = useCallback(async () => {
    if (!text.trim() || !activeTeamId || !profile) return;
    setSending(true);
    try {
      if (editingMsg) {
        await editMessage(activeTeamId, editingMsg.id, text.trim());
        setEditingMsg(null);
      } else {
        await sendMessage(activeTeamId, profile.uid, profile.name, text.trim());
      }
      setText('');
    } finally {
      setSending(false);
    }
  }, [text, activeTeamId, profile, sendMessage, editMessage, editingMsg]);

  const handleCancelEdit = useCallback(() => {
    setEditingMsg(null);
    setText('');
  }, []);

  const handleLongPress = useCallback(
    (msg: ChatMessage) => {
      if (!activeTeamId || !profile) return;
      const own = msg.uid === profile.uid;
      const canEditOwn = own && can('chat.editOwn');
      const canDeleteOwn = own && can('chat.deleteOwn');
      const canDeleteAny = can('chat.deleteAny');
      const canDeleteThis = canDeleteOwn || canDeleteAny;

      if (!canEditOwn && !canDeleteThis) return;

      const buttons: { text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }[] = [];

      if (canEditOwn) {
        buttons.push({
          text: 'Edit',
          onPress: () => {
            setEditingMsg(msg);
            setText(msg.text);
            setTimeout(() => inputRef.current?.focus(), 100);
          },
        });
      }

      if (canDeleteThis) {
        buttons.push({
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteMessage(activeTeamId, msg.id),
        });
      }

      buttons.push({ text: 'Cancel', style: 'cancel' });

      Alert.alert('Message Options', undefined, buttons);
    },
    [activeTeamId, profile, can, deleteMessage],
  );

  // No team selected
  if (!activeTeamId) {
    return (
      <View style={styles.empty}>
        <FontAwesome5 name="comments" size={48} color={Colors.gray} />
        <Text style={styles.emptyTitle}>Team Chat</Text>
        <Text style={styles.emptyHint}>Select a team to start chatting</Text>
      </View>
    );
  }

  const canSend = can('chat.send');
  const hasAnyMessageAction = can('chat.editOwn') || can('chat.deleteOwn') || can('chat.deleteAny');
  const isOwn = (uid: string) => uid === profile?.uid;

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const own = isOwn(item.uid);
    const ts = item.createdAt?.toDate?.();
    const timeStr = ts
      ? ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '';
    const edited = !!item.editedAt;

    return (
      <TouchableOpacity
        activeOpacity={hasAnyMessageAction ? 0.6 : 1}
        onLongPress={hasAnyMessageAction ? () => handleLongPress(item) : undefined}
        style={[styles.row, own && styles.rowOwn]}
      >
        <View style={[styles.bubble, own ? styles.bubbleOwn : styles.bubbleOther]}>
          {!own && <Text style={styles.sender}>{item.senderName}</Text>}
          <Text style={[styles.text, own && styles.textOwn]}>{item.text}</Text>
          <View style={styles.meta}>
            {edited && (
              <Text style={[styles.editedLabel, own && styles.timeOwn]}>edited</Text>
            )}
            <Text style={[styles.time, own && styles.timeOwn]}>{timeStr}</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {loading ? (
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={Colors.saintsBlue} />
        </View>
      ) : messages.length === 0 ? (
        <View style={styles.empty}>
          <FontAwesome5 name="comments" size={40} color={Colors.gray} />
          <Text style={styles.emptyHint}>No messages yet — start the conversation!</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={renderMessage}
          contentContainerStyle={styles.list}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        />
      )}

      {canSend && (
        <View>
          {editingMsg && (
            <View style={styles.editBanner}>
              <FontAwesome5 name="pen" size={12} color={Colors.saintsBlue} />
              <Text style={styles.editBannerText} numberOfLines={1}>
                Editing: {editingMsg.text}
              </Text>
              <TouchableOpacity onPress={handleCancelEdit} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <FontAwesome5 name="times" size={14} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>
          )}
          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              placeholder="Type a message…"
              placeholderTextColor={Colors.textMuted}
              value={text}
              onChangeText={setText}
              multiline
              maxLength={1000}
              onSubmitEditing={handleSend}
              blurOnSubmit={false}
            />
            <TouchableOpacity
              style={[styles.sendBtn, (!text.trim() || sending) && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!text.trim() || sending}
            >
              <FontAwesome5
                name={editingMsg ? 'check' : 'paper-plane'}
                size={18}
                color={Colors.white}
              />
            </TouchableOpacity>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light,
  },
  list: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginTop: 16,
  },
  emptyHint: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    maxWidth: 260,
  },
  row: {
    flexDirection: 'row',
    marginVertical: 3,
  },
  rowOwn: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
  },
  bubbleOwn: {
    backgroundColor: Colors.saintsBlue,
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: Colors.white,
    borderBottomLeftRadius: 4,
  },
  sender: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.saintsBlue,
    marginBottom: 2,
  },
  text: {
    fontSize: 15,
    color: Colors.textPrimary,
    lineHeight: 20,
  },
  textOwn: {
    color: Colors.white,
  },
  time: {
    fontSize: 10,
    color: Colors.textMuted,
  },
  timeOwn: {
    color: 'rgba(255,255,255,0.6)',
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
    gap: 6,
  },
  editedLabel: {
    fontSize: 10,
    fontStyle: 'italic',
    color: Colors.textMuted,
  },
  editBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: Colors.white,
    borderTopWidth: 1,
    borderTopColor: Colors.gray,
    gap: 8,
  },
  editBannerText: {
    flex: 1,
    fontSize: 13,
    color: Colors.textSecondary,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: Colors.white,
    borderTopWidth: 1,
    borderTopColor: Colors.gray,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    backgroundColor: Colors.light,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: Colors.textPrimary,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.saintsBlue,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
});
