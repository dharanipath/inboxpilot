import {
  Check,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  Settings,
  Sun,
  SunMoon,
} from "lucide-react";
import { useEffect } from "react";
import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";

import { isUnauthorized } from "@/api/client";
import { useLogout, useMe } from "@/api/hooks";
import type { User } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
} from "@/components/ui/primitives";
import { SyncProgressProvider, useSyncProgress } from "@/features/agent-runs/context";
import { SyncButton } from "@/features/agent-runs/SyncButton";
import { cn } from "@/lib/utils";
import { AgentBackdrop } from "@/features/backdrop/AgentBackdrop";
import { BACKDROPS } from "@/lib/backdrops";
import { applyPalette, PALETTES } from "@/lib/palettes";
import { applyTheme, type Theme, useUi } from "@/store/ui";

import { Logo } from "./Logo";
import { ProviderBadge } from "./ProviderBadge";

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/runs", label: "Agent runs", icon: ListChecks, end: false },
  { to: "/app/settings", label: "Settings", icon: Settings, end: false },
];

/** Signed-in layout. Unauthenticated visitors go back to the landing page. */
export function AppShell() {
  const me = useMe();
  if (me.isLoading) return <ShellSkeleton />;
  if (me.isError) {
    if (isUnauthorized(me.error)) return <Navigate to="/" replace />;
    return (
      <div role="alert" className="container py-16 text-center">
        <p className="font-medium">We couldn't reach InboxPilot.</p>
        <p className="text-sm text-muted-foreground">Check that the API is running, then reload.</p>
      </div>
    );
  }
  if (!me.data) return <Navigate to="/" replace />;
  return (
    <SyncProgressProvider>
      <AgentBackdrop />
      <Header user={me.data} />
      <main id="main" className="container pb-16 pt-6">
        <Outlet context={me.data} />
      </main>
    </SyncProgressProvider>
  );
}

function Header({ user }: { user: User }) {
  const progress = useSyncProgress();
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <div className="container flex h-14 items-center gap-3">
        <Link
          to="/app"
          className="flex items-center gap-2 font-semibold"
          aria-label="InboxPilot home"
          title="InboxPilot: go to the dashboard"
        >
          <Logo />
          <span className="hidden sm:inline">InboxPilot</span>
        </Link>
        <nav aria-label="Main" className="ml-4 hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                  isActive && "bg-secondary text-foreground",
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ProviderBadge />
          <SyncButton running={progress.phase === "running"} />
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Account menu">
                <span
                  className="hidden size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground md:flex"
                  aria-hidden="true"
                >
                  {(user.name ?? user.email).slice(0, 1).toUpperCase()}
                </span>
                <Menu className="md:hidden" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-60">
              <DropdownMenuLabel className="truncate">
                {user.name ?? "Signed in"}
                <span className="block truncate font-normal">{user.email}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {NAV.map((n) => (
                <DropdownMenuItem key={n.to} onSelect={() => navigate(n.to)}>
                  <n.icon /> {n.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => logout.mutate(undefined, { onSettled: () => navigate("/") })}
              >
                <LogOut /> Sign out
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => logout.mutate({ forget: true }, { onSettled: () => navigate("/") })}
              >
                <LogOut /> Sign out and forget this browser
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: SunMoon },
];

/** Three small dots showing a palette's background, primary and accent. */
export function PaletteSwatch({ colors }: { colors: [string, string, string] }) {
  return (
    <span className="inline-flex -space-x-1" aria-hidden="true">
      {colors.map((c) => (
        <span
          key={c}
          className="size-3 rounded-full border border-black/10"
          style={{ background: c }}
        />
      ))}
    </span>
  );
}

export function ThemeToggle() {
  const { theme, setTheme, palette, setPalette, backdrop, setBackdrop } = useUi();
  useEffect(() => applyPalette(palette), [palette]);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);
  const Current = THEMES.find((t) => t.value === theme)?.icon ?? SunMoon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Theme: ${theme}, ${PALETTES.find((p) => p.id === palette)?.label ?? palette}`}
        >
          <Current aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {THEMES.map((t) => (
          <DropdownMenuItem
            key={t.value}
            onSelect={() => setTheme(t.value)}
            aria-current={theme === t.value}
          >
            <t.icon /> {t.label}
            {theme === t.value ? <Check className="ml-auto" aria-label="selected" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Live background</DropdownMenuLabel>
        {BACKDROPS.map((b) => (
          <DropdownMenuItem
            key={b.id}
            onSelect={() => setBackdrop(b.id)}
            aria-current={backdrop === b.id}
            title={b.description}
          >
            {b.label}
            {backdrop === b.id ? <Check className="ml-auto" aria-label="selected" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Colour theme</DropdownMenuLabel>
        {PALETTES.map((p) => (
          <DropdownMenuItem
            key={p.id}
            onSelect={() => setPalette(p.id)}
            aria-current={palette === p.id}
          >
            <PaletteSwatch colors={p.swatch} /> {p.label}
            {palette === p.id ? <Check className="ml-auto" aria-label="selected" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ShellSkeleton() {
  return (
    <div className="container space-y-4 py-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-28" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    </div>
  );
}
