/**
 * Screen 4: workplace map — marker, geofence circle, the user's location and
 * the live distance from the last server status. On Android without a Google
 * Maps key, an explicit panel is shown instead of a blank map.
 */
import { Linking, Platform, StyleSheet, View } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import { Banner, Body, Button, Card, DemoBadge, ErrorState, H2, Loading, Muted, Row, Screen } from '../../components/ui';
import { errorMessage } from '../../lib/api/client';
import { GOOGLE_MAPS_CONFIGURED } from '../../lib/config';
import { fmtAgo, fmtDistance } from '../../lib/format';
import { useAssignment, useStatus } from '../../lib/hooks';
import { colors, radius, space } from '../../lib/theme';

export default function MapScreen() {
  const assignment = useAssignment();
  const statusQ = useStatus({ poll: true });
  if (assignment.isPending) return <Loading />;
  if (!assignment.data) return <Screen><ErrorState message={errorMessage(assignment.error)} onRetry={() => assignment.refetch()} /></Screen>;

  const status = statusQ.data ?? null;
  const wp = status?.workplace ?? assignment.data.workplace;
  if (!wp) {
    return (
      <Screen>
        <Card tone="warning">
          <H2>No workplace assigned</H2>
          <Body>Contact your administrator.</Body>
        </Card>
      </Screen>
    );
  }
  const mapAvailable = Platform.OS !== 'android' || GOOGLE_MAPS_CONFIGURED;
  const delta = Math.max(0.004, (wp.radiusM / 111_000) * 6);
  const s = status?.session;

  return (
    <Screen>
      {mapAvailable ? (
        <View style={st.mapWrap}>
          <MapView
            style={StyleSheet.absoluteFill}
            initialRegion={{ latitude: wp.latitude, longitude: wp.longitude, latitudeDelta: delta, longitudeDelta: delta }}
            showsUserLocation
            showsMyLocationButton
            accessibilityLabel={`Map of ${wp.name} with a ${Math.round(wp.radiusM)} metre attendance area`}
          >
            <Marker coordinate={{ latitude: wp.latitude, longitude: wp.longitude }} title={wp.name} description={`Attendance area: ${Math.round(wp.radiusM)} m`} pinColor={colors.orange} />
            <Circle center={{ latitude: wp.latitude, longitude: wp.longitude }} radius={wp.radiusM} strokeColor={colors.navy} strokeWidth={2} fillColor="rgba(30,41,82,0.15)" />
          </MapView>
        </View>
      ) : (
        <Card tone="warning">
          <H2 color={colors.warning}>Map unavailable — Google Maps key not configured</H2>
          <Body>This build has no Google Maps API key, so the map cannot be drawn. Your workplace area is:</Body>
          <Row label="Latitude" value={wp.latitude.toFixed(6)} />
          <Row label="Longitude" value={wp.longitude.toFixed(6)} />
          <Row label="Radius" value={fmtDistance(wp.radiusM)} strong />
          <Button
            title="Open in maps app"
            variant="secondary"
            onPress={() => void Linking.openURL(`geo:${wp.latitude},${wp.longitude}?q=${wp.latitude},${wp.longitude}(${encodeURIComponent(wp.name)})`)}
          />
        </Card>
      )}

      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <H2>{wp.name}</H2>
          <DemoBadge show={s?.isSimulated || assignment.data.workplace?.isDemo} />
        </View>
        {wp.address ? <Muted>{wp.address}</Muted> : null}
        <Row label="Attendance area radius" value={fmtDistance(wp.radiusM)} />
        {s ? (
          <>
            <Row label="Your distance (last server check)" value={fmtDistance(s.lastDistanceM)} strong />
            <Row label="GPS accuracy" value={s.lastAccuracyM == null ? '—' : `±${Math.round(s.lastAccuracyM)} m`} />
            <Row label="Last update" value={fmtAgo(s.lastLocationAt)} />
          </>
        ) : (
          <Muted>Your distance is shown while a shift is in progress.</Muted>
        )}
      </Card>
      {s?.isStale ? <Banner tone="warning" title="Location not updating" message="The distance above may be out of date." /> : null}
      <Muted>The blue dot is your phone’s own position. Attendance eligibility is always decided by the server.</Muted>
    </Screen>
  );
}

const st = StyleSheet.create({
  mapWrap: { height: 360, borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, marginBottom: space.xs },
});
