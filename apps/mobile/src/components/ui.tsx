import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, font, radius, space, toneColors, TOUCH, type Tone } from '../lib/theme';

export function Screen({
  children,
  refreshing,
  onRefresh,
  scroll = true,
  edges = ['bottom'],
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  scroll?: boolean;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
}) {
  return (
    <SafeAreaView style={styles.screen} edges={edges}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.navy} /> : undefined}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.content, { flex: 1 }]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Card({ children, style, tone }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: Tone }) {
  const t = tone ? toneColors[tone] : null;
  return <View style={[styles.card, t && { backgroundColor: t.bg, borderColor: t.border }, style]}>{children}</View>;
}

export function H1({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.h1} accessibilityRole="header">
      {children}
    </Text>
  );
}
export function H2({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <Text style={[styles.h2, color ? { color } : null]} accessibilityRole="header">
      {children}
    </Text>
  );
}
export function Body({ children, color, center }: { children: ReactNode; color?: string; center?: boolean }) {
  return <Text style={[styles.body, color ? { color } : null, center ? { textAlign: 'center' } : null]}>{children}</Text>;
}
export function Muted({ children, center }: { children: ReactNode; center?: boolean }) {
  return <Text style={[styles.muted, center ? { textAlign: 'center' } : null]}>{children}</Text>;
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  accessibilityHint,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const v = buttonVariants[variant];
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      style={({ pressed }) => [styles.button, { backgroundColor: v.bg, borderColor: v.border }, pressed && !off && { opacity: 0.85 }, off && { opacity: 0.5 }, style]}
    >
      {loading ? <ActivityIndicator color={v.fg} /> : <Text style={[styles.buttonText, { color: v.fg }]}>{title}</Text>}
    </Pressable>
  );
}
const buttonVariants: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.orange, fg: colors.white, border: colors.orange },
  secondary: { bg: colors.white, fg: colors.navy, border: colors.navy },
  ghost: { bg: 'transparent', fg: colors.navy, border: 'transparent' },
  danger: { bg: colors.white, fg: colors.danger, border: colors.danger },
};

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const t = toneColors[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg, borderColor: t.border }]}>
      <Text style={[styles.badgeText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

export function DemoBadge({ show }: { show: boolean | null | undefined }) {
  if (!show) return null;
  return (
    <View style={styles.demo} accessibilityLabel="Demo data">
      <Text style={styles.demoText}>DEMO</Text>
    </View>
  );
}

export function Banner({ tone, title, message, onPress, actionLabel }: { tone: Tone; title: string; message?: string; onPress?: () => void; actionLabel?: string }) {
  const t = toneColors[tone];
  const content = (
    <View style={[styles.banner, { backgroundColor: t.bg, borderColor: t.border }]}>
      <Text style={[styles.bannerTitle, { color: t.fg }]}>{title}</Text>
      {message ? <Text style={styles.bannerMsg}>{message}</Text> : null}
      {onPress && actionLabel ? <Text style={[styles.bannerAction, { color: t.fg }]}>{actionLabel} ›</Text> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}. ${actionLabel ?? ''}`} style={({ pressed }) => pressed && { opacity: 0.8 }}>
      {content}
    </Pressable>
  );
}

export function Row({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {typeof value === 'string' || typeof value === 'number' ? <Text style={[styles.rowValue, strong && { fontWeight: '700' }]}>{value}</Text> : value}
    </View>
  );
}

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string | null }) {
  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textFaint}
        accessibilityLabel={label}
        {...props}
        style={[styles.input, error ? { borderColor: colors.danger } : null, props.multiline ? { minHeight: 96, textAlignVertical: 'top', paddingTop: 12 } : null]}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.navy} />
      <Muted center>{label}</Muted>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card tone="danger">
      <H2 color={colors.danger}>Could not load</H2>
      <Body>{message}</Body>
      {onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} style={{ marginTop: space.md }} /> : null}
    </Card>
  );
}

export function Gap({ size = space.md }: { size?: number }) {
  return <View style={{ height: size }} />;
}

/** Modal asking for a free-text reason (manual review, dispute, technical issue). */
export function ReasonModal({
  visible,
  title,
  description,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  description: string;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setText('');
    setError(null);
    onCancel();
  };
  const submit = async () => {
    if (text.trim().length < 3) {
      setError('Please describe the reason (at least 3 characters).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text.trim());
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <H2>{title}</H2>
          <Muted>{description}</Muted>
          <Gap />
          <Field label="Reason" value={text} onChangeText={setText} multiline maxLength={2000} error={error} placeholder="Describe what happened" />
          <Button title={submitLabel} onPress={submit} loading={busy} />
          <Gap size={space.sm} />
          <Button title="Cancel" variant="ghost" onPress={close} disabled={busy} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, paddingBottom: space.xxl, gap: space.md },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: space.lg, gap: space.sm },
  h1: { fontSize: font.xxl, fontWeight: '700', color: colors.navy },
  h2: { fontSize: font.xl, fontWeight: '700', color: colors.navy },
  body: { fontSize: font.md, color: colors.text, lineHeight: 22 },
  muted: { fontSize: font.sm, color: colors.textMuted, lineHeight: 19 },
  button: { minHeight: TOUCH, borderRadius: radius.md, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  buttonText: { fontSize: font.lg, fontWeight: '700' },
  badge: { alignSelf: 'flex-start', borderRadius: 999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  demo: { alignSelf: 'flex-start', backgroundColor: '#7C3AED', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  demoText: { color: colors.white, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  banner: { borderRadius: radius.md, borderWidth: 1, padding: space.md, gap: 2 },
  bannerTitle: { fontSize: font.md, fontWeight: '700' },
  bannerMsg: { fontSize: font.sm, color: colors.text },
  bannerAction: { fontSize: font.sm, fontWeight: '700', marginTop: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, gap: space.md },
  rowLabel: { fontSize: font.sm, color: colors.textMuted, flexShrink: 0 },
  rowValue: { fontSize: font.md, color: colors.text, flexShrink: 1, textAlign: 'right' },
  label: { fontSize: font.sm, fontWeight: '600', color: colors.text, marginBottom: 6 },
  input: { minHeight: TOUCH, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.white, paddingHorizontal: space.md, fontSize: font.md, color: colors.text },
  fieldError: { color: colors.danger, fontSize: font.sm, marginTop: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,20,40,0.45)' },
  modalSheet: { backgroundColor: colors.white, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.xl, gap: space.sm },
});
