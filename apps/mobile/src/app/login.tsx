import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError } from '../lib/api/client';
import { useAuth } from '../lib/auth';
import { API_URL, API_URL_CONFIGURED } from '../lib/config';
import { colors, font, space } from '../lib/theme';
import { Banner, Button, Card, Field, Gap, Muted } from '../components/ui';

function loginMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.isNetwork) return `${err.message}\n(Server: ${API_URL || 'not configured'})`;
    if (err.code === 'WRONG_APP') return err.message;
    if (err.code === 'ACCOUNT_LOCKED' || err.code === 'RATE_LIMITED') return err.message;
    if (err.code === 'VALIDATION_FAILED' || err.status === 400) return 'Enter a valid email address and your password.';
    return err.message;
  }
  return 'Sign-in failed. Please try again.';
}

export default function LoginScreen() {
  const { signIn, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password) {
      setError('Enter your work email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (e) {
      setError(loginMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.navy }} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
          <View style={s.brand}>
            <View style={s.logo}>
              <Text style={s.logoText}>GA</Text>
            </View>
            <Text style={s.title}>GeoAttend</Text>
            <Text style={s.subtitle}>Employee attendance</Text>
          </View>
          <Card>
            {notice ? <Banner tone="warning" title={notice} /> : null}
            {!API_URL_CONFIGURED ? (
              <Banner tone="danger" title="Server address not configured" message="Set EXPO_PUBLIC_API_URL in apps/mobile/.env to your API (LAN IP for development) and restart Metro." />
            ) : null}
            <Field label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" placeholder="name@company.com" />
            <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" onSubmitEditing={submit} returnKeyType="go" />
            {error ? <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text> : null}
            <Button title="Sign in" onPress={submit} loading={busy} />
            <Gap size={space.sm} />
            <Muted center>Administrators sign in to the web dashboard. Forgot your password? Contact your administrator.</Muted>
          </Card>
          <Text style={s.footer}>Location is only collected during a shift you start.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: 'center', padding: space.lg, gap: space.lg },
  brand: { alignItems: 'center', gap: 4, marginBottom: space.md },
  logo: { width: 64, height: 64, borderRadius: 16, backgroundColor: colors.orange, alignItems: 'center', justifyContent: 'center', marginBottom: space.sm },
  logoText: { color: colors.white, fontSize: 24, fontWeight: '800' },
  title: { color: colors.white, fontSize: font.xxl, fontWeight: '800' },
  subtitle: { color: '#C7CCE0', fontSize: font.md },
  error: { color: colors.danger, fontSize: font.sm, marginBottom: space.sm },
  footer: { color: '#C7CCE0', textAlign: 'center', fontSize: font.sm },
});
