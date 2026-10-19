import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { keys, RUNS_POLL_MS } from "@/api/hooks";
import type { SyncRun, Task } from "@/api/types";
import { summarizeProviders } from "@/components/ProviderBadge";
import { groupByLocalDate, outcomeLabel } from "@/features/emails/RecentMail";
import { FakeEventSource } from "@/test/setup";
import {
  emailPage,
  finishedRun,
  http,
  HttpResponse,
  makeEmail,
  makeTask,
  page,
  providers,
  server,
  user,
} from "@/test/server";
import { renderApp } from "@/test/render";
import { useUi } from "@/store/ui";

import { autoSyncNote } from "./DashboardPage";

describe("dashboard", () => {
  it("loads tasks, briefing and KPIs; marking done is instant, and Undo reopens", async () => {
    const deck = makeTask({ title: "Send the deck", priority: "P1" });
    const invoice = makeTask({
      title: "Pay invoice",
      bucket: "overdue",
      due_date: "2026-10-14",
      priority: "P0",
    });
    let open = [deck, invoice];
    const patches: unknown[] = [];
    server.use(
      http.get("/api/tasks", ({ request }) =>
        HttpResponse.json(
          page(new URL(request.url).searchParams.get("status") !== "open" ? [] : open),
        ),
      ),
      http.patch("/api/tasks/:id", async ({ request, params }) => {
        const body = (await request.json()) as { status?: string };
        patches.push({ id: params.id, ...body });
        open = body.status === "open" ? [deck, invoice] : open.filter((t) => t.id !== params.id);
        return HttpResponse.json({ ...deck, status: body.status ?? "open" });
      }),
    );
    const userEv = userEvent.setup();
    renderApp("/app");

    expect(await screen.findByText("2 things today, 1 overdue")).toBeInTheDocument();
    expect(await screen.findByRole("listitem", { name: "Send the deck" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/, Sam$/);
    expect(screen.getByTestId("kpi-overdue")).toHaveTextContent("1");
    expect(screen.getByTestId("kpi-today")).toHaveTextContent("1");

    await userEv.click(screen.getByRole("button", { name: 'Mark "Send the deck" as done' }));
    await waitFor(() =>
      expect(screen.queryByRole("listitem", { name: "Send the deck" })).not.toBeInTheDocument(),
    );
    expect(patches).toEqual([{ id: deck.id, status: "done" }]);
    const toast = await screen.findByText("Marked done");
    await userEv.click(
      within(toast.closest("div")?.parentElement as HTMLElement).getByRole("button", {
        name: "Undo",
      }),
    );
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ id: deck.id, status: "open" });
    expect(await screen.findByRole("listitem", { name: "Send the deck" })).toBeInTheDocument();
  });

  it("done, snoozed or dismissed by mistake: Reopen any time from the closed list", async () => {
    const deck = makeTask({ title: "Send the deck", priority: "P1" });
    const room = makeTask({ title: "Book a room", priority: "P2" });
    const memo = makeTask({ title: "Read the memo", priority: "P3" });
    const state = new Map<string, Task>([deck, room, memo].map((t) => [t.id, t]));
    const patches: unknown[] = [];
    server.use(
      http.get("/api/tasks", ({ request }) => {
        const status = new URL(request.url).searchParams.get("status");
        const tasks = [...state.values()];
        if (status === "open")
          return HttpResponse.json(page(tasks.filter((t) => t.status === "open")));
        if (status === "closed")
          return HttpResponse.json(page(tasks.filter((t) => t.status !== "open")));
        return HttpResponse.json(page(tasks.filter((t) => t.status === status)));
      }),
      http.patch("/api/tasks/:id", async ({ request, params }) => {
        const body = (await request.json()) as { status?: Task["status"]; snoozed_until?: string };
        patches.push({ id: params.id, ...body });
        const t = state.get(String(params.id))!;
        const next: Task = body.snoozed_until
          ? {
              ...t,
              status: "snoozed",
              snoozed_until: body.snoozed_until,
              updated_at: new Date().toISOString(),
            }
          : {
              ...t,
              status: body.status ?? t.status,
              snoozed_until: null,
              updated_at: new Date().toISOString(),
            };
        state.set(t.id, next);
        return HttpResponse.json(next);
      }),
    );
    const u = userEvent.setup();
    renderApp("/app");
    const upcoming = await screen.findByRole("tabpanel", { name: "Upcoming" });
    await within(upcoming).findByRole("listitem", { name: "Send the deck" });
    expect(
      screen.queryByRole("heading", { name: /Done, snoozed & dismissed/ }),
    ).not.toBeInTheDocument();

    // done, dismissed and snoozed by mistake
    await u.click(screen.getByRole("button", { name: 'Mark "Send the deck" as done' }));
    await u.click(screen.getByRole("button", { name: 'More actions for "Book a room"' }));
    await u.click(await screen.findByRole("menuitem", { name: /dismiss/ }));
    await u.click(screen.getByRole("button", { name: 'More actions for "Read the memo"' }));
    await u.click(
      (
        await screen.findAllByRole("menuitem", { name: /Tomorrow morning|Later today|Next week/ })
      )[0]!,
    );

    const closed = await screen.findByRole("region", { name: /Done, snoozed & dismissed/ });
    await within(closed).findByRole("listitem", { name: "Read the memo" });
    expect(within(closed).getByRole("listitem", { name: "Send the deck" })).toHaveTextContent(
      "Done",
    );
    expect(within(closed).getByRole("listitem", { name: "Book a room" })).toHaveTextContent(
      "Dismissed",
    );
    expect(within(closed).getByRole("listitem", { name: "Read the memo" })).toHaveTextContent(
      /Snoozed until/,
    );

    // Reopen restores each one to the list
    for (const t of [deck, room, memo]) {
      await u.click(within(closed).getByRole("button", { name: `Reopen "${t.title}"` }));
    }
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: /Done, snoozed & dismissed/ }),
      ).not.toBeInTheDocument(),
    );
    for (const t of [deck, room, memo]) {
      expect(await within(upcoming).findByRole("listitem", { name: t.title })).toBeInTheDocument();
      expect(state.get(t.id)).toMatchObject({ status: "open", snoozed_until: null });
    }
    expect(patches.slice(-3)).toEqual(
      [deck, room, memo].map((t) => ({ id: t.id, status: "open" })),
    );
  });

  it("restores the task if the server rejects the change", async () => {
    const deck = makeTask({ title: "Send the deck" });
    server.use(
      http.get("/api/tasks", ({ request }) =>
        HttpResponse.json(
          page(new URL(request.url).searchParams.get("status") === "open" ? [deck] : []),
        ),
      ),
      http.patch("/api/tasks/:id", () =>
        HttpResponse.json({ title: "Internal error" }, { status: 500 }),
      ),
    );
    const u = userEvent.setup();
    renderApp("/app");
    await u.click(await screen.findByRole("button", { name: 'Mark "Send the deck" as done' }));
    expect(await screen.findByText("Couldn't update the task")).toBeInTheDocument();
    expect(await screen.findByRole("listitem", { name: "Send the deck" })).toBeInTheDocument();
  });

  it("starts a sync and animates the agent run from SSE, including a model fallback", async () => {
    let posted = 0;
    server.use(
      http.post("/api/sync", () => {
        posted += 1;
        return HttpResponse.json({ jobId: finishedRun.id }, { status: 202 });
      }),
      http.get(`/api/sync/${finishedRun.id}`, () => HttpResponse.json(finishedRun)),
    );
    const u = userEvent.setup();
    renderApp("/app");
    await u.click(await screen.findByRole("button", { name: "Sync inbox" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("no EventSource");
    expect(es.url).toBe(`/api/sync/${finishedRun.id}/events`);
    expect(posted).toBe(1);

    act(() => {
      es.emit("queued", { seq: 1, type: "queued", at: "" });
      es.emit("fetching", { seq: 2, type: "fetching", at: "", data: { days: 14 } });
      es.emit("triage", {
        seq: 3,
        type: "triage",
        at: "",
        data: { fetched: 28, new: 28, already_processed: 0 },
      });
      es.emit("extracting", { seq: 4, type: "extracting", at: "", data: { done: 12, total: 28 } });
    });
    expect(await screen.findByRole("button", { name: "Syncing your inbox" })).toBeDisabled();
    expect(screen.getByRole("progressbar", { name: "Emails sent to the agent" })).toHaveAttribute(
      "aria-valuenow",
      "12",
    );

    act(() => {
      es.emit("provider_switch", {
        seq: 5,
        type: "provider_switch",
        at: "",
        data: { detail: "gemini rate-limited → groq" },
      });
      es.emit("saving", { seq: 6, type: "saving", at: "", data: { tasks: 22 } });
      es.emit("done", { seq: 7, type: "done", at: "", data: { tasks_written: 22 } });
    });
    expect(es.closed).toBe(true);
    expect(
      await screen.findByText(/gemini rate-limited → groq/, { selector: "span" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("2140 ms")).toBeInTheDocument(); // exact durations from the stored trace
    expect(screen.getByRole("button", { name: "Sync inbox" })).toBeEnabled();
  });

  it("ignores the browser's native EventSource error event", async () => {
    server.use(
      http.post("/api/sync", () => HttpResponse.json({ jobId: finishedRun.id }, { status: 202 })),
    );
    const u = userEvent.setup();
    renderApp("/app");
    await u.click(await screen.findByRole("button", { name: "Sync inbox" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0];
    act(() => {
      for (const fn of es?.listeners.get("error") ?? []) fn(new Event("error")); // network blip, no data
    });
    expect(es?.closed).toBe(false);
  });

  it("follows the running sync on 409 instead of failing", async () => {
    server.use(
      http.post("/api/sync", () =>
        HttpResponse.json(
          { title: "Sync already running", jobId: finishedRun.id },
          { status: 409 },
        ),
      ),
    );
    const u = userEvent.setup();
    renderApp("/app");
    await u.click(await screen.findByRole("button", { name: "Sync inbox" }));
    expect(await screen.findByText("A sync is already running")).toBeInTheDocument();
    expect(useUi.getState().activeRunId).toBe(finishedRun.id);
    useUi.getState().setActiveRun(null);
  });

  it("asks a question and shows the cited tasks", async () => {
    const deck = makeTask({ title: "Send the deck", priority: "P1" });
    server.use(
      http.post("/api/ask", () =>
        HttpResponse.json({
          answer: "Send Priya the deck today.",
          generated_by: "rules",
          cited_task_ids: [deck.id],
          tasks: [deck],
        }),
      ),
    );
    const u = userEvent.setup();
    renderApp("/app");
    await u.type(await screen.findByLabelText("Question"), "What do I owe Priya?");
    await u.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Send Priya the deck today.")).toBeInTheDocument();
    const cited = screen.getByRole("list", { name: "Tasks cited in the answer" });
    expect(within(cited).getByText("Send the deck")).toBeInTheDocument();
    expect(screen.getByText(/Answered by rules \(no LLM\)/)).toBeInTheDocument();
  });

  it("sends signed-out visitors to the landing page", async () => {
    server.use(
      http.get("/api/me", () => HttpResponse.json({ title: "Unauthorized" }, { status: 401 })),
    );
    const { router } = renderApp("/app");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(
      await screen.findByRole("heading", { name: /Your inbox, as a to-do list/ }),
    ).toBeInTheDocument();
  });

  it("shows an error state when tasks fail to load", async () => {
    server.use(
      http.get("/api/tasks", () => HttpResponse.json({ title: "Internal error" }, { status: 500 })),
    );
    renderApp("/app");
    // the tasks query retries twice before giving up
    expect(
      await screen.findByText("We couldn't load your tasks.", undefined, { timeout: 6000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("landing", () => {
  it("explains a failed Google sign-in", async () => {
    server.use(
      http.get("/api/me", () => HttpResponse.json({ title: "Unauthorized" }, { status: 401 })),
    );
    renderApp("/?auth_error=insufficient_scope");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Read-only Gmail access wasn't granted/,
    );
    expect(screen.getByRole("link", { name: /Connect Gmail/ })).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/api\/auth\/google\?tz=/),
    );
  });

  it("has no demo button: the only way in is connecting Gmail", async () => {
    server.use(
      http.get("/api/me", () => HttpResponse.json({ title: "Unauthorized" }, { status: 401 })),
    );
    renderApp("/");
    expect(await screen.findByRole("link", { name: /Connect Gmail/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /demo/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
  });
});

describe("auto-refresh", () => {
  it("reads the inbox right away the first time, without pressing Sync", async () => {
    let posted = 0;
    server.use(
      http.get("/api/me", () => HttpResponse.json({ ...user, last_sync_at: null })),
      http.post("/api/sync", () => {
        posted += 1;
        return HttpResponse.json({ jobId: finishedRun.id }, { status: 202 });
      }),
    );
    renderApp("/app");
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    expect(posted).toBe(1);
    useUi.getState().setActiveRun(null);
  });

  it("does not sync on load once the inbox has been read, and says it checks automatically", async () => {
    let posted = 0;
    server.use(
      http.post("/api/sync", () => {
        posted += 1;
        return HttpResponse.json({ jobId: finishedRun.id }, { status: 202 });
      }),
    );
    renderApp("/app");
    expect(await screen.findByText(/checks for new mail every 2 min/)).toBeInTheDocument();
    expect(posted).toBe(0);
  });

  it("refreshes tasks when a background check finishes, and follows one that is running", async () => {
    let runs: SyncRun[] = [];
    let tasks = [makeTask({ title: "Old task" })];
    server.use(
      http.get("/api/sync/runs", () => HttpResponse.json({ items: runs })),
      http.get("/api/sync/:id", ({ params }) =>
        HttpResponse.json(runs.find((r) => r.id === params.id) ?? finishedRun),
      ),
      http.get("/api/tasks", ({ request }) =>
        HttpResponse.json(
          page(new URL(request.url).searchParams.get("status") !== "open" ? [] : tasks),
        ),
      ),
    );
    const { qc } = renderApp("/app");
    expect(await screen.findByRole("listitem", { name: "Old task" })).toBeInTheDocument();

    // a background check found new mail and already finished
    tasks = [...tasks, makeTask({ title: "Reply to the security alert" })];
    runs = [{ ...finishedRun, id: "22222222-2222-4222-8222-222222222222" }];
    await act(() => qc.refetchQueries({ queryKey: keys.runs, exact: true }));
    expect(
      await screen.findByRole("listitem", { name: "Reply to the security alert" }),
    ).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(0);

    // the next one is still running: its live progress is shown
    runs = [{ ...finishedRun, id: "33333333-3333-4333-8333-333333333333", status: "running" }];
    await act(() => qc.refetchQueries({ queryKey: keys.runs, exact: true }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]?.url).toBe(
      "/api/sync/33333333-3333-4333-8333-333333333333/events",
    );
    useUi.getState().setActiveRun(null);
  });

  it("keeps 'synced … ago' current while the page stays open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let lastSync = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago at page load
      server.use(http.get("/api/me", () => HttpResponse.json({ ...user, last_sync_at: lastSync })));
      renderApp("/app");
      expect(await screen.findByText(/synced 5 min ago/)).toBeInTheDocument();

      // a background check that found no new mail: only last_sync_at moves
      lastSync = new Date(Date.now()).toISOString();
      await act(() => vi.advanceTimersByTimeAsync(RUNS_POLL_MS + 1_000));
      expect(await screen.findByText(/synced just now/)).toBeInTheDocument();

      // with no further checks, the relative time still counts up on its own
      await act(() => vi.advanceTimersByTimeAsync(2 * 60_000));
      expect(await screen.findByText(/synced 2 min ago/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("describes the check interval", () => {
    expect(autoSyncNote(120)).toBe(" · checks for new mail every 2 min");
    expect(autoSyncNote(30)).toBe(" · checks for new mail every 30 s");
    expect(autoSyncNote(0)).toBe("");
    expect(autoSyncNote(undefined)).toBe("");
  });
});

describe("Gmail connection expired", () => {
  it("says so and offers one-click Reconnect; hidden while connected", async () => {
    server.use(http.get("/api/me", () => HttpResponse.json({ ...user, gmail_connected: false })));
    renderApp("/app");
    const banner = await screen.findByTestId("reconnect-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(
      "Your Gmail connection has expired, so new mail is not being checked.",
    );
    expect(within(banner).getByRole("link", { name: /Reconnect Gmail/ })).toHaveAttribute(
      "href",
      "/api/auth/google?tz=Asia%2FKolkata",
    );
  });

  it("is not shown while Gmail is connected", async () => {
    server.use(http.get("/api/me", () => HttpResponse.json({ ...user, gmail_connected: true })));
    renderApp("/app");
    await screen.findByRole("tab", { name: "Upcoming" });
    expect(screen.queryByTestId("reconnect-banner")).not.toBeInTheDocument();
  });
});

describe("past 7 days", () => {
  it("catch-up: summary, still-open tasks, mail by day, and skipped mail you can add as a task", async () => {
    const withTask = makeEmail({
      subject: "Deck for Friday",
      local_date: "2026-10-15", // yesterday
      received_at: "2026-10-15T05:00:00Z",
      tasks: [
        makeTask({ title: "Send the deck", priority: "P1", evidence: "Please send the deck." }),
        makeTask({ title: "Book room", priority: "P2", status: "done" }),
      ],
    });
    const alert = makeEmail({
      from_name: "Google",
      from_email: "no-reply@accounts.google.example",
      subject: "Security alert",
      status: "skipped",
      skip_reason: "automated",
      local_date: "2026-10-13",
      received_at: "2026-10-13T03:00:00Z",
    });
    const patches: unknown[] = [];
    const added: string[] = [];
    server.use(
      http.get("/api/emails", () => HttpResponse.json(emailPage([withTask, alert]))),
      http.post("/api/emails/:id/task", ({ params }) => {
        added.push(String(params.id));
        return HttpResponse.json(makeTask({ title: "Security alert" }), { status: 201 });
      }),
      http.patch("/api/tasks/:id", async ({ request, params }) => {
        patches.push({ id: params.id, ...((await request.json()) as object) });
        return HttpResponse.json({ ...withTask.tasks[1], status: "open" });
      }),
    );
    const u = userEvent.setup();
    renderApp("/app");

    const pastTab = await screen.findByRole("tab", { name: "Catch-up" });
    expect(pastTab).toHaveAttribute("aria-selected", "false");
    await u.click(pastTab);
    expect(pastTab).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: "Catch-up" });

    const rows = await within(panel).findAllByTestId("recent-mail");
    expect(rows).toHaveLength(2);
    expect(within(panel).getByTestId("catchup-summary")).toHaveTextContent(
      /2 emails · 1 became tasks · 1 skipped \(1 automated notification\) · 1 done/,
    );
    expect(within(panel).getByRole("heading", { name: /Yesterday/ })).toBeInTheDocument();
    expect(within(panel).queryByRole("heading", { name: /^Today/ })).not.toBeInTheDocument();

    // the same tiles as Upcoming, counted over these emails' tasks
    expect(within(panel).getByTestId("kpi-overdue")).toHaveTextContent("0");
    expect(within(panel).queryByTestId("kpi-today")).not.toBeInTheDocument(); // no "Today" here
    expect(within(panel).getByTestId("kpi-this-week")).toHaveTextContent("0");
    expect(within(panel).getByTestId("kpi-done")).toHaveTextContent("1");

    // a calendar of the 7 days before today, with the mail count per day
    const strip = within(panel).getByRole("navigation", { name: "Past 7 days" });
    const days = within(strip).getAllByRole("button");
    expect(days).toHaveLength(7);
    expect(days[0]).toHaveAccessibleName(/^Fri 9: 0 emails/);
    expect(days[6]).toHaveAccessibleName("Thu 15: 1 email, 2 tasks, 1 high priority");
    expect(days[6]).toBeEnabled();
    expect(within(strip).getByRole("button", { name: /^Tue 13: 1 email, 0 tasks$/ })).toBeEnabled();
    expect(within(strip).getByRole("button", { name: /^Mon 12: 0 emails/ })).toBeDisabled();
    expect(within(strip).queryByText("16")).not.toBeInTheDocument(); // today is not in the past

    // the open task is listed once, under "Still open", as the same card as Upcoming
    const stillOpen = within(panel).getByTestId("still-open");
    const deck = within(stillOpen).getByRole("listitem", { name: "Send the deck" });
    expect(within(rows[0]!).queryByRole("listitem", { name: "Send the deck" })).toBeNull();
    expect(within(deck).getByText(/P1/)).toBeInTheDocument();
    expect(within(deck).getByText("Please send the deck.")).toBeInTheDocument();
    expect(within(deck).getByText(/From Priya/)).toBeInTheDocument();
    expect(
      within(deck).getByRole("button", { name: 'Mark "Send the deck" as done' }),
    ).toBeInTheDocument();
    expect(within(deck).getByRole("button", { name: 'Why "Send the deck"?' })).toBeInTheDocument();

    // a finished task says so in words, and can be put back on the list
    const room = within(rows[0]!).getByRole("listitem", { name: "Book room" });
    expect(within(room).getByText("Done")).toBeInTheDocument();
    expect(within(room).queryByText(/Overdue/)).not.toBeInTheDocument();
    await u.click(within(room).getByRole("button", { name: 'Reopen "Book room"' }));
    await waitFor(() => expect(patches).toEqual([{ id: withTask.tasks[1]!.id, status: "open" }]));

    expect(within(rows[1]!).getByText("Automated notification")).toBeInTheDocument();
    expect(
      within(rows[1]!).getByRole("link", { name: 'Open "Security alert" in Gmail' }),
    ).toHaveAttribute("href", alert.gmail_url);

    // skipped mail is folded away, and can be turned into a task
    const skippedGroup = within(panel).getByTestId("skipped");
    expect(skippedGroup).not.toHaveAttribute("open");
    expect(skippedGroup).toHaveTextContent("Skipped by the agent (1)");
    await u.click(
      within(skippedGroup).getByRole("button", { name: 'Add "Security alert" as a task' }),
    );
    await waitFor(() => expect(added).toEqual([alert.id]));

    // the Upcoming filters work here too (and hide the skipped group)
    await u.click(within(panel).getByRole("button", { name: /^P1/ }));
    expect(within(panel).getAllByTestId("recent-mail")).toHaveLength(1);
    expect(within(panel).queryByRole("listitem", { name: "Book room" })).not.toBeInTheDocument();
    expect(within(panel).queryByTestId("skipped")).not.toBeInTheDocument();
    await u.click(within(panel).getByRole("button", { name: "All" }));

    // arrow keys move between tabs
    await u.click(pastTab);
    await u.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Upcoming" })).toHaveAttribute("aria-selected", "true");
  });

  it("says so when there is no recent mail", async () => {
    const u = userEvent.setup();
    renderApp("/app");
    await u.click(await screen.findByRole("tab", { name: "Catch-up" }));
    expect(await screen.findByText("No mail in the past 7 days")).toBeInTheDocument();
  });

  it("labels outcomes and groups by day, newest first", () => {
    expect(outcomeLabel({ status: "skipped", skip_reason: "promotion", tasks: [] })).toBe(
      "Promotion",
    );
    expect(outcomeLabel({ status: "failed", skip_reason: null, tasks: [] })).toBe(
      "Couldn't process",
    );
    expect(outcomeLabel({ status: "processed", skip_reason: null, tasks: [] })).toBe(
      "No action needed",
    );
    const a = makeEmail({ local_date: "2026-10-14" });
    const b = makeEmail({ local_date: "2026-10-16" });
    const c = makeEmail({ local_date: "2026-10-14" });
    expect(groupByLocalDate([a, b, c]).map(([d, es]) => [d, es.length])).toEqual([
      ["2026-10-16", 1],
      ["2026-10-14", 2],
    ]);
  });
});

describe("welcome back (remembered browser)", () => {
  const signedOut = () =>
    http.get("/api/me", () => HttpResponse.json({ title: "Unauthorized" }, { status: 401 }));

  it("one click 'Continue as …' signs in with no Google screens", async () => {
    let signedIn = false;
    const posted: string[] = [];
    server.use(
      http.get("/api/me", () =>
        signedIn
          ? HttpResponse.json(user)
          : HttpResponse.json({ title: "Unauthorized" }, { status: 401 }),
      ),
      http.get("/api/auth/remembered", () =>
        HttpResponse.json({ email: user.email, name: "Sam Rao", gmail_connected: true }),
      ),
      http.post("/api/auth/resume", () => {
        posted.push("resume");
        signedIn = true;
        return HttpResponse.json(user);
      }),
    );
    const u = userEvent.setup();
    const { router } = renderApp("/");
    const card = await screen.findByTestId("welcome-back");
    expect(within(card).getByRole("link", { name: "Use another Google account" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/api\/auth\/google\?tz=/),
    );
    expect(screen.queryByRole("link", { name: /Connect Gmail/ })).not.toBeInTheDocument();

    await u.click(within(card).getByRole("button", { name: "Continue as Sam Rao" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/app"));
    expect(posted).toEqual(["resume"]);
  });

  it("when Google ended access, the one button reconnects through Google", async () => {
    server.use(
      signedOut(),
      http.get("/api/auth/remembered", () =>
        HttpResponse.json({ email: user.email, name: null, gmail_connected: false }),
      ),
    );
    renderApp("/");
    const card = await screen.findByTestId("welcome-back");
    expect(
      within(card).getByRole("link", { name: `Reconnect Gmail as ${user.email}` }),
    ).toHaveAttribute("href", expect.stringMatching(/^\/api\/auth\/google\?tz=/));
  });

  it("'Not you?' forgets this browser and shows Connect Gmail", async () => {
    let forgotten = false;
    server.use(
      signedOut(),
      http.get("/api/auth/remembered", () =>
        forgotten
          ? new HttpResponse(null, { status: 204 })
          : HttpResponse.json({ email: user.email, name: "Sam Rao", gmail_connected: true }),
      ),
      http.post("/api/auth/forget", () => {
        forgotten = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const u = userEvent.setup();
    renderApp("/");
    await u.click(await screen.findByRole("button", { name: "Not you? Forget this browser" }));
    expect(await screen.findByRole("link", { name: /Connect Gmail/ })).toBeInTheDocument();
    expect(screen.queryByTestId("welcome-back")).not.toBeInTheDocument();
    expect(forgotten).toBe(true);
  });

  it("the account menu can sign out and forget this browser", async () => {
    const bodies: unknown[] = [];
    let out = false;
    server.use(
      http.get("/api/me", () =>
        out
          ? HttpResponse.json({ title: "Unauthorized" }, { status: 401 })
          : HttpResponse.json(user),
      ),
      http.post("/api/auth/logout", async ({ request }) => {
        bodies.push(await request.json());
        out = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const u = userEvent.setup();
    const { router } = renderApp("/app");
    await u.click(await screen.findByRole("button", { name: /Account menu/ }));
    await u.click(await screen.findByRole("menuitem", { name: /forget this browser/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(bodies).toEqual([{ forget: true }]);
  });
});

describe("settings basics: profile, sign out, appearance", () => {
  it("shows the profile and offers both sign-out options", async () => {
    const bodies: unknown[] = [];
    let out = false;
    server.use(
      http.get("/api/me", () =>
        out
          ? HttpResponse.json({ title: "Unauthorized" }, { status: 401 })
          : HttpResponse.json({ ...user, gmail_connected: true }),
      ),
      http.post("/api/auth/logout", async ({ request }) => {
        bodies.push(await request.json());
        out = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const u = userEvent.setup();
    const { router } = renderApp("/app/settings");
    const profile = await screen.findByRole("heading", { name: "Profile" });
    const card = profile.closest("#profile") as HTMLElement;
    expect(within(card).getByText(user.email)).toBeInTheDocument();
    expect(within(card).getByText("Sam Rao")).toBeInTheDocument();
    expect(within(card).getByText("Connected with Google (read-only)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Sign out and forget this browser/ }),
    ).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: /^Sign out$/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(bodies).toEqual([{ forget: false }]);
  });
});

describe("hover text", () => {
  it("every icon button names itself on hover", async () => {
    server.use(
      http.get("/api/tasks", () => HttpResponse.json(page([makeTask({ title: "Send the deck" })]))),
    );
    renderApp("/app");
    await screen.findByRole("listitem", { name: "Send the deck" });
    for (const b of screen.getAllByRole("button")) {
      const name = b.getAttribute("aria-label");
      if (name) expect(b).toHaveAttribute("title", name);
    }
    expect(screen.getByRole("button", { name: 'Mark "Send the deck" as done' })).toHaveAttribute(
      "title",
      'Mark "Send the deck" as done',
    );
    expect(screen.getByRole("tab", { name: "Catch-up" })).toHaveAttribute(
      "title",
      expect.stringMatching(/7 days before today/),
    );
  });

  it("the Ask box invites questions to the Inbox Copilot AI agent", async () => {
    renderApp("/app");
    expect(await screen.findByLabelText("Question")).toHaveAttribute(
      "placeholder",
      "Ask the Inbox Copilot AI agent about your tasks…",
    );
  });
});

describe("live background", () => {
  afterEach(() => useUi.getState().setBackdrop("aurora"));

  it("defaults to Aurora, reacts while the agent works, and can be changed or turned off", async () => {
    server.use(
      http.post("/api/sync", () => HttpResponse.json({ jobId: finishedRun.id }, { status: 202 })),
      http.get(`/api/sync/${finishedRun.id}`, () => HttpResponse.json(finishedRun)),
    );
    const u = userEvent.setup();
    renderApp("/app");
    const backdrop = await screen.findByTestId("agent-backdrop");
    expect(backdrop).toHaveAttribute("data-backdrop", "aurora");
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    expect(backdrop).toHaveAttribute("data-busy", "false");

    // a sync starts: the background picks it up in real time
    await u.click(screen.getByRole("button", { name: "Sync inbox" }));
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    act(() => FakeEventSource.instances[0]?.emit("queued", { seq: 1, type: "queued", at: "" }));
    await waitFor(() =>
      expect(screen.getByTestId("agent-backdrop")).toHaveAttribute("data-busy", "true"),
    );
    act(() =>
      FakeEventSource.instances[0]?.emit("done", { seq: 2, type: "done", at: "", data: {} }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("agent-backdrop")).toHaveAttribute("data-busy", "false"),
    );
    useUi.getState().setActiveRun(null);

    // switch from the theme menu
    await u.click(screen.getByRole("button", { name: /^Theme: / }));
    await u.click(await screen.findByRole("menuitem", { name: /Plain/ }));
    await waitFor(() => expect(screen.queryByTestId("agent-backdrop")).not.toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem("inboxpilot-ui") ?? "{}").state.backdrop).toBe("none");
  });

  it("Settings → Appearance lists every background with what it does", async () => {
    // jsdom has no canvas: the canvas backgrounds then stay blank (as on any browser without it)
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const u = userEvent.setup();
    renderApp("/app/settings");
    const group = await screen.findByRole("group", { name: "Live background" });
    expect(within(group).getAllByRole("radio")).toHaveLength(5);
    await u.click(within(group).getByRole("radio", { name: /Neural mesh/ }));
    expect(useUi.getState().backdrop).toBe("neural");
    expect(screen.getByTestId("agent-backdrop")).toHaveAttribute("data-backdrop", "neural");
    expect(getContext).toHaveBeenCalled();
    getContext.mockRestore();
  });
});

describe("settings", () => {
  it("has only Profile, Appearance (mode + live background), Sign out and Delete", async () => {
    renderApp("/app/settings");
    await screen.findByRole("heading", { name: "Profile" });
    const headings = screen
      .getAllByRole("heading")
      .map((h) => h.textContent)
      .filter((t) => t !== "Settings");
    expect(headings).toEqual(["Profile", "Appearance", "Sign out", "Disconnect and delete data"]);
    for (const gone of [/AI models/, /Prioritisation/, /VIP senders/, /Colour theme/]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    // the profile still shows the timezone, but there is nothing to edit here any more
    expect(screen.queryByRole("textbox", { name: "Timezone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "AI providers" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Mode" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Live background" })).toBeInTheDocument();
  });

  it("deletes the account only after typing DELETE", async () => {
    let deleted = false;
    server.use(
      // once deleted, the account no longer exists: the landing page must stay
      http.get("/api/me", () =>
        deleted
          ? HttpResponse.json({ title: "Unauthorized" }, { status: 401 })
          : HttpResponse.json(user),
      ),
      http.delete("/api/me", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const u = userEvent.setup();
    const { router } = renderApp("/app/settings");
    await u.click(await screen.findByRole("button", { name: /Delete my data/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete all your data?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    expect(confirm).toBeDisabled();
    await u.type(within(dialog).getByLabelText("Type DELETE to confirm"), "DELETE");
    await u.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(deleted).toBe(true);
  });
});

describe("colour themes", () => {
  afterEach(() => useUi.getState().setPalette("inbox"));

  it("picks a theme from the header menu; it is applied at once and remembered", async () => {
    const u = userEvent.setup();
    renderApp("/app");
    await u.click(await screen.findByRole("button", { name: /^Theme: / }));
    const midnight = await screen.findByRole("menuitem", { name: /Midnight Courier/ });
    expect(screen.getByRole("menuitem", { name: /Inbox Blue/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await u.click(midnight);
    await waitFor(() => expect(document.documentElement.dataset.palette).toBe("midnight"));
    expect(JSON.parse(localStorage.getItem("inboxpilot-ui") ?? "{}").state.palette).toBe(
      "midnight",
    );
    expect(screen.getByRole("button", { name: /^Theme: .*Midnight Courier/ })).toBeInTheDocument();
  });
});

describe("runs page + provider badge", () => {
  it("lists runs with their trace and models", async () => {
    server.use(http.get("/api/sync/runs", () => HttpResponse.json({ items: [finishedRun] })));
    const u = userEvent.setup();
    renderApp("/app/runs");
    await u.click(await screen.findByText(/28 fetched · 28 processed · 22 tasks/));
    expect(screen.getByRole("table", { name: "Agent trace" })).toBeInTheDocument();
    expect(screen.getAllByText("ExtractionAgent").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/gemini\/gemini-2.5-flash · 1 calls · 300 ms · 1 failed \(429\)/),
    ).toBeInTheDocument();
  });

  it("summarises model availability", () => {
    expect(summarizeProviders(providers)).toEqual({ label: "Rules only", tone: "rules" });
    const groqReady = [
      { ...providers[0]!, configured: true, available: false, circuit: "open" as const },
      { ...providers[0]!, name: "groq", configured: true, available: true },
    ];
    expect(summarizeProviders(groqReady)).toEqual({ label: "groq", tone: "warn" });
    expect(summarizeProviders([{ ...providers[0]!, configured: true, available: false }])).toEqual({
      label: "LLMs cooling down",
      tone: "warn",
    });
  });
});
