import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeTask, TODAY, TZ } from "@/test/server";
import { renderWithProviders } from "@/test/render";

import { TaskCard } from "./TaskCard";

function setup(over = {}) {
  const task = makeTask({
    title: "Send the deck to Priya",
    priority: "P0",
    type: "payment",
    due_at: "2026-10-16T09:30:00Z",
    has_time: true,
    priority_reasons: ["Due today", "Payment", "VIP sender"],
    confidence: 0.86,
    evidence: "Can you send the deck before the call on Tuesday?",
    ...over,
  });
  const actions = {
    onDone: vi.fn(),
    onSnooze: vi.fn(),
    onDismiss: vi.fn(),
    onEditDue: vi.fn(),
    onReopen: vi.fn(),
  };
  renderWithProviders(
    <ul>
      <TaskCard
        task={task}
        today={TODAY}
        timezone={TZ}
        now={new Date("2026-10-16T06:00:00Z")}
        {...actions}
      />
    </ul>,
  );
  return { task, actions, user: userEvent.setup() };
}

describe("TaskCard", () => {
  it("shows title, priority as text (not colour only), type, due time in the user's zone, sender and evidence", () => {
    setup();
    const card = screen.getByRole("listitem", { name: "Send the deck to Priya" });
    expect(within(card).getByLabelText("Priority P0, urgent")).toHaveTextContent("P0 · Urgent");
    expect(within(card).getByText("Today, 3:00 PM")).toBeInTheDocument(); // 09:30Z = 15:00 IST
    expect(within(card).getAllByText("Payment").length).toBeGreaterThan(0);
    expect(within(card).getByText("From Priya Shah")).toBeInTheDocument();
    expect(
      within(card).getByText("Can you send the deck before the call on Tuesday?"),
    ).toBeInTheDocument();
  });

  it("marks done with one click", async () => {
    const { task, actions, user } = setup();
    await user.click(screen.getByRole("button", { name: 'Mark "Send the deck to Priya" as done' }));
    expect(actions.onDone).toHaveBeenCalledWith(task);
  });

  it("snoozes to tomorrow 9 AM in the user's timezone and can dismiss", async () => {
    const { task, actions, user } = setup();
    await user.click(screen.getByRole("button", { name: /More actions/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Tomorrow morning/ }));
    expect(actions.onSnooze).toHaveBeenCalledWith(task, new Date("2026-10-17T03:30:00Z"));

    await user.click(screen.getByRole("button", { name: /More actions/ }));
    await user.click(await screen.findByRole("menuitem", { name: /dismiss/ }));
    expect(actions.onDismiss).toHaveBeenCalledWith(task);
  });

  it("links to the Gmail thread for real accounts", async () => {
    const { user } = setup({ gmail_url: "https://mail.google.com/mail/u/0/#inbox/thr-1" });
    await user.click(screen.getByRole("button", { name: /More actions/ }));
    const link = await screen.findByRole("menuitem", { name: /Open in Gmail/ });
    expect(link).toHaveAttribute("href", "https://mail.google.com/mail/u/0/#inbox/thr-1");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("a done task says Done in words, is not called overdue, and can be reopened", async () => {
    const { task, actions, user } = setup({
      status: "done",
      bucket: "overdue",
      due_date: "2026-10-14",
      due_at: null,
      has_time: false,
    });
    const card = screen.getByRole("listitem", { name: task.title });
    expect(within(card).getByText("Done")).toBeInTheDocument();
    expect(within(card).queryByText(/Overdue/)).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /as done$/ })).not.toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: `Reopen "${task.title}"` }));
    expect(actions.onReopen).toHaveBeenCalledWith(task);
    await user.click(within(card).getByRole("button", { name: /More actions/ }));
    expect(await screen.findByRole("menuitem", { name: /Open in Gmail/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /dismiss/ })).not.toBeInTheDocument();
  });

  it("explains itself: evidence, reasons, confidence, model, and lets you edit the due date", async () => {
    const { task, actions, user } = setup();
    await user.click(screen.getByRole("button", { name: 'Why "Send the deck to Priya"?' }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("VIP sender")).toBeInTheDocument();
    expect(within(dialog).getByText("86%")).toBeInTheDocument();
    expect(within(dialog).getByText("heuristic/rules-v1")).toBeInTheDocument();
    expect(within(dialog).getByText("Resolved from the email's wording")).toBeInTheDocument();
    const input = within(dialog).getByLabelText("Change due date");
    await user.clear(input);
    await user.type(input, "2026-10-21");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(actions.onEditDue).toHaveBeenCalledWith(task, "2026-10-21");
  });

  it("flags overdue tasks in words", () => {
    setup({ due_date: "2026-10-14", due_at: null, has_time: false, bucket: "overdue" });
    expect(screen.getByText("Overdue · 2 days")).toBeInTheDocument();
  });
});
