/** SOS: sends my location to my managers as an urgent alert. */
import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import * as Location from 'expo-location';
import { Body, Card, Field, H2, Muted, Screen } from '../../components/ui';
import { api, errorMessage } from '../../lib/api/client';
import { fmtTime } from '../../lib/format';
import { colors, font, space } from '../../lib/theme';

interface Sos {
  id: string;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  created_at: string;
  acknowledged_by_name: string | null;
}

export default function SosScreen() {
  const mine = useQuery({ queryKey: ['me', 'sos'], queryFn: () => api<Sos | null>('/sos/mine'), refetchInterval: 10_000 });
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      // Take whatever fix the phone can give within a few seconds; an SOS never waits for perfect GPS.
      const fix = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => Location.getLastKnownPositionAsync().catch(() => null)),
        new Promise<null>((r) => setTimeout(() => r(null), 6000)),
      ]);
      await api('/sos/mine', {
        method: 'POST',
        body: { message: message.trim() || undefined, location: fix?.coords.accuracy ? { latitude: fix.coords.latitude, longitude: fix.coords.longitude, accuracyM: fix.coords.accuracy } : undefined },
      });
      await mine.refetch();
    } catch (e) {
      Alert.alert('SOS not sent', `${errorMessage(e)}\n\nIf you are in danger, call 112 now.`, [{ text: 'Call 112', onPress: () => void Linking.openURL('tel:112') }, { text: 'OK' }]);
    } finally {
      setSending(false);
    }
  };
  const confirm = () =>
    Alert.alert('Send SOS?', 'Your managers get an urgent alert with your location.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send SOS', style: 'destructive', onPress: () => void send() },
    ]);

  const sos = mine.data;
  return (
    <Screen>
      {sos ? (
        <Card tone={sos.status === 'ACKNOWLEDGED' ? 'success' : 'danger'}>
          <H2 color={sos.status === 'ACKNOWLEDGED' ? colors.success : colors.danger}>{sos.status === 'ACKNOWLEDGED' ? 'Help is on the way' : 'SOS sent'}</H2>
          <Body>
            {sos.status === 'ACKNOWLEDGED'
              ? `${sos.acknowledged_by_name ?? 'Your manager'} has seen your SOS and is handling it.`
              : `Sent at ${fmtTime(sos.created_at)}. Your managers have been alerted. Stay where you are if it is safe.`}
          </Body>
          <Muted>Press the button again to send your latest location.</Muted>
        </Card>
      ) : (
        <Card>
          <H2>Need help?</H2>
          <Body>Use this if you are hurt, unsafe, or stuck. Your managers get an urgent alert with your location.</Body>
        </Card>
      )}

      <View style={{ alignItems: 'center', marginVertical: space.lg }}>
        <Pressable onPress={confirm} disabled={sending} accessibilityRole="button" accessibilityLabel="Send SOS" style={({ pressed }) => [st.button, (pressed || sending) && { opacity: 0.8 }]}>
          <Text style={st.buttonText}>{sending ? 'Sending…' : 'SOS'}</Text>
        </Pressable>
      </View>
      <Field label="Short message (optional)" value={message} onChangeText={setMessage} maxLength={500} placeholder="e.g. Bike accident near the gate" />
      <Pressable onPress={() => void Linking.openURL('tel:112')} accessibilityRole="button" style={st.call}>
        <Text style={st.callText}>Emergency? Call 112</Text>
      </Pressable>
    </Screen>
  );
}

const st = StyleSheet.create({
  button: { width: 180, height: 180, borderRadius: 90, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center', borderWidth: 8, borderColor: '#FCA5A5' },
  buttonText: { color: colors.white, fontSize: 44, fontWeight: '900', letterSpacing: 2 },
  call: { alignSelf: 'center', padding: space.md },
  callText: { color: colors.danger, fontSize: font.lg, fontWeight: '700', textDecorationLine: 'underline' },
});
