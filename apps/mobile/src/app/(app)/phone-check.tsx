/** Phone health check: one screen that tells the employee exactly what to fix before a shift. */
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, StyleSheet, Text, View } from 'react-native';
import { Badge, Body, Button, Card, H2, Loading, Muted, Screen } from '../../components/ui';
import { brandSteps, runPhoneChecks, type HealthCheck } from '../../lib/phone-health';
import { colors, font, space } from '../../lib/theme';

const ICON = { ok: '✓', warn: '!', fail: '✕' } as const;
const TONE = { ok: colors.success, warn: colors.warning, fail: colors.danger } as const;

export default function PhoneCheckScreen() {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const refresh = useCallback(() => void runPhoneChecks().then(setChecks), []);
  useEffect(() => {
    refresh();
    // Re-check when the employee comes back from the phone's settings.
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);

  if (!checks) return <Loading label="Checking your phone…" />;
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  const brand = brandSteps();

  return (
    <Screen onRefresh={refresh}>
      <Card tone={fails ? 'danger' : warns ? 'warning' : 'success'}>
        <H2 color={fails ? colors.danger : warns ? colors.warning : colors.success}>
          {fails ? 'Fix this before your shift' : warns ? 'Almost ready' : 'Your phone is ready'}
        </H2>
        <Body>
          {fails
            ? `${fails} setting${fails > 1 ? 's' : ''} will stop attendance from working.`
            : warns
              ? 'Attendance will work. Fixing the items below stops “tracking stopped” alerts to your manager.'
              : 'Location, GPS and notifications are all set for your shift.'}
        </Body>
      </Card>

      <Card>
        {checks.map((c) => (
          <View key={c.key} style={st.row}>
            <View style={[st.icon, { backgroundColor: TONE[c.level] }]} accessibilityLabel={c.level === 'ok' ? 'OK' : c.level === 'warn' ? 'Warning' : 'Problem'}>
              <Text style={st.iconText}>{ICON[c.level]}</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={st.title}>{c.title}</Text>
              <Muted>{c.detail}</Muted>
              {c.fix && c.fixLabel ? (
                <Button title={c.fixLabel} variant="secondary" style={{ marginTop: space.sm, alignSelf: 'flex-start', minHeight: 44 }} onPress={() => void Promise.resolve(c.fix!()).finally(refresh)} />
              ) : null}
            </View>
          </View>
        ))}
      </Card>

      {brand ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <H2>{brand.brand} phones</H2>
            <Badge label="Important" tone="warning" />
          </View>
          <Muted>These phones close apps in the background to save battery. Do these once:</Muted>
          {brand.steps.map((s, i) => (
            <Text key={s} style={st.step}>
              {i + 1}. {s}
            </Text>
          ))}
          <Button title="Open GeoAttend settings" variant="secondary" onPress={() => void Linking.openSettings()} />
        </Card>
      ) : null}
      <Button title="Check again" variant="ghost" onPress={refresh} />
    </Screen>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  icon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  iconText: { color: colors.white, fontWeight: '800', fontSize: font.md },
  title: { fontSize: font.md, fontWeight: '700', color: colors.text },
  step: { fontSize: font.md, color: colors.text, lineHeight: 22 },
});
