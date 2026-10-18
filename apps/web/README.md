# InboxPilot web app

React 18, Vite 6, TypeScript (strict), Tailwind 3 with shadcn/ui-style components on Radix, TanStack Query, Zustand and Framer Motion.

The app only talks to `/api/*`. In development, Vite proxies that path to the gateway, so cookies, SSE and the gateway's Origin check all behave as they will in production.

## Run

```bash
docker compose up -d --wait          # repo root: Postgres + Redis
# start the agent (services/agent) and the gateway (services/api), then:
cd apps/web && npm install && npm run dev      # http://localhost:5173
```

Open the app and click **Connect Gmail** (the gateway needs Google credentials in `.env`). The first sync starts by itself and shows the agent trace live. After that the gateway checks for new mail in the background and the dashboard refreshes itself: it polls `/api/sync/runs` and `/api/me` every 15 s (so "synced … ago" reflects background checks that found nothing new), keeps that relative time ticking, follows a running background sync live, and refetches tasks, briefing and mail when one finishes.

## Screens

| Route           | What's there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`             | Landing: **Connect Gmail**, what we read and store, and friendly messages for `?auth_error=` codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/app`          | Greeting and briefing card; KPI tiles (Overdue, Today, This week, Done); 7-day strip; tabs **Upcoming** (Overdue, Today, Next 7 days grouped by day, Later, No date, and a collapsed **Needs review** for low-confidence items, then **Done, snoozed & dismissed** with Reopen for every task taken off the list) and **Past 7 days** (the 7 days before today: the same KPI tiles, a calendar of those days with mail counts, then each email with the same task cards and filters as Upcoming, plus Reopen for finished tasks, or why an email was skipped); priority and type filters; live **Agent run** panel; **Ask** box |
| `/app/runs`     | Every sync with its full agent trace (step, status, ms, detail) and the models used, including any fallbacks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/app/settings` | **Profile**, **Appearance** (light/dark mode and live background), **Sign out** (or sign out and forget this browser) and **Delete my data** (type DELETE to confirm)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The header holds the **AI model** menu (Gemini, Groq, OpenAI GPT via GitHub Models, Ollama or Rules only) and the theme button (mode, live background, colour theme). On phones the model menu is at the top of the dashboard.

### Task cards

Each card shows:

- a priority chip with **icon and text** (never colour alone)
- the type, and the due label in the **user's** timezone (e.g. "Today, 1:00 PM")
- the sender and the evidence sentence
- actions: **Done**, Snooze (later today, tomorrow 9 AM or next Monday 9 AM, in the user's zone), Open in Gmail, and Dismiss

The **Why?** panel shows the full evidence, the priority score and reasons, the confidence, the model that extracted the task, and where the date came from. You can also edit the due date there.

Done, Snooze and Dismiss are **optimistic**: the card leaves the list at once, an **Undo** toast appears, and the card comes back if the server rejects the change.

### Live agent run

Pressing **Sync** posts `/api/sync` and opens one `EventSource`, shared by the button and the panel. A pure reducer (`features/agent-runs/progress.ts`) maps events to the pipeline Fetch → Triage → Extract → Ground → Dates → Prioritise → Plan. A model fallback stays visible after the run (for example, "gemini rate-limited → groq"). When the run finishes, exact per-step durations come from the stored trace.

A 409 ("sync already running") switches the panel to follow the run that is already in progress.

## Accessibility

- Keyboard-reachable throughout: a skip link, Radix menus and dialogs, and visible focus rings.
- ARIA labels on icon buttons. `aria-live` regions for toasts, run progress and Ask answers. Progress bars carry values.
- Priority is shown as text and icon, not colour alone.
- Sections are labelled regions; task cards are list items named by their title.
- `eslint-plugin-jsx-a11y` runs in lint. `prefers-reduced-motion` is respected.

## Quality gate

```bash
npm run lint          # eslint (typed rules + jsx-a11y + react-hooks) and prettier
npm run typecheck
npm test              # Vitest + React Testing Library; the gateway is mocked with MSW
npm run build
npm run e2e           # Playwright: boots a fake Google, agent, gateway + Vite against docker Postgres/Redis
```

The e2e suite runs the **real** agent (heuristic provider, no LLM keys) and the real OAuth + Gmail code, pointed at a local fake Google (`services/api/tests/fake-google-server.ts`, via `GOOGLE_EMULATOR_URL`). It uses its own ports (web 5174, api 4001, agent 8001, fake Google 4555), the `inboxpilot_test` database and Redis db 3, so it never touches a running `docker compose` stack or a real Google account. It checks:

- Connect Gmail, then the first sync starts by itself, then Done, which survives a reload
- an email that arrives later appears **without pressing Sync**
- the Past 7 days tab shows the earlier days' mail (never today's) with the same task cards
- a keyboard-only flow
- no horizontal scroll at 375 px
- signed-out visitors are redirected

It runs in a desktop project and a 375 px project.
