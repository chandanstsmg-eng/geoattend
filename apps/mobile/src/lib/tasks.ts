import type { Task } from './api/types';
import type { Tone } from './theme';

export const TASK_STATUS: Record<Task['status'], { label: string; tone: Tone }> = {
  OPEN: { label: 'To do', tone: 'warning' },
  REOPENED: { label: 'Sent back', tone: 'danger' },
  SUBMITTED: { label: 'Waiting for check', tone: 'info' },
  APPROVED: { label: 'Approved', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};
