import type { EmailInput } from "../agent/types.js";

export interface MailUser {
  id: string;
  email: string;
  timezone: string;
  authMode: string;
}

export interface ListOptions {
  days: number;
  max: number;
  now: Date;
  /** Incremental-sync checkpoint from the last successful run (null = full listing). */
  since?: string | null;
}

export interface ListResult {
  emails: EmailInput[];
  /** Saved after a successful run and passed back as `since` next time. */
  checkpoint?: string | null;
  mode: "full" | "incremental";
}

/** Where emails come from (Gmail in the app; a fixture inbox in tests). */
export interface MailSource {
  listRecent(user: MailUser, opts: ListOptions): Promise<ListResult>;
}
