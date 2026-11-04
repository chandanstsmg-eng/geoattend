export const colors = {
  navy: '#1E2952',
  navyDark: '#151D3B',
  navySoft: '#E8EBF4',
  orange: '#EA580C',
  orangeDark: '#C2410C',
  orangeSoft: '#FFF1E8',
  white: '#FFFFFF',
  bg: '#F4F5F8',
  border: '#D9DCE3',
  text: '#1A1F2E',
  textMuted: '#5B6275',
  textFaint: '#8A90A0',
  success: '#15803D',
  successSoft: '#E7F6EC',
  warning: '#B45309',
  warningSoft: '#FEF5E3',
  danger: '#B91C1C',
  dangerSoft: '#FDECEC',
  info: '#1D4ED8',
  infoSoft: '#EAF0FD',
};

export type Tone = 'info' | 'warning' | 'success' | 'danger' | 'neutral';

export const toneColors: Record<Tone, { fg: string; bg: string; border: string }> = {
  info: { fg: colors.info, bg: colors.infoSoft, border: '#C3D3F7' },
  warning: { fg: colors.warning, bg: colors.warningSoft, border: '#F4D9A6' },
  success: { fg: colors.success, bg: colors.successSoft, border: '#B8E2C5' },
  danger: { fg: colors.danger, bg: colors.dangerSoft, border: '#F2C0C0' },
  neutral: { fg: colors.textMuted, bg: colors.white, border: colors.border },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 6, md: 10, lg: 14 };
export const font = { sm: 13, md: 15, lg: 17, xl: 20, xxl: 26 };
/** Minimum touch target (Android guideline 48dp). */
export const TOUCH = 52;
