/** Indian-style rupee amounts: ₹1,23,456. */
export function inr(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—';
  const neg = n < 0;
  const [whole, frac] = Math.abs(Math.round(n * 100) / 100).toFixed(2).split('.');
  const last3 = whole!.slice(-3);
  const rest = whole!.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '−' : ''}₹${rest ? `${rest},${last3}` : last3}${frac === '00' ? '' : `.${frac}`}`;
}

export const monthName = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y!, mo! - 1, 15).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};

export const ADJUSTMENT_LABEL = { ADVANCE: 'Advance recovered', BONUS: 'Bonus', ALLOWANCE: 'Allowance', DEDUCTION: 'Deduction' } as const;
