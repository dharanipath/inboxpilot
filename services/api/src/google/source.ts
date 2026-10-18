import type { EmailInput } from "../agent/types.js";
import type { ListOptions, ListResult, MailSource, MailUser } from "../mail/source.js";
import { type GmailClient, type GmailOptions, HistoryExpired } from "./gmail.js";
import { gmailToEmail } from "./mime.js";

const SKIP_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "SPAM", "TRASH", "DRAFT"];

export function listQuery(days: number): string {
  // promotions/social never leave Google; triage in the agent handles the rest
  return `newer_than:${days}d in:inbox -category:promotions -category:social`;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Gmail as a MailSource. First sync (or after `reprocess`, or an expired history id): list the
 * last N days. Later syncs: only messages added since the stored historyId. The checkpoint is
 * read BEFORE listing, so mail arriving mid-sync is picked up next time, never skipped.
 */
export class GmailMailSource implements MailSource {
  constructor(
    private readonly clientFor: (user: MailUser) => GmailClient,
    private readonly concurrency = 5,
  ) {}

  async listRecent(user: MailUser, opts: ListOptions): Promise<ListResult> {
    const gmail = this.clientFor(user);
    const { historyId } = await gmail.profile();

    let ids: string[] | null = null;
    let mode: ListResult["mode"] = "full";
    if (opts.since) {
      try {
        ids = await gmail.addedSince(opts.since, opts.max);
        mode = "incremental";
      } catch (err) {
        if (!(err instanceof HistoryExpired)) throw err;
      }
    }
    ids ??= await gmail.listMessageIds(listQuery(opts.days), opts.max);

    const messages = await pool(ids, this.concurrency, (id) => gmail.message(id));
    const emails: EmailInput[] = messages
      .filter((m) => !(m.labelIds ?? []).some((l) => SKIP_LABELS.includes(l)))
      .map(gmailToEmail);
    return { emails, checkpoint: historyId, mode };
  }
}

export type { GmailOptions };
