// Force dynamic rendering for all dashboard pages
// These pages use real-time Supabase data that changes frequently
export const dynamic = "force-dynamic";

import { Sidebar } from "@/components/dashboard/sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 ml-64 p-6">
        {children}
      </main>
    </div>
  );
}
