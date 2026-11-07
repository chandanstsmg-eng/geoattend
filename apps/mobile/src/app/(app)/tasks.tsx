/** My tasks: what to do, what is waiting for the manager, what was approved. */
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, ErrorState, H2, Loading, Muted, Screen } from '../../components/ui';
import { api, errorMessage } from '../../lib/api/client';
import type { Task } from '../../lib/api/types';
import { fmtDate, localISODate } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { colors, font, space } from '../../lib/theme';
import { TASK_STATUS } from '../../lib/tasks';

export default function TasksScreen() {
  const q = useQuery({ queryKey: qk.tasks, queryFn: () => api<Task[]>('/tasks/mine') });
  if (q.isPending) return <Loading label="Loading tasks…" />;
  if (!q.data) return <Screen><ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} /></Screen>;
  const todo = q.data.filter((t) => t.status === 'OPEN' || t.status === 'REOPENED');
  const rest = q.data.filter((t) => !(t.status === 'OPEN' || t.status === 'REOPENED'));
  const today = localISODate();

  const row = (t: Task) => (
    <Pressable
      key={t.id}
      onPress={() => router.push({ pathname: '/task', params: { id: t.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${t.title}, ${TASK_STATUS[t.status].label}`}
      style={({ pressed }) => [st.row, pressed && { backgroundColor: colors.navySoft }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={st.title}>{t.title}</Text>
        <Muted>
          {t.due_date ? `Due ${fmtDate(t.due_date)}${t.due_date < today && (t.status === 'OPEN' || t.status === 'REOPENED') ? ' · overdue' : ''}` : 'No due date'}
          {t.requires_photo ? ' · photo needed' : ''}
        </Muted>
      </View>
      <Badge label={TASK_STATUS[t.status].label} tone={TASK_STATUS[t.status].tone} />
      <Text style={st.chev}>›</Text>
    </Pressable>
  );

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isFetching}>
      <Card>
        <H2>To do</H2>
        {todo.length ? todo.map(row) : <Muted>Nothing to do right now.</Muted>}
      </Card>
      {rest.length ? (
        <Card>
          <H2>Done</H2>
          {rest.map(row)}
        </Card>
      ) : null}
    </Screen>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 56, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: colors.border },
  title: { fontSize: font.md, fontWeight: '700', color: colors.text },
  chev: { fontSize: 24, color: colors.textFaint },
});
