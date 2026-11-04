/** Announcements from the company; opening the screen marks them read (the manager sees who read). */
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, ErrorState, Loading, Muted, Screen } from '../../components/ui';
import { api, errorMessage } from '../../lib/api/client';
import { fmtDateTime } from '../../lib/format';
import { queryClient } from '../../lib/queryClient';
import { colors, font, space } from '../../lib/theme';

export interface Broadcast {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at?: string | null;
  read_at: string | null;
  sent_by: string | null;
  pinned?: boolean;
  workplace_name?: string | null;
}

export default function AnnouncementsScreen() {
  const q = useQuery({ queryKey: ['me', 'messages'], queryFn: () => api<Broadcast[]>('/broadcasts/mine') });
  useEffect(() => {
    const unread = (q.data ?? []).filter((m) => !m.read_at);
    if (!unread.length) return;
    void Promise.all(unread.map((m) => api(`/broadcasts/mine/${m.id}/read`, { method: 'POST' }).catch(() => undefined))).then(() =>
      queryClient.invalidateQueries({ queryKey: ['me', 'messages'] }),
    );
  }, [q.data]);

  if (q.isPending) return <Loading label="Loading announcements…" />;
  if (!q.data) return <Screen><ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} /></Screen>;
  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isFetching}>
      {q.data.length === 0 ? (
        <Card><Muted>No announcements yet.</Muted></Card>
      ) : (
        q.data.map((m) => (
          <Card key={m.id} tone={m.pinned ? 'info' : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Text style={st.title}>{m.title}</Text>
              {m.pinned ? <Badge label="Pinned" tone="info" /> : null}
              {!m.read_at ? <Badge label="New" tone="warning" /> : null}
            </View>
            <Text style={st.body}>{m.body}</Text>
            <Muted>
              {m.sent_by ? `${m.sent_by} · ` : ''}
              {m.workplace_name ? `${m.workplace_name} · ` : ''}
              {fmtDateTime(m.created_at)}
              {m.updated_at ? ' · edited' : ''}
            </Muted>
          </Card>
        ))
      )}
    </Screen>
  );
}

const st = StyleSheet.create({
  title: { flex: 1, fontSize: font.lg, fontWeight: '700', color: colors.navy },
  body: { fontSize: font.md, color: colors.text, lineHeight: 22 },
});
