import { LogOut, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";

import { useDeleteAccount, useLogout } from "@/api/hooks";
import type { User } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  Input,
} from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { BACKDROPS } from "@/lib/backdrops";
import { cn } from "@/lib/utils";
import { type Theme, useUi } from "@/store/ui";

export function SettingsPage() {
  const user = useOutletContext<User>();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Profile, appearance and account.</p>
      </div>

      <ProfileCard user={user} />
      <AppearanceCard />
      <SignOutCard />
      <DangerZone isGoogle={user.auth_mode === "google"} />
    </div>
  );
}

function AppearanceCard() {
  const { theme, setTheme, backdrop, setBackdrop } = useUi();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset className="flex gap-2">
          <legend className="mb-2 text-sm font-medium">Mode</legend>
          {(["system", "light", "dark"] as Theme[]).map((t) => (
            <label
              key={t}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm capitalize has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                theme === t && "border-primary bg-accent",
              )}
            >
              <input
                type="radio"
                name="theme"
                value={t}
                checked={theme === t}
                onChange={() => setTheme(t)}
                className="sr-only"
              />
              {t}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Live background</legend>
          <p className="text-xs text-muted-foreground">
            Reacts to the agent in real time: calm while it waits, busier while it reads your mail.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {BACKDROPS.map((b) => (
              <label
                key={b.id}
                className={cn(
                  "flex cursor-pointer flex-col rounded-md border p-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                  backdrop === b.id && "border-primary bg-accent",
                )}
              >
                <input
                  type="radio"
                  name="backdrop"
                  value={b.id}
                  checked={backdrop === b.id}
                  onChange={() => setBackdrop(b.id)}
                  className="sr-only"
                />
                <span className="font-medium">
                  {b.label}
                  {backdrop === b.id ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      (current)
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">{b.description}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </CardContent>
    </Card>
  );
}

/** Who is signed in, and how InboxPilot is connected to their mail. */
function ProfileCard({ user }: { user: User }) {
  const initials =
    (user.name ?? user.email)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?";
  const since = new Date(user.created_at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return (
    <Card id="profile">
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-start gap-4">
        <span
          aria-hidden="true"
          className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-base font-semibold text-primary-foreground"
        >
          {initials}
        </span>
        <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="truncate font-medium">{user.name ?? "—"}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd className="truncate">{user.email}</dd>
          <dt className="text-muted-foreground">Gmail</dt>
          <dd>
            {user.gmail_connected === false
              ? "Disconnected: reconnect from the dashboard"
              : "Connected with Google (read-only)"}
          </dd>
          <dt className="text-muted-foreground">Timezone</dt>
          <dd>{user.timezone}</dd>
          <dt className="text-muted-foreground">Member since</dt>
          <dd>{since}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Sign out here, or also forget this browser (removes one-click "Continue as …"). */
function SignOutCard() {
  const logout = useLogout();
  const navigate = useNavigate();
  const out = (forget: boolean) =>
    logout.mutate(forget ? { forget: true } : undefined, {
      onSettled: () => navigate("/", { replace: true }),
    });
  return (
    <Card id="sign-out">
      <CardHeader>
        <CardTitle>Sign out</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Signing out keeps one-click &ldquo;Continue as …&rdquo; on this browser. On a shared
          computer, also forget this browser.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => out(false)} disabled={logout.isPending}>
            <LogOut aria-hidden="true" /> Sign out
          </Button>
          <Button variant="outline" onClick={() => out(true)} disabled={logout.isPending}>
            <LogOut aria-hidden="true" /> Sign out and forget this browser
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DangerZone({ isGoogle }: { isGoogle: boolean }) {
  const [confirm, setConfirm] = useState("");
  const del = useDeleteAccount();
  const navigate = useNavigate();
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Disconnect and delete data</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-sm text-muted-foreground">
          {isGoogle
            ? "Revokes InboxPilot's Google access and permanently deletes"
            : "Permanently deletes"}{" "}
          your tasks, email metadata and sync history. This can't be undone.
        </p>
        <Dialog onOpenChange={() => setConfirm("")}>
          <DialogTrigger asChild>
            <Button variant="destructive">
              <Trash2 aria-hidden="true" /> Delete my data
            </Button>
          </DialogTrigger>
          <DialogContent
            title="Delete all your data?"
            description="Type DELETE to confirm. You will be signed out."
          >
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                del.mutate(undefined, {
                  onSuccess: () => navigate("/", { replace: true }),
                  onError: () => toast({ title: "Couldn't delete your data", tone: "error" }),
                });
              }}
            >
              <label htmlFor="confirm-delete" className="sr-only">
                Type DELETE to confirm
              </label>
              <Input
                id="confirm-delete"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                placeholder="DELETE"
              />
              <div className="flex justify-end gap-2">
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={confirm !== "DELETE" || del.isPending}
                >
                  Delete permanently
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
