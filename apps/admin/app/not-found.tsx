import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto mt-24 max-w-md px-4 text-center">
      <p className="text-sm font-medium text-gray-500">Page not found</p>
      <h1 className="mt-1 text-xl font-semibold text-navy-900">That address does not exist</h1>
      <p className="mt-2 text-sm text-gray-500">The link may be old, or the record may have been removed.</p>
      <Link href="/" className="mt-5 inline-flex h-9.5 items-center rounded-md border border-gray-300 bg-white px-3.5 text-sm font-medium text-gray-800 hover:bg-gray-50">Go to the overview</Link>
    </main>
  );
}
