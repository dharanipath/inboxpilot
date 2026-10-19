import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeTask, TODAY, TZ } from "@/test/server";
import { renderWithProviders } from "@/test/render";
import { useUi } from "@/store/ui";

import { applyFilters, TaskBoard } from "./TaskBoard";

const actions = {
  onDone: vi.fn(),
  onSnooze: vi.fn(),
  onDismiss: vi.fn(),
  onEditDue: vi.fn(),
  onReopen: vi.fn(),
};

const tasks = [
  makeTask({
    title: "Pay invoice",
    type: "payment",
    priority: "P0",
    bucket: "overdue",
    due_date: "2026-10-14",
  }),
  makeTask({ title: "Send deck", type: "send", priority: "P1", bucket: "today" }),
  makeTask({
    title: "Review contract",
    type: "review",
    priority: "P2",
    bucket: "week",
    due_date: "2026-10-18",
  }),
  makeTask({
    title: "Join call",
    type: "meeting",
    priority: "P2",
    bucket: "week",
    due_date: "2026-10-20",
  }),
  makeTask({
    title: "Read notes",
    type: "other",
    priority: "P3",
    bucket: "undated",
    due_date: null,
  }),
  makeTask({
    title: "Maybe reply",
    type: "reply",
    priority: "P3",
    bucket: "needs_review",
    confidence: 0.3,
  }),
];

const titles = (region: HTMLElement) =>
  within(region)
    .queryAllByRole("listitem")
    .map(
      (li) =>
        li.getAttribute("aria-labelledby") &&
        document.getElementById(li.getAttribute("aria-labelledby") ?? "")?.textContent,
    );

describe("TaskBoard", () => {
  beforeEach(() => useUi.getState().resetFilters());

  it("splits tasks into Overdue, Today, Next 7 days by day, No date, and a collapsed Needs review", () => {
    renderWithProviders(<TaskBoard tasks={tasks} today={TODAY} timezone={TZ} actions={actions} />);
    const overdue = screen.getByRole("region", { name: /Overdue/ });
    expect(titles(overdue)).toEqual(["Pay invoice"]);
    expect(titles(screen.getByRole("region", { name: /^Today/ }))).toEqual(["Send deck"]);
    const week = screen.getByRole("region", { name: /Next 7 days/ });
    expect(within(week).getByRole("heading", { level: 4, name: "Sun 18 Oct" })).toBeInTheDocument();
    expect(within(week).getByRole("heading", { level: 4, name: "Tue 20 Oct" })).toBeInTheDocument();
    const undated = screen.getByTestId("undated"); // collapsed: not part of the week view
    expect(undated).not.toHaveAttribute("open");
    expect(undated).toHaveTextContent("No due date (1)");
    expect(titles(undated)).toEqual(["Read notes"]);
    const review = screen.getByText(/Needs review/).closest("details");
    expect(review).not.toHaveAttribute("open"); // low-confidence tasks stay out of the way
    expect(screen.queryByRole("region", { name: /Later/ })).not.toBeInTheDocument();
  });

  it("filters by priority and type, and offers to clear an empty result", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskBoard tasks={tasks} today={TODAY} timezone={TZ} actions={actions} />);
    await user.click(screen.getByRole("button", { name: "P2 Medium" }));
    expect(screen.getByRole("button", { name: "P2 Medium" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByText("Pay invoice")).not.toBeInTheDocument();
    expect(screen.getByText("Review contract")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Task type"), "meeting");
    expect(screen.queryByText("Review contract")).not.toBeInTheDocument();
    expect(screen.getByText("Join call")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Task type"), "payment");
    expect(screen.getByText("No tasks match these filters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Pay invoice")).toBeInTheDocument();
  });

  it("shows an empty state with an action when there are no tasks", () => {
    renderWithProviders(
      <TaskBoard
        tasks={[]}
        today={TODAY}
        timezone={TZ}
        actions={actions}
        emptyAction={<button type="button">Sync now</button>}
      />,
    );
    expect(screen.getByText("No open tasks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
  });

  it("applyFilters is a pure function", () => {
    expect(applyFilters(tasks, "all", "all")).toHaveLength(6);
    expect(applyFilters(tasks, "payment", "all").map((t) => t.title)).toEqual(["Pay invoice"]);
    expect(applyFilters(tasks, "all", "P3")).toHaveLength(2);
  });
});
