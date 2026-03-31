"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import { ClipboardCheck, FileText, LayoutDashboard, Shield } from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const navItems: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/review", label: "校对工作台", icon: ClipboardCheck },
  { href: "/summary", label: "家庭保障全景", icon: Shield },
  { href: "/report", label: "报告预览", icon: FileText },
];

function isActivePath(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function getTitle(pathname: string) {
  const matched = navItems.find((item) => isActivePath(pathname, item.href));
  return matched?.label ?? "IPIS";
}

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const title = getTitle(pathname);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="flex min-h-screen w-full">
        <aside className="hidden w-64 shrink-0 border-r border-zinc-200 bg-white md:flex md:flex-col">
          <div className="flex h-14 items-center px-4 text-sm font-semibold">
            IPIS
          </div>
          <nav className="flex flex-col gap-1 px-2 py-2">
            {navItems.map((item) => {
              const active = isActivePath(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-zinc-100 text-zinc-950"
                      : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950",
                  ].join(" ")}
                >
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-12 items-center border-b border-zinc-200 bg-white/90 px-4 backdrop-blur md:hidden">
            <div className="text-sm font-medium">{title}</div>
          </header>

          <main className="flex-1 px-4 py-4 pb-20 md:px-8 md:py-6 md:pb-8">
            <div className="mx-auto w-full max-w-5xl">{children}</div>
          </main>
        </div>
      </div>

      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-zinc-200 bg-white md:hidden">
        <div className="mx-auto grid max-w-lg grid-cols-4 gap-1 px-2 py-2">
          {navItems.map((item) => {
            const active = isActivePath(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "flex flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-xs transition-colors",
                  active
                    ? "bg-zinc-100 text-zinc-950"
                    : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950",
                ].join(" ")}
              >
                <Icon className="h-5 w-5" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
