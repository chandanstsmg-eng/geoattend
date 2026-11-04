import { Stack } from 'expo-router';
import { TrackingSupervisor } from '../../components/TrackingSupervisor';
import { colors } from '../../lib/theme';

export default function AppLayout() {
  return (
    <>
      <TrackingSupervisor />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.navy },
          headerTintColor: colors.white,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="map" options={{ title: 'Workplace map' }} />
        <Stack.Screen name="shift-details" options={{ title: 'Shift details' }} />
        <Stack.Screen name="permissions" options={{ title: 'Location permission' }} />
        <Stack.Screen name="activate" options={{ title: 'Start tracking', headerBackVisible: false, gestureEnabled: false }} />
        <Stack.Screen name="shift" options={{ title: 'My shift' }} />
        <Stack.Screen name="break" options={{ title: 'Take a break' }} />
        <Stack.Screen name="overtime" options={{ title: 'Start overtime' }} />
        <Stack.Screen name="face-enroll" options={{ title: 'Set up your face' }} />
        <Stack.Screen name="end-shift" options={{ title: 'End shift', headerShown: false }} />
        <Stack.Screen name="capture" options={{ title: 'Attendance photo', headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="success" options={{ title: 'Attendance recorded', headerBackVisible: false, gestureEnabled: false }} />
        <Stack.Screen name="phone-check" options={{ title: 'Phone check' }} />
        <Stack.Screen name="earnings" options={{ title: 'My earnings' }} />
        <Stack.Screen name="payslip" options={{ title: 'Payslip' }} />
        <Stack.Screen name="tasks" options={{ title: 'My tasks' }} />
        <Stack.Screen name="task" options={{ title: 'Task' }} />
        <Stack.Screen name="sos" options={{ title: 'SOS', headerStyle: { backgroundColor: colors.danger } }} />
        <Stack.Screen name="messages" options={{ title: 'Announcements' }} />
        <Stack.Screen name="completed" options={{ title: 'Shift completed', headerBackVisible: false, gestureEnabled: false }} />
      </Stack>
    </>
  );
}
