// Force dynamic rendering for all dashboard pages
// These pages use real-time Supabase data that changes frequently
export const dynamic = "force-dynamic";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
