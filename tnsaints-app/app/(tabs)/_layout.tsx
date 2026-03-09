import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import TeamSelectorBar from '../../components/TeamSelectorBar';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';

export default function TabLayout() {
  const colorScheme = useColorScheme() ?? 'light';
  const profile = useAuthStore((s) => s.profile);
  const listenTeams = useTeamStore((s) => s.listen);

  // Keep teams in sync globally for all tabs
  useEffect(() => {
    const ids = profile?.teamIds ?? [];
    const unsub = listenTeams(ids);
    return unsub;
  }, [profile?.teamIds]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ backgroundColor: Colors[colorScheme].card, paddingTop: 4, paddingBottom: 2 }}>
        <TeamSelectorBar />
      </View>
      <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme].tint,
        tabBarInactiveTintColor: Colors[colorScheme].tabIconDefault,
        tabBarStyle: {
          backgroundColor: Colors[colorScheme].card,
          borderTopColor: Colors[colorScheme].border,
        },
        headerStyle: {
          backgroundColor: Colors[colorScheme].card,
        },
        headerTintColor: Colors[colorScheme].text,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => (
            <FontAwesome5 name="home" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: 'Schedule',
          tabBarIcon: ({ color, size }) => (
            <FontAwesome5 name="calendar-alt" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          title: 'Team',
          tabBarIcon: ({ color, size }) => (
            <FontAwesome5 name="users" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color, size }) => (
            <FontAwesome5 name="comments" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color, size }) => (
            <FontAwesome5 name="ellipsis-h" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
    </View>
  );
}
