/**
 * Battery and network state sent with each location upload, so an administrator
 * whose alert says "tracking stopped" can see it was a flat battery or no signal.
 * Never blocks an upload: anything that fails or is slow is simply left out.
 */
import * as Battery from 'expo-battery';
import NetInfo from '@react-native-community/netinfo';
import type { DeviceStatus } from '../api/types';

const settle = <T>(p: Promise<T>, ms = 1500): Promise<T | null> =>
  Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);

export async function deviceStatus(): Promise<DeviceStatus | undefined> {
  const [power, net] = await Promise.all([settle(Battery.getPowerStateAsync()), settle(NetInfo.fetch())]);
  if (!power && !net) return undefined;
  const level = power && power.batteryLevel >= 0 && power.batteryLevel <= 1 ? power.batteryLevel : null; // -1 = unknown (simulators)
  return {
    batteryLevel: level,
    charging: power ? power.batteryState === Battery.BatteryState.CHARGING || power.batteryState === Battery.BatteryState.FULL : null,
    lowPowerMode: power ? power.lowPowerMode : null,
    network: !net ? 'unknown' : net.isConnected === false ? 'none' : net.type === 'wifi' ? 'wifi' : net.type === 'cellular' ? 'cellular' : net.type === 'unknown' ? 'unknown' : 'other',
  };
}
