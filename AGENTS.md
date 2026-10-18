Contract notes for this repo:

- reach is one Cloudflare Worker and one Durable Object per session. Keep it that way: no accounts, no database, nothing to install on the target.
- `GET /` serves the POSIX agent, the PowerShell agent when the client looks like PowerShell, and the homepage for browsers and link previews. It never creates a session. The agent creates its own with `POST /` and prints the code.
- The sender API is `POST /<code>` to run, `GET /<code>` for status and `DELETE /<code>` to end. Raw bodies stay raw; JSON is only parsed with `Content-Type: application/json`. A command that ran returns 200 with its exit code, never a 5xx. `Accept: application/json` returns `exitCode`, `stdout` and `stderr`.
- The 8-character code is the only key. Every code lookup counts against 300 requests a minute per IP. Never log codes.
- The Durable Object stores the session, queues commands in order and deletes itself with an alarm when the session expires.
- The usage rows in `src/site/pages.ts` are the documentation: the homepage, its hidden descriptions for agents, and the comment header of both agent scripts come from them. Change behaviour and usage together.
- Pages are monospace, monotone and framework-free, with system fonts only, matching keep.stoff.dev.
- Tests are end-to-end in `tests/e2e` against the real Worker with real agents. Cover user workflows, not internals.
