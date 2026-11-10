'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { get } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useMe } from '@/lib/me';
import { Button, EmptyState, PageHeader, QueryState } from '@/components/ui';
import { PayslipView } from '@/components/payslip-view';

export default function PayslipPage() {
  const { id } = useParams<{ id: string }>();
  const { me, query } = useMe();
  const enabled = !!me?.features?.payroll;
  // While payroll is off the payslip is not even requested (the API refuses it too): same notice as /payroll.
  const slip = useQuery({ queryKey: ['payslip', id], queryFn: () => get(`/payroll/payslips/${id}`), enabled });
  if (query.isPending) return null;
  if (!enabled) {
    return (
      <>
        <PageHeader title="Payslip" />
        <EmptyState title="Payroll is not part of this release">Attendance, working hours and overtime are in Reports. Payroll records already saved are kept.</EmptyState>
      </>
    );
  }
  return (
    <>
      <div className="mb-4 flex items-center gap-2 print:hidden">
        <Link href="/payroll" className="inline-flex items-center gap-1 text-sm text-primary-700 hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Payroll
        </Link>
        <Button className="ml-auto" variant="primary" onClick={() => window.print()}>
          <Printer className="h-4 w-4" aria-hidden /> Print / save as PDF
        </Button>
      </div>
      <QueryState query={slip}>{(p: any) => <PayslipView slip={{ ...p.data, companyName: p.company_name, status: p.run_status, approvedAt: fmtDate(p.approved_at?.slice(0, 10)) }} />}</QueryState>
    </>
  );
}
