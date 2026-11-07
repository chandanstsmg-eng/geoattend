import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { colors } from '../../../lib/theme';

function Glyph({ ch, color }: { ch: string; color: ColorValue }) {
  return <Text style={{ color, fontSize: 18, fontWeight: '700' }}>{ch}</Text>;
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.navy },
        headerTintColor: colors.white,
        headerTitleStyle: { fontWeight: '700' },
        tabBarActiveTintColor: colors.orange,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 12, fontWeight: '700' },
        tabBarStyle: { minHeight: 60 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', headerTitle: 'GeoAttend', tabBarIcon: ({ color }) => <Glyph ch="⌂" color={color} /> }} />
      <Tabs.Screen name="history" options={{ title: 'History', headerTitle: 'Attendance history', tabBarIcon: ({ color }) => <Glyph ch="☰" color={color} /> }} />
      <Tabs.Screen name="leave" options={{ title: 'Leave', headerTitle: 'Leave', tabBarIcon: ({ color }) => <Glyph ch="✈" color={color} /> }} />
      <Tabs.Screen name="privacy" options={{ title: 'Privacy', headerTitle: 'Privacy & tracking', tabBarIcon: ({ color }) => <Glyph ch="ⓘ" color={color} /> }} />
      <Tabs.Screen name="account" options={{ title: 'Account', headerTitle: 'Account settings', tabBarIcon: ({ color }) => <Glyph ch="◉" color={color} /> }} />
    </Tabs>
  );
}
