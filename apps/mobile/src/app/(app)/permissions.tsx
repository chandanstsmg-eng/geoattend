import { router, useLocalSearchParams } from 'expo-router';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, H1, H2, Muted, Screen } from '../../components/ui';
import { colors, font, space } from '../../lib/theme';

function Point({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <View style={st.point}>
      <View style={st.num}>
        <Text style={st.numText}>{n}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={st.pointTitle}>{title}</Text>
        <Body>{text}</Body>
      </View>
    </View>
  );
}

/** Screen 6: why location (foreground + background) and notifications are needed, before any OS prompt is shown. */
export default function PermissionExplanationScreen() {
  const { shiftId, resume } = useLocalSearchParams<{ shiftId?: string; resume?: string }>();
  return (
    <Screen>
      <H1>{resume ? 'Resume location tracking' : 'Before you start your shift'}</H1>
      <Body>GeoAttend verifies that you are inside your workplace area before attendance can be marked. Here is exactly what happens:</Body>
      <Card>
        <Point n={1} title="Only during this shift" text="Location is collected only after you tap Start shift, and stops when you end the shift or the shift window closes. Nothing is collected when you are off shift." />
        <Point n={2} title="While the app is open" text={`“While using the app” location lets GeoAttend check your distance from the workplace and unlock attendance when you arrive.`} />
        <Point
          n={3}
          title="In the background"
          text={
            Platform.OS === 'android'
              ? '“Allow all the time” keeps updates flowing when the screen is locked or you switch apps. Android opens a settings page for this — choose “Allow all the time”. A notification stays visible while tracking runs.'
              : '“Always” keeps updates flowing when the screen is locked or you switch apps. A blue location indicator stays visible while tracking runs.'
          }
        />
        <Point n={4} title="Notifications" text="Your phone may also ask to allow notifications. They tell you when attendance unlocks, when a break is over, when tracking stops, and when your leave or overtime is decided." />
        <Point n={5} title="Shared with your employer" text="Your administrator sees your status (present, away, etc.) and the location history of this shift, as described in the privacy notice." />
      </Card>
      <Card tone="info">
        <H2 color={colors.info}>If you decline background location</H2>
        <Body>You can still work with “While using the app” only, but updates stop whenever GeoAttend is not on screen. Your administrator will see gaps, and attendance may take longer to unlock.</Body>
      </Card>
      <Muted>You can change these permissions any time in your phone’s Settings.</Muted>
      <Button title="Continue" onPress={() => router.replace({ pathname: '/activate', params: { shiftId: shiftId ?? '', resume: resume ?? '' } })} accessibilityHint="Shows the system location permission prompts" />
      <Button title="Not now" variant="ghost" onPress={() => router.back()} />
    </Screen>
  );
}

const st = StyleSheet.create({
  point: { flexDirection: 'row', gap: space.md, paddingVertical: space.sm },
  num: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.navy, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  numText: { color: colors.white, fontWeight: '700' },
  pointTitle: { fontSize: font.md, fontWeight: '700', color: colors.navy },
});
