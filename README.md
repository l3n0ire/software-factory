# Software Factory

**Hire an AI engineering team. Give it a ticket, watch it ship.**

You file a ticket against a small demo repo. Pumpkin (the PM) turns it into a spec, Casper (the Engineer) writes the code and runs the tests, and Mortimer (the Reviewer) critiques the diff. Casper fixes what Mortimer flags, and the result is a local git branch with a diff and passing tests. A small Halloween office UI shows the three characters at their desks. They walk over to each other on every handoff, and their speech bubbles carry the actual messages they send each other.

Built for Haunted Hacks (YC, Oct 31 2026) on two pieces of tech:

- **Terse durable actors** hold all state and stream it live to the UI. `Company` keeps the roster, ticket list and event log. Each `Employee` actor (one per agent, any number per role) keeps its role, persona, status, current task, memory notes, location and stats. Each `Ticket` keeps the spec, plan, branch, diff, test output, review rounds, state and budgets. State survives a restart of everything.
- **Agent Relay** (a self-hosted Relaycast engine) carries every handoff between agents as a DM: customer→PM (ticket), PM→Engineer (spec), Engineer→PM (question), PM→Engineer (answer), Engineer→Reviewer (review request), Reviewer→Engineer (changes), Reviewer→PM (approved), and PM→customer (shipped/failed). Every agent has its own Relay identity (`@pm`, `@ghoulia`, …) and runs only when its listener receives a DM, so if Relay is removed the pipeline stops.
- **OpenAI** does the agents' reasoning. Without `OPENAI_API_KEY`, a clearly labelled **mock LLM** (scripted responses) runs the same pipeline, with the same tools and the same guardrails.

## Run it

Requirements: Bun ≥ 1.4.2 (`curl -fsSL https://bun.sh/install | bash`), the Terse CLI (`bunx terse-cli@latest install`), Node 22 for the Relay engine (better-sqlite3 does not build on Node 26; the script uses `mise exec node@22` when mise is available), and git.

```bash
cd software-factory
OPENAI_API_KEY=sk-...  scripts/start.sh     # or just scripts/start.sh for mock-LLM mode
# open http://localhost:4400  → click "🎃 Demo ticket" (or file your own)
```

`scripts/start.sh` starts the following and stops all of it on Ctrl+C:
1. The Relaycast engine on :8787 (SQLite in `relay/relaycast.db`). On first run it creates a workspace and saves the key in `.state/relay-workspace.json`.
2. `terse actor dev` on :7100 (actor state in `actor/.durable-actors/`).
3. `terse actor generate`, then the brain on :4400, which serves the office UI and the API.

Headless demo, in a second terminal while `start.sh` runs:

```bash
scripts/demo.sh                                  # files the demo ticket, prints the event log, prints the diff
scripts/demo.sh --title "Add GET /pumpkins/spooky" --description "Return only spooky pumpkins, with tests"   # needs OPENAI_API_KEY
scripts/reset.sh                                 # clears tickets/events, workspaces and factory/* branches
```

The finished branch shows up in `demo-repo` as `factory/tN-<slug>`. To inspect it: `git -C demo-repo diff main...factory/t1-add-a-get-health-endpoint`.

### Env vars

| var | default | meaning |
|---|---|---|
| `OPENAI_API_KEY` | unset → mock LLM | real agents |
| `OPENAI_MODEL` | first available of gpt-5.1, gpt-5, gpt-4.1, gpt-4o | model override |
| `MOCK_LLM=1` | | force the mock even when a key is set |
| `MAX_REVIEW_ROUNDS` | 2 | review loop cap |
| `MAX_LLM_CALLS` | 60 | LLM calls per ticket |
| `TICKET_WALL_CLOCK_MS` | 900000 | wall-clock cap per ticket |
| `MAX_ENGINEER_STEPS` | 24 | tool-loop steps per engineer phase |
| `PACE_MS` | 1400 (mock) / 500 | walking pause so the UI can animate handoffs |
| `PORT` | 4400 | brain/UI port |

## Follow-up tickets build on shipped work

When a ticket ships, its branch is published to `demo-repo` and merged (`--no-ff`) into `demo-repo/main`. Every new ticket clones `main`, so a follow-up like "make the page more interactive" sees the page an earlier ticket built. The ticket's diff is computed against the `main` it was cloned from.
- **Merge conflicts:** if two tickets touched the same lines in parallel, the merge is aborted. `main` stays as it was, the ticket branch is still published, and the event log says so.
- **Engineer finishes with no changes:** it is sent back once with an explicit instruction to make a concrete change. That retry counts against the ticket's LLM budget. If it still changes nothing, the ticket fails with the engineer's own explanation.
- **Unknown ticket ids:** `GET /api/tickets/<id>` returns 404 for a ticket that was never filed. Before, reading an unfiled ticket returned a default "queued" record.
- **Reset:** `scripts/reset.sh` deletes the `factory/*` branches but does not undo merges into `main`.

## Retry a failed ticket

A failed ticket shows **Failed while <stage>: <reason>** in the ticket panel, with two buttons:
- **Retry from <stage>:** keeps the spec, branch, commits and review history, and re-sends that stage's Relay handoff to the agent that owns the role. If that agent was removed or replaced, a live agent of the role takes over.
- **Retry from scratch:** asks you to confirm, then starts over on a fresh clone of `main` and a new branch (`…-r<n>`), keeping the ticket id, title and description.

API: `POST /api/tickets/<id>/retry {"mode":"resume"|"scratch"}`.
- **Limits:** each retry gets a fresh LLM-call budget and wall clock. The review-round cap counts only the current attempt. A ticket allows at most 3 retries, enforced in the Ticket actor.
- **Refusals:** a ticket that isn't failed is refused, and a second retry while one is starting is ignored. If no agent of the needed role is active, you get a clear error telling you to hire one.
- **Token ceiling:** if the failure was the process-wide token ceiling, the message says so and offers a **Reset tokens** link (or run `scripts/reset-tokens.sh`).
- **Event log:** shows "T34 FAILED while implementing: …" and "T34 retry 1/3 from implementing".
- **Testing:** `POST /api/tickets` accepts `"maxLlmCalls": n`, which can only lower the cap, to force a failure on purpose.

## Hire and replace agents

The roster is dynamic and durable. It lives in the `Company` actor, so it survives a restart, and the office UI rebuilds itself from it.

- **Hire**: use the *Team* card (name, role, optional persona) or `curl -XPOST localhost:4400/api/agents -H 'content-type: application/json' -d '{"name":"Ghoulia","role":"engineer","persona":"cheerful, test-first"}'`. The new agent gets an Employee actor, its own Relay identity and a desk, then walks in through the door. Each handoff for a role goes to the agent that already owns that role on the ticket. If nobody owns it yet, the handoff goes to the **least busy** active agent of that role, so a second engineer really does take the next ticket. Each ticket records its assignment as `Ticket.assignees`.
- **Replace**: click a character (or *Replace…* in the Team card), enter a new name and an optional persona, or call `curl -XPOST localhost:4400/api/agents/<id>/replace -d '{"name":"Wraith"}'`.
  - **The old agent is retired**: its Relay listener is removed and its identity released, it walks out of the office, and it is listed under *Alumni*.
  - **The successor inherits**: it takes the same role and desk, the old agent's memory notes, and every unfinished ticket the old agent owned.
  - **Work resumes over Relay**: for each ticket waiting on that role, the brain re-sends the current handoff over Relay to the new agent, using the same mechanism as a restart. The new engineer is briefed on the commits and uncommitted changes already on the branch and continues from them.
  - **The old agent's in-flight work is dropped**: if it is in the middle of an LLM call, the result is discarded, because every write, tool call and handoff first checks that the agent is still active. The event log says so.
- Limits: at most 8 active agents. Names must be 2–24 characters and agent ids are `[a-z][a-z0-9-]`. Ids are never reused. The Company actor checks all of this, so the API can't bypass it.
- Recorded runs:
  - `docs/hire-two-engineers-mock.log`: T17 → Casper and T18 → Ghoulia, both done.
  - `docs/replace-engineer-midflight-T19.log`: real model. Casper wrote `src/app.ts` and was then replaced; Wraith picked up the uncommitted change, added the test and shipped with tests passing.
  - Screenshots: `docs/office-two-engineers.jpg` and `docs/office-replace-reviewer.jpg`.

## Chat with the agents

The **Chat** card is collapsible. Pick one agent, several, or *everyone* using the chips, or click a character in the office, and send a message. You are the Relay identity `@boss`.
- **Transport:** every message is a real Relay DM to each recipient. It shows in the office as a bubble and in the event log, and each agent replies by Relay DM to `@boss`. API: `curl -XPOST localhost:4400/api/chat -H 'content-type: application/json' -d '{"to":["wraith"],"text":"what are you on?"}'` (`"to":["everyone"]` works too).
- **What the agent sees:** each replying agent makes one short LLM call (max 400 tokens, low reasoning, counted in the process token cap). The prompt carries its name, role, persona, memory notes, the tickets it is on and who holds each one's current stage, and the last few chat turns.
- **Group chats:** agents answer one after another, and each later agent sees the replies already given in that round. There is one round only, and agents never reply to other agents, so there are no chat loops.
- **Read-only:** no tools, no file writes, no ticket changes. An agent can answer while working on a ticket without disturbing it. A message containing "remember …" is saved word for word to the agent's durable memory notes; this is detected in code, not by the model.
- **History:** the last 50 turns per agent live in the Employee actor (`chat`) and survive a restart.
- **Guardrails:** 20 agent replies per minute, 1000-character messages, active agents only. A removed or replaced agent stops receiving and drops any reply it was still writing.
- **Mock mode:** scripted in-character replies.
- **Recorded:** `docs/chat-run-1.log` and `docs/office-chat-group.jpg`.

## Try the shipped app

When the engineer finishes, it makes one extra small LLM call, counted against the ticket's budget, to suggest 2–5 "try it" GET requests for that ticket. One of them must be a regression check. The links are stored on the Ticket actor (`tryLinks`) after they pass these checks in code:
- relative paths only (no scheme or host);
- at most 5;
- labels and expectations trimmed to 120 characters.

The ticket panel links each one to `/preview/T<n><path>`. *Run all* fetches each link and shows pass or fail when the expectation can be checked (`N items` or exact text in backticks). Otherwise it shows the status and the first 100 characters of the response. Example from the real model on T20 ("Filter pumpkins by spookiness"):
- `/pumpkins?spooky=true`: expects 2 items;
- `/pumpkins?spooky=false`: expects 1 item;
- `/pumpkins`: regression check, expects 3 items.

All three passed.

## Restart demo

While a ticket is running, kill everything (Ctrl+C on `start.sh`, or `pkill -f "terse actor dev"; pkill -f "bun src/main.ts"`). Then run `scripts/start.sh` again. The brain reads the Company actor, finds the unfinished tickets, and re-sends over Relay the message that drives each ticket's current stage. For example, a ticket that was `implementing` gets the PM's spec again, so it continues on the same branch and working copy. The UI reconnects on its own. The ticket panel shows "Resumed 1× after restart", the header shows the brain's boot counter (stored in the actor), and the full event log is still there. Recorded run: `docs/restart-resume-T3.log`, `docs/office-after-restart-resumed.jpg`.

## Guardrails (enforced in code)

- **File confinement** (`brain/src/workspace.ts`): every engineer path goes through `resolveInside()`, which rejects absolute paths, `..` traversal, `.git`, `node_modules`, and every symlink component. The mock engineer tries to write `../escape.txt` on purpose, and the event log shows it as `BLOCKED by guardrail`.
- **Done only if the tests pass**: `Ticket.markDone()` in the actor refuses unless the last recorded test run passed and fails the ticket instead. Before shipping, the PM reruns `bun test` itself. Failures end as `failed`, and the UI shows the reason.
- **Review loop cap**: 2 rounds by default. After the cap the ticket goes to final verification with the open notes attached.
- **LLM call budget and wall clock**: `Ticket.consumeLlmCall()` is checked before every LLM call. Separately, a durable **Terse alarm** on each Ticket fails it at its deadline, even if the brain is dead.
- Tests: `cd brain && bun test` (needs the actor server running). Covers traversal, absolute paths, symlink escapes, the LLM cap, the tests-must-pass gate, and the alarm firing.

## Layout

```
actor/src/actors.ts   Terse actors: Company, Employee, Ticket
brain/src/main.ts     boot, Relay agents, resume-after-restart, HTTP API + static UI
brain/src/roles.ts    PM / Engineer / Reviewer logic, OpenAI prompts, mock script
brain/src/relay.ts    Agent Relay: one AgentRelay instance per agent, token persistence, send+log, retire
brain/src/staff.ts    hire / replace: roster in the Company actor, inheritance, resume-on-replace
brain/src/workspace.ts per-ticket clone, confined file tools, tests, git, branch publish
ui/                   office canvas + panels; reads the actors over their own WebSockets
demo-repo/            Pumpkin Patch API (Bun) with a passing test suite
docs/                 recorded runs and screenshots
```

## Known limitations

- When a replaced agent's in-flight work is discarded, the LLM call it was making still counts against the ticket budget.
- A replaced engineer may already have written a file just before the switch. The successor sees it as uncommitted work and continues from it.
- Replacing an agent while it waits for an answer from the PM works: the answer is routed to the current owner. This path has not been exercised in a recorded run.
- In mock mode only the demo ticket (GET /health) produces a correct change. Custom tickets need a real key; in mock mode they end `failed` or produce the health change.
- Tests the engineer writes run unsandboxed on the host (`bun test` in the working copy). File tools are confined, but test code is not.
- If the brain dies while an LLM call is in flight, that work is redone on resume, so it can use some extra LLM budget.
- The deliverable is a local branch plus a diff, not a GitHub PR (`gh` is not installed).
- The browser gets short-lived socket URLs to the Terse actors from the brain (`/api/socket`). It talks to the actors directly but needs the brain up to (re)connect.
