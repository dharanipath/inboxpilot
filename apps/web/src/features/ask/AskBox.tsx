import { Loader2, MessageSquareText } from "lucide-react";
import { useState } from "react";

import { useAsk } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/primitives";
import { dueLabel } from "@/lib/format";
import { writtenBy } from "@/lib/providers";

import { PriorityChip } from "../tasks/badges";

const SUGGESTIONS = ["What's due today?", "What's overdue?", "Any payments this week?"];

export function AskBox({ today, timezone }: { today: string; timezone: string }) {
  const [question, setQuestion] = useState("");
  const ask = useAsk();
  const submit = (q: string) => {
    const trimmed = q.trim();
    if (trimmed) ask.mutate(trimmed);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquareText className="size-4" aria-hidden="true" /> Ask about your tasks
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(question);
          }}
        >
          <label htmlFor="ask-input" className="sr-only">
            Question
          </label>
          <Input
            id="ask-input"
            placeholder="Ask the Inbox Copilot AI agent about your tasks…"
            value={question}
            maxLength={500}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <Button type="submit" disabled={ask.isPending || !question.trim()}>
            {ask.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Ask
          </Button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setQuestion(s);
                submit(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <div aria-live="polite">
          {ask.isError ? (
            <p role="alert" className="text-sm text-destructive">
              The assistant couldn't answer right now. Please try again.
            </p>
          ) : null}
          {ask.data ? (
            <div className="space-y-2 rounded-md bg-secondary/60 p-3">
              <p className="text-sm">{ask.data.answer}</p>
              {ask.data.tasks.length ? (
                <ul className="space-y-1" aria-label="Tasks cited in the answer">
                  {ask.data.tasks.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <PriorityChip priority={t.priority} />
                      <span className="font-medium">{t.title}</span>
                      <span className="text-muted-foreground">{dueLabel(t, today, timezone)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-[11px] text-muted-foreground">
                Answered by {writtenBy(ask.data.generated_by)}, from your tasks only
              </p>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
