import { inr, PAY_TYPE_LABEL } from './pay-form';

const KIND = { ADVANCE: 'Advance recovered', BONUS: 'Bonus', ALLOWANCE: 'Allowance', DEDUCTION: 'Deduction' } as const;
const monthName = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

/** A printable payslip from the snapshot frozen when the month was approved. */
export function PayslipView({ slip }: { slip: any }) {
  const { employee: e, pay, attendance: a, result: r, adjustments = [] } = slip;
  const earnings: Array<[string, number]> = [
    [`Basic (${inr(pay.amount)} ${PAY_TYPE_LABEL[pay.payType as keyof typeof PAY_TYPE_LABEL]})`, r.basic],
    ...(r.overtimePay ? ([[`Overtime (${r.overtimeHours} h × ${pay.otMultiplier})`, r.overtimePay]] as Array<[string, number]>) : []),
    ...adjustments.filter((x: any) => x.kind === 'BONUS' || x.kind === 'ALLOWANCE').map((x: any) => [`${KIND[x.kind as keyof typeof KIND]}${x.note ? ` — ${x.note}` : ''}`, x.amount] as [string, number]),
  ];
  const deductions: Array<[string, number]> = [
    ...(r.lossOfPay ? ([[`Loss of pay (${r.lossOfPayDays} day${r.lossOfPayDays === 1 ? '' : 's'})`, r.lossOfPay]] as Array<[string, number]>) : []),
    ...adjustments.filter((x: any) => x.kind === 'ADVANCE' || x.kind === 'DEDUCTION').map((x: any) => [`${KIND[x.kind as keyof typeof KIND]}${x.note ? ` — ${x.note}` : ''}`, x.amount] as [string, number]),
  ];
  const sum = (l: Array<[string, number]>) => l.reduce((n, [, v]) => n + v, 0);

  return (
    <article className="mx-auto max-w-2xl rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-800 shadow-sm print:border-0 print:shadow-none sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-gray-200 pb-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900">{slip.companyName}</h1>
          <p className="text-gray-600">Payslip for {monthName(slip.month)}</p>
        </div>
        <p className="text-right text-xs text-gray-500">
          {slip.status === 'PAID' ? 'Paid' : 'Approved'}
          {slip.approvedAt ? ` · ${slip.approvedAt}` : ''}
        </p>
      </header>

      <section className="grid gap-x-6 gap-y-1 border-b border-gray-200 py-4 sm:grid-cols-2">
        <p><span className="text-gray-500">Employee:</span> <strong>{e.fullName}</strong></p>
        <p><span className="text-gray-500">Employee ID:</span> {e.employeeCode}</p>
        {e.designation && <p><span className="text-gray-500">Designation:</span> {e.designation}</p>}
        {e.department && <p><span className="text-gray-500">Department:</span> {e.department}</p>}
      </section>

      <section className="grid grid-cols-3 gap-2 border-b border-gray-200 py-4 text-center sm:grid-cols-6">
        {[
          ['Days in month', a.daysInMonth],
          ['Present', a.present],
          ['Paid leave', a.paidLeave],
          ['Unpaid leave', a.unpaidLeave],
          ['Holidays', a.holidays],
          ['Absent', a.absent],
        ].map(([l, v]) => (
          <div key={l as string}>
            <p className="text-lg font-semibold tabular text-gray-900">{v as number}</p>
            <p className="text-caption text-gray-500">{l}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-6 py-4 sm:grid-cols-2">
        {[['Earnings', earnings], ['Deductions', deductions]].map(([title, lines]) => (
          <div key={title as string}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title as string}</h2>
            <table className="w-full">
              <tbody>
                {(lines as Array<[string, number]>).length === 0 && <tr><td className="py-1 text-gray-500">None</td></tr>}
                {(lines as Array<[string, number]>).map(([l, v]) => (
                  <tr key={l}><td className="py-1 pr-2">{l}</td><td className="py-1 text-right tabular">{inr(v)}</td></tr>
                ))}
                <tr className="border-t border-gray-200 font-semibold"><td className="py-1">Total</td><td className="py-1 text-right tabular">{inr(sum(lines as Array<[string, number]>))}</td></tr>
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <footer className="flex items-center justify-between rounded-md bg-navy-50 px-4 py-3">
        <span className="font-semibold text-gray-900">Net pay</span>
        <span className="text-xl font-bold tabular text-gray-900">{inr(r.net)}</span>
      </footer>
      {r.carryForward > 0 && <p className="mt-2 text-xs text-amber-700">{inr(r.carryForward)} of the advance is still to be recovered next month.</p>}
      <p className="mt-4 text-caption text-gray-500">Hours worked {(a.workedMinutes / 60).toFixed(1)} · overtime {(a.overtimeMinutes / 60).toFixed(1)} h · late {a.late ?? 0} · computer-generated from GeoAttend attendance records.</p>
    </article>
  );
}
