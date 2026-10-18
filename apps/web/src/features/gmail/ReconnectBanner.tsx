import { AlertTriangle, Mail } from "lucide-react";

/**
 * Google ended InboxPilot's access (the sign-in expired or was revoked). Background checks have
 * stopped, so say so plainly and offer the one click that fixes it.
 */
export function ReconnectBanner({ timezone }: { timezone: string }) {
  return (
    <div
      role="alert"
      aria-labelledby="reconnect-title"
      className="flex flex-wrap items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm sm:p-4"
      data-testid="reconnect-banner"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p id="reconnect-title" className="font-medium">
          Your Gmail connection has expired, so new mail is not being checked.
        </p>
        <p className="text-muted-foreground">
          Google ends access after 7 days while the Google app is in Testing mode, or when access is
          removed in your Google account. Your tasks are safe. Reconnect to resume.
        </p>
      </div>
      <a
        href={`/api/auth/google?tz=${encodeURIComponent(timezone)}`}
        className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        <Mail className="size-3.5" aria-hidden="true" />
        Reconnect Gmail
      </a>
    </div>
  );
}
