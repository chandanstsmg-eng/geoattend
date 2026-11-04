import { router } from 'expo-router';
import type { Assignment } from './api/types';

/**
 * The steps before a shift can start, in order: enroll the face once (when the company requires
 * it), read the location-tracking notice, then grant permissions. The server enforces the first
 * two as well; this only avoids sending the employee to a screen that would be refused.
 */
export function startShift(a: Pick<Assignment, 'noticeAcknowledged' | 'faceEnrollment'>, shiftId: string, how: 'push' | 'replace' = 'push') {
  const go = how === 'push' ? router.push : router.replace;
  if (a.faceEnrollment?.required && !a.faceEnrollment.enrolled) go({ pathname: '/face-enroll', params: { next: 'start', shiftId } });
  else if (!a.noticeAcknowledged) go({ pathname: '/privacy', params: { next: 'start', shiftId } });
  else go({ pathname: '/permissions', params: { shiftId } });
}
