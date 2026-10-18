# Roadmap

Ordered roughly by value to users.

1. **Gmail push.** Use `users.watch` with Cloud Pub/Sub for near-real-time sync instead of manual Sync. The incremental `historyId` path already exists, so push only needs to trigger it.
2. **Feedback loop.** Thumbs up or down on a task, and "this isn't a task", feed new cases into `evals/dataset.json`. This grows the eval beyond what the rules' author wrote.
3. **Google Calendar (read).** Avoid suggesting a meeting time you're busy, and add a task to the calendar on request (write access only when the user asks).
4. **Your own commitments.** Track promises in Sent mail ("I'll send it Monday").
5. **Morning digest.** An 8 AM email or browser notification for P0 tasks.
6. **Large bodies.** Fetch text parts that Gmail returns as `attachmentId` instead of inline data.
7. **Multi-tenant org mode.** SSO, admin audit views, and per-org retention policy.
8. **Key rotation for `TOKEN_ENC_KEY`.** Use key ids in the ciphertext header, and re-encrypt on next use.
