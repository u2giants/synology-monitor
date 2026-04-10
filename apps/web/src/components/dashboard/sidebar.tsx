"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Activity,
  HardDrive,
  ScrollText,
  FolderSync,
  Shield,
  Container,
  Brain,
  Bot,
  Settings,
} from "lucide-react";

const navItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/metrics", label: "Metrics", icon: Activity },
  { href: "/storage", label: "Storage", icon: HardDrive },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/sync-triage", label: "Sync Triage", icon: FolderSync },
  { href: "/security", label: "Security", icon: Shield },
  { href: "/docker", label: "Docker", icon: Container },
  { href: "/ai-insights", label: "Issue Insights", icon: Brain },
  { href: "/assistant", label: "Issue Agent", icon: Bot },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 z-50 flex h-screen w-64 flex-col border-r border-border bg-card">
      <div className="flex h-16 items-center gap-2 border-b border-border px-6">
        <HardDrive className="h-6 w-6 text-primary" />
        <span className="text-lg font-semibold">NAS Monitor</span>
      </div>

      <nav className="flex-1 space-y-1 p-4">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href));

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
