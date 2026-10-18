import {
  CalendarCheck,
  Eye,
  Loader2,
  Lock,
  Mail,
  Quote,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { ApiError } from "@/api/client";
import { useForgetBrowser, useMe, useRemembered, useResume } from "@/api/hooks";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import type { RememberedAccount } from "@/api/types";
import { browserTimeZone } from "@/lib/utils";

export const AUTH_ERRORS: Record<string, string> = {
  access_denied: "You cancelled the Google sign-in. Nothing was connected.",
  insufficient_scope:
    "Read-only Gmail access wasn't granted, so InboxPilot can't read your inbox. Please allow it to continue.",
  email_not_verified: "Your Google account email isn't verified.",
  invalid_state: "That sign-in link expired or was already used. Please start again.",
  no_refresh_token: "Google didn't return long-lived access. Please try connecting again.",
  oauth_failed: "Google sign-in failed. Please try again.",
  account_conflict: "This email is already used by another account.",
};

export function LandingPage() {
  const me = useMe();
  const remembered = useRemembered();
  const [params] = useSearchParams();
  if (me.data) return <Navigate to="/app" replace />;

  const authError = params.get("auth_error");
  const tz = browserTimeZone();
  const googleUrl = `/api/auth/google?tz=${encodeURIComponent(tz)}`;
  const account = remembered.data;

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,hsl(var(--accent))_0%,transparent_60%)]">
      <header className="container flex h-16 items-center gap-2 font-semibold">
        <Logo /> InboxPilot
      </header>
      <main className="container grid gap-12 pb-20 pt-8 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:pt-16">
        <section className="space-y-6">
          {authError ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {AUTH_ERRORS[authError] ?? "Sign-in failed. Please try again."}
            </p>
          ) : null}
          <p className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <Sparkles className="size-3.5 text-primary" aria-hidden="true" /> AI agent for your
            inbox
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Your inbox, as a <span className="text-primary">to-do list</span>.
          </h1>
          <p className="max-w-xl text-lg text-muted-foreground">
            InboxPilot reads the last two weeks of mail and tells you what you need to do today and
            this week, with due dates, priorities, and the exact sentence each task came from.
          </p>
          {account ? (
            <WelcomeBack account={account} googleUrl={googleUrl} />
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button size="lg" asChild>
                <a href={googleUrl}>
                  <Mail aria-hidden="true" /> Connect Gmail
                </a>
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Sign in with Google and allow read-only Gmail access. InboxPilot then checks your inbox
            automatically every few minutes.
          </p>
        </section>

        <section
          aria-label="How your data is handled"
          className="space-y-3 rounded-xl border bg-card/80 p-5 shadow-sm"
        >
          <h2 className="font-semibold">Read-only, and private by design</h2>
          <ul className="space-y-3 text-sm">
            <Point icon={<Eye />} title="Read-only Gmail access">
              We request <code className="rounded bg-secondary px-1 text-xs">gmail.readonly</code>{" "}
              only. InboxPilot can never send, delete or change mail.
            </Point>
            <Point icon={<Lock />} title="Email bodies are never stored">
              Message text lives in memory for at most an hour while it's processed. Only tasks and
              email metadata are kept.
            </Point>
            <Point icon={<ShieldCheck />} title="Sensitive numbers are redacted">
              Phone, card, account, Aadhaar and PAN numbers are removed before any AI model sees the
              text.
            </Point>
            <Point icon={<Quote />} title="Every task shows its evidence">
              Each task links to the sentence it came from, and to the reasons for its priority.
            </Point>
            <Point icon={<Trash2 />} title="Delete everything, any time">
              Disconnecting revokes Google access and deletes all of your data.
            </Point>
          </ul>
          <p className="flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
            <CalendarCheck className="size-4" aria-hidden="true" /> Dates use your timezone: {tz}
          </p>
        </section>
      </main>
    </div>
  );
}

function Point({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 text-primary [&_svg]:size-4" aria-hidden="true">
        {icon}
      </span>
      <span>
        <span className="block font-medium">{title}</span>
        <span className="text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

/**
 * A browser that signed in before: one click back in, with no Google screens. Gmail access is
 * already held on the server; this only confirms it is the same browser.
 */
function WelcomeBack({ account, googleUrl }: { account: RememberedAccount; googleUrl: string }) {
  const resume = useResume();
  const forget = useForgetBrowser();
  const navigate = useNavigate();
  const who = account.name ?? account.email;

  const go = () =>
    resume.mutate(undefined, {
      onSuccess: () => navigate("/app", { replace: true }),
      onError: (err) => {
        // access ended (409) or this browser is no longer remembered (401): use Google
        if (err instanceof ApiError && (err.status === 409 || err.status === 401)) {
          window.location.assign(googleUrl);
        }
      },
    });

  return (
    <div
      className="space-y-3 rounded-xl border bg-card/80 p-4 shadow-sm"
      data-testid="welcome-back"
    >
      <p className="text-sm text-muted-foreground">Welcome back</p>
      {account.gmail_connected ? (
        <Button size="lg" onClick={go} disabled={resume.isPending} className="w-full sm:w-auto">
          {resume.isPending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Mail aria-hidden="true" />
          )}
          <span className="truncate">Continue as {who}</span>
        </Button>
      ) : (
        <Button size="lg" asChild className="w-full sm:w-auto">
          <a href={googleUrl}>
            <Mail aria-hidden="true" />
            <span className="truncate">Reconnect Gmail as {who}</span>
          </a>
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        {account.email}
        {account.gmail_connected
          ? " · Gmail stays connected, so no Google screens."
          : " · Google ended access, so it will ask once to reconnect."}
      </p>
      {resume.isError &&
      !(resume.error instanceof ApiError && [401, 409].includes(resume.error.status)) ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn't sign you in. Please try again.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <a href={googleUrl} className="font-medium text-primary underline-offset-2 hover:underline">
          Use another Google account
        </a>
        <button
          type="button"
          onClick={() => forget.mutate()}
          className="font-medium text-muted-foreground underline-offset-2 hover:underline"
        >
          Not you? Forget this browser
        </button>
      </div>
    </div>
  );
}
