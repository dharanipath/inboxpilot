import { expect, type APIRequestContext, type Page, test } from "@playwright/test";

/**
 * Real-user flow: Connect Gmail (a local fake Google, see playwright.config.ts) → the first
 * sync runs on its own → new mail appears without pressing Sync → past 7 days history.
 */
const GOOGLE = "http://127.0.0.1:4555";

/** Sign in as a brand-new Google account and wait for the automatic first sync to finish. */
async function connectGmail(page: Page, request: APIRequestContext) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await request.post(`${GOOGLE}/__admin/profile`, {
    data: { sub: `g-${id}`, email: `sam-${id}@gmail.example`, name: "Sam Rao" },
  });
  expect(res.status()).toBe(204);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Your inbox, as a to-do list/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /demo/i })).toHaveCount(0);
  await page.getByRole("link", { name: /Connect Gmail/ }).click();
  await expect(page).toHaveURL(/\/app$/);
  const panel = page.getByRole("region", { name: "Agent run" });
  await expect(panel.getByText("Done", { exact: true })).toBeVisible({ timeout: 60_000 });
  return panel;
}

const card = (page: Page, name: RegExp) => page.getByRole("listitem", { name });
/** An open task's card (closed ones sit in "Done, snoozed & dismissed" with Reopen instead). */
const openCard = (page: Page, name: RegExp) =>
  card(page, name).filter({ has: page.getByRole("button", { name: /as done$/ }) });

test("connect Gmail → first sync on its own → explain → mark done → stays done", async ({
  page,
  request,
}) => {
  const panel = await connectGmail(page, request);

  const steps = panel.getByRole("list", { name: "Pipeline steps" });
  for (const step of ["Fetch", "Triage", "Extract", "Ground", "Dates", "Prioritise", "Plan"]) {
    await expect(steps.getByText(new RegExp(`^${step} — done`))).toBeVisible();
  }
  await expect(page.getByText(/checks for new mail every 5 s/)).toBeVisible();

  // the CEO's urgent request is a top task, explained with its evidence
  const ceo = card(page, /Board prep|revenue forecast/i);
  await expect(ceo).toBeVisible();
  await expect(ceo.getByLabel(/Priority P[01]/)).toBeVisible();
  await ceo.getByRole("button", { name: /^Why/ }).click();
  const why = page.getByRole("dialog");
  await expect(why.getByText("Marked urgent")).toBeVisible();
  await expect(why.getByText(/revenue forecast numbers before 1 PM today/)).toBeVisible();
  await page.keyboard.press("Escape");

  // the prompt-injection email produced no task
  await expect(page.getByText(/Wire Rs/)).toHaveCount(0);

  // mark done: instant, counted, survives a reload
  await expect(page.getByTestId("kpi-done")).toHaveText("0");
  await ceo.getByRole("button", { name: /as done$/ }).click();
  await expect(page.getByText("Marked done")).toBeVisible();
  await expect(openCard(page, /Board prep|revenue forecast/i)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("kpi-done")).toHaveText("1");
  await expect(openCard(page, /Board prep|revenue forecast/i)).toHaveCount(0);

  // a mis-click is never final: Reopen from the closed list puts it back as it was
  const closed = page.getByRole("region", { name: /Done, snoozed & dismissed/ });
  const doneCard = closed.getByRole("listitem", { name: /Board prep|revenue forecast/i });
  await expect(doneCard).toContainText("Done");
  await doneCard.getByRole("button", { name: /^Reopen/ }).click();
  await expect(page.getByText("Back on your list")).toBeVisible();
  await expect(closed).toHaveCount(0);
  await expect(card(page, /Board prep|revenue forecast/i)).toBeVisible();
  await expect(
    card(page, /Board prep|revenue forecast/i).getByLabel(/Priority P[01]/),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("kpi-done")).toHaveText("0");
  await expect(card(page, /Board prep|revenue forecast/i)).toBeVisible();

  // ask
  await page.getByLabel("Question").fill("What's overdue?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText(/Answered by rules \(no LLM\)/)).toBeVisible();
});

test("new mail shows up on its own, without pressing Sync", async ({ page, request }) => {
  await connectGmail(page, request);
  const id = `e2e-new-${Date.now()}`;
  // a name no earlier email used, so this task can only come from the background check
  const project = `Project ${id.slice(-6).replace(/\d/g, (d) => "QWERTYUIOP"[Number(d)] ?? "Z")}`;
  const task = card(page, new RegExp(project, "i"));
  await expect(page.getByTestId("task-card").first()).toBeVisible();
  await expect(task).toHaveCount(0);

  const res = await request.post(`${GOOGLE}/__admin/messages`, {
    data: {
      id,
      from: '"Security Team" <security@acme.example>',
      subject: `Privacy and security review for ${project}`,
      text: `Hi Sam, please complete the privacy and security review for ${project} by Thursday.`,
      minutesAgo: 1,
    },
  });
  expect(res.status()).toBe(201);

  // the background check (every 5 s here) picks it up and the dashboard refreshes itself
  await expect(task).toBeVisible({ timeout: 60_000 });
});

test("catch-up lists the earlier days' mail (not today's), what is still open, and what was skipped", async ({
  page,
  request,
}) => {
  await connectGmail(page, request);
  await page.getByRole("tab", { name: "Catch-up" }).click();
  const panel = page.getByRole("tabpanel", { name: "Catch-up" });
  const rows = panel.getByTestId("recent-mail");
  await expect(rows.filter({ hasText: "Contract review" })).toContainText(/1 task/);
  // its open task is listed once, under "Still open", as the same card as Upcoming
  await expect(
    panel
      .getByTestId("still-open")
      .getByRole("button", { name: /as done$/ })
      .first(),
  ).toBeVisible();
  // the Upcoming tiles, and a calendar of the 7 days before today with mail counts
  await expect(panel.getByTestId("kpi-overdue")).toBeVisible();
  await expect(panel.getByTestId("kpi-done")).toBeVisible();
  const strip = panel.getByRole("navigation", { name: "Past 7 days" });
  await expect(strip.getByRole("button")).toHaveCount(7);
  await expect(strip.getByRole("button", { name: /: 1 email, 1 task/ }).first()).toBeEnabled();
  // today's mail belongs to Upcoming, not here
  await expect(rows.filter({ hasText: "Board prep" })).toHaveCount(0);
  // skipped mail is folded away until opened
  await panel.getByText("Skipped by the agent").click();
  await expect(rows.filter({ hasText: "This week in product" })).toContainText("Newsletter");
  await expect(rows.filter({ hasText: "Urgent instructions" })).toBeVisible();
  await expect(
    rows
      .filter({ hasText: "Contract review" })
      .getByRole("link", { name: 'Open "Contract review" in Gmail' }),
  ).toHaveAttribute("href", /^https:\/\/mail\.google\.com\//);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // skipped mail can be turned into a task
  await rows
    .filter({ hasText: "This week in product" })
    .getByRole("button", { name: /^Add .* as a task$/ })
    .click();
  await expect(panel.getByTestId("still-open")).toContainText("This week in product");
});

test("keyboard only: reach a task and mark it done", async ({ page, request }) => {
  await connectGmail(page, request);
  const done = page.getByRole("button", { name: /as done$/ }).first();
  const name = await done.getAttribute("aria-label");
  await done.focus();
  await expect(done).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Marked done")).toBeVisible();
  await expect(page.getByRole("button", { name: name ?? "" })).toHaveCount(0);
});

test("fits a 375 px screen without horizontal scrolling", async ({ page, request }) => {
  await connectGmail(page, request);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("button", { name: "Sync inbox" })).toBeVisible();
  await expect(page.getByTestId("task-card").first()).toBeVisible();
});

test("after logout, signing back in is one click with no Google screens", async ({
  page,
  request,
}) => {
  await connectGmail(page, request);
  const res = await page.request.post("/api/auth/logout", { data: {} });
  expect(res.status()).toBe(204);
  await page.goto("/");

  // nothing may go to Google on the way back in
  const googleHits: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/o/oauth2/") || r.url().includes("accounts.google"))
      googleHits.push(r.url());
  });
  const welcome = page.getByTestId("welcome-back");
  await expect(welcome).toContainText("Welcome back");
  await welcome.getByRole("button", { name: /^Continue as / }).click();

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("task-card").first()).toBeVisible();
  expect(googleHits).toEqual([]);

  // "Sign out and forget this browser" removes the shortcut
  const out = await page.request.post("/api/auth/logout", { data: { forget: true } });
  expect(out.status()).toBe(204);
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Connect Gmail/ })).toBeVisible();
  await expect(page.getByTestId("welcome-back")).toHaveCount(0);
});

test("live backgrounds draw in a real browser, without errors or sideways scrolling", async ({
  page,
  request,
}) => {
  await connectGmail(page, request);
  // from here on (signed in), the page must log no errors at all
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await expect(page.getByTestId("agent-backdrop")).toHaveAttribute("data-backdrop", "aurora");

  for (const name of ["Neural mesh", "Mail stream", "Signal grid"]) {
    await page.goto("/app/settings");
    await page
      .getByRole("group", { name: "Live background" })
      .getByText(name, { exact: true })
      .click();
    await page.goto("/app");
    const canvas = page.getByTestId("agent-backdrop").locator("canvas");
    await expect(canvas).toHaveCount(1);
    // it really draws: some pixels are not transparent after a moment
    await expect
      .poll(
        () =>
          canvas.evaluate((el) => {
            const c = el as HTMLCanvasElement;
            const data = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data ?? [];
            let painted = 0;
            for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) painted++;
            return painted;
          }),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(50);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, name).toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});

test("signed-out visitors are sent to the landing page", async ({ page }) => {
  await page.goto("/app/settings");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: /Connect Gmail/ })).toBeVisible();
});

test("no AI key yet: the dashboard says so; the picker offers only the free models and Rules only", async ({
  page,
  request,
}) => {
  await connectGmail(page, request);
  const notice = page.getByTestId("no-ai-banner");
  await expect(notice).toContainText("No AI model is set up yet");
  await expect(notice).toContainText(".env");

  // the header picker on desktop, the dashboard picker on phones
  const picker = page.locator("select#header-model:visible, select#mobile-model:visible");
  await expect(picker).toHaveCount(1);
  const options = await picker.locator("option").allTextContents();
  expect(options).toEqual([
    "Choose a model (no AI key yet)",
    "Google Gemini — add a free key",
    "Groq — add a free key",
    "Rules only (no AI)",
  ]);
  await expect(picker.locator("option", { hasText: "Google Gemini" })).toBeDisabled();

  await picker.selectOption("heuristic");
  await expect(page.getByText("Rules only (no AI) will read your new mail")).toBeVisible();
  await expect(notice).toHaveCount(0); // rules only was chosen on purpose: nothing to warn about

  // Settings no longer has AI models, Prioritisation or Colour theme
  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  for (const gone of ["AI models", "Prioritisation", "Colour theme", "VIP senders"]) {
    await expect(page.getByText(gone, { exact: true })).toHaveCount(0);
  }
});
