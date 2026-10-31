// The office staff. Every agent (any number per role) reacts to Relay DMs addressed to its own
// identity, thinks with OpenAI (or the scripted mock), records durable state in Terse actors,
// and hands work on over Relay to the agent that owns the next step of the ticket.
import { actors } from "../generated/index.js"
import { config, MOCK, PACE_MS } from "./config"
import { chat, chatJson, type ChatMessage, type ToolDef } from "./llm"
import { send, oneLine, type AgentName, type Envelope } from "./relay"
import { branchName, PathEscapeError, Workspace } from "./workspace"
import { chatReply } from "./chat"

export type Role = "pm" | "engineer" | "reviewer"
export type Agent = { id: string; name: string; role: Role; persona: string }

const company = () => actors.Company.get(config.companyId)
const ticketRef = (id: string) => actors.Ticket.get(`ticket-${id}`)
export const emp = (agentId: string) => actors.Employee.get(`${config.companyId}-${agentId}`)

class Abort extends Error {}
/** Thrown when an agent was replaced while working: its in-flight result is discarded, never applied. */
class Superseded extends Error {}

/** Active agents by id, in hire order. Retired agents are removed, which stops their in-flight work at the next check. */
export const activeAgents = new Map<string, Agent>()

function alive(me: Agent) {
    if (!activeAgents.has(me.id)) throw new Superseded(`${me.name} was replaced`)
}

const who = (me: Agent) => `You are ${me.name}${me.persona ? ` (persona: ${me.persona})` : ""}.`

// Serialises assignment so two tickets handed off at once cannot both pick the same "least busy" agent.
let assignLock: Promise<unknown> = Promise.resolve()

/** The agent that owns `role` on this ticket. Picks the least busy active agent of that role when unowned (or owner retired). */
export async function assignee(ticketId: string, role: Role): Promise<Agent> {
    const run = assignLock.then(async () => {
        const t = await ticketRef(ticketId).read()
        const cur = t.assignees?.[role]
        if (cur && activeAgents.has(cur)) return activeAgents.get(cur)!
        const candidates = [...activeAgents.values()].filter(a => a.role === role)
        if (!candidates.length) throw new Abort(`no active ${role} in the office: hire one in the Team card, then Retry`)
        const load = new Map<string, number>(candidates.map(a => [a.id, 0]))
        const { tickets } = await company().read()
        for (const s of tickets) {
            if (s.state === "done" || s.state === "failed" || s.id === ticketId) continue
            const owner = (await ticketRef(s.id).read()).assignees?.[role]
            if (owner && load.has(owner)) load.set(owner, load.get(owner)! + 1)
        }
        const pick = candidates.reduce((best, a) => (load.get(a.id)! < load.get(best.id)! ? a : best))
        await ticketRef(ticketId).assign(role, pick.id)
        if (cur && cur !== pick.id) await log(ticketId, "system", "factory", `${ticketId} ${role} work reassigned to ${pick.name}`)
        return pick
    })
    assignLock = run.catch(() => {})
    return run
}

async function log(ticketId: string | null, kind: "status" | "tool" | "system", from: string, text: string) {
    console.log(`  [${kind}] ${from}: ${oneLine(text, 160)}`)
    await company().log({ ticketId, kind, from, to: null, text: text.slice(0, 2000) })
}

async function status(me: Agent, s: "idle" | "thinking" | "working" | "walking" | "waiting", task?: string) {
    alive(me)
    await emp(me.id).setStatus(s, task)
}

async function walk(me: Agent, to: string) {
    await status(me, "walking")
    await emp(me.id).moveTo(to)
    await Bun.sleep(PACE_MS)
}

/** Walk to the recipient's desk, deliver the message over Relay, walk back. `to` is a role (routed to its owner) or "customer". */
async function handoff(me: Agent, to: Role | "customer", ticketId: string, kind: Parameters<typeof send>[3], body: string, toAgent?: string) {
    alive(me)
    const target: AgentName = to === "customer" ? "customer" : toAgent && activeAgents.has(toAgent) ? toAgent : (await assignee(ticketId, to)).id
    if (target !== "customer") await walk(me, target)
    alive(me) // replaced while walking: drop the handoff, the replacement re-sends it
    await send(me.id, target, ticketId, kind, body)
    await emp(me.id).bump("messagesSent")
    await Bun.sleep(PACE_MS)
    if (!activeAgents.has(me.id)) return
    await walk(me, "desk")
    await status(me, "idle", "")
}

/** Guardrail gate before every LLM call: per-ticket call budget + wall clock (enforced in the Ticket actor). */
async function budget(ticketId: string, me: Agent) {
    alive(me)
    const ok = await ticketRef(ticketId).consumeLlmCall()
    if (!ok) throw new Abort("ticket budget exhausted or ticket already finished")
    await emp(me.id).bump("llmCalls")
}

async function stillActive(ticketId: string) {
    const t = await ticketRef(ticketId).read()
    return t.state !== "done" && t.state !== "failed"
}

async function guard(ticketId: string, me: Agent, fn: () => Promise<void>) {
    try {
        if (!(await stillActive(ticketId))) return
        // Ownership: only the agent assigned to this role on the ticket may act on it.
        const owner = (await ticketRef(ticketId).read()).assignees?.[me.role]
        if (owner && owner !== me.id && activeAgents.has(owner)) return
        if (!owner) await ticketRef(ticketId).assign(me.role, me.id)
        await fn()
    } catch (e) {
        if (e instanceof Superseded) {
            await log(ticketId, "system", "factory", `${me.name}'s in-flight work on ${ticketId} was discarded (replaced)`)
            return
        }
        const raw = (e as Error).message
        const reason = /token ceiling/.test(raw)
            ? `Process-wide token ceiling reached (MAX_TOTAL_TOKENS). Run scripts/reset-tokens.sh (or click "Reset tokens"), then Retry.`
            : e instanceof Abort ? raw : `${me.name} (${me.role}) crashed: ${raw}`
        console.error(`[${me.id}] ${ticketId}:`, e)
        await ticketRef(ticketId).fail(reason)
        if (activeAgents.has(me.id)) {
            await emp(me.id).setStatus("idle", "")
            await emp(me.id).moveTo("desk")
        }
    }
}

/** Route a Relay DM to the right behaviour for this agent's role. */
export function handlerFor(me: Agent) {
    return (msg: Envelope) => (msg.kind === "chat" ? chatReply(me, msg) : me.role === "pm" ? pmHandle(me, msg) : me.role === "engineer" ? engineerHandle(me, msg) : reviewerHandle(me, msg))
}

/** Re-send the Relay message that drives a ticket's current stage to whoever owns that stage now. */
export async function resumeTicket(id: string, why: string) {
    const t = await ticketRef(id).read()
    if (t.state === "done" || t.state === "failed") return
    await ticketRef(id).noteResume()
    const last = t.reviews[t.reviews.length - 1]
    const senderFor = async (role: Role) => {
        const owner = t.assignees?.[role]
        if (owner && activeAgents.has(owner)) return owner
        return [...activeAgents.values()].find(a => a.role === role)?.id ?? "customer"
    }
    const to = async (role: Role) => (await assignee(id, role)).id
    switch (t.state) {
        case "queued":
        case "speccing":
            return send("customer", await to("pm"), id, "ticket", `${t.title}\n\n${t.description}`)
        case "implementing":
            return send(await senderFor("pm"), await to("engineer"), id, "spec", `${t.spec || t.description}\n\n(${why})`)
        case "fixing":
            return send(await senderFor("reviewer"), await to("engineer"), id, "changes", `${last?.comments ?? "Please re-check your change."}\n\n(${why})`)
        case "reviewing":
            return send(await senderFor("engineer"), await to("reviewer"), id, "review_request", `Round ${t.reviews.length + 1} (${why}).`)
        case "verifying":
            return send(await senderFor("reviewer"), await to("pm"), id, "approved", last?.comments ?? "approved")
    }
}

/** Which role is doing the work in each ticket state. */
export const STAGE_ROLE: Record<string, Role | undefined> = { queued: "pm", speccing: "pm", implementing: "engineer", fixing: "engineer", reviewing: "reviewer", verifying: "pm" }

// ---------------------------------------------------------------- PM

const PM_SYSTEM = `You are the product manager in a tiny AI software team. You turn a customer ticket into a crisp engineering spec for a small Bun + TypeScript HTTP app (src/app.ts exports handle(req: Request): Response; tests live in test/*.test.ts and run with "bun test").
The repo already contains all previously shipped tickets. If the ticket mentions something that does not exist yet, spec it as new work instead of refusing.
Respond with JSON: {"spec": "<concise spec with acceptance criteria as bullet points>", "plan": ["<step>", ...] (3-5 short steps)}.`

export async function pmHandle(me: Agent, msg: Envelope) {
    const id = msg.ticketId
    if (msg.kind === "ticket") {
        await guard(id, me, async () => {
            const t = await ticketRef(id).read()
            await ticketRef(id).setState("speccing")
            await emp(me.id).bump("ticketsTouched")
            await status(me, "thinking", `${id}: writing spec`)
            await emp(me.id).moveTo("whiteboard")
            await budget(id, me)
            let spec: string, plan: string[]
            if (MOCK) {
                await Bun.sleep(PACE_MS)
                ;({ spec, plan } = mockSpec(t.title, t.description))
            } else {
                const r = await chatJson<{ spec: string; plan: string[] }>(`${who(me)} ${PM_SYSTEM}`, `Ticket ${id}: ${t.title}\n\n${t.description}`)
                alive(me)
                spec = String(r.spec ?? "")
                plan = Array.isArray(r.plan) ? r.plan.map(String) : []
            }
            await ticketRef(id).setSpec(spec, plan)
            await emp(me.id).remember(`${id}: specced "${t.title}"`)
            await handoff(me, "engineer", id, "spec", `${spec}\n\nPlan:\n${plan.map((p, i) => `${i + 1}. ${p}`).join("\n")}`)
        })
    } else if (msg.kind === "question") {
        await guard(id, me, async () => {
            await status(me, "thinking", `${id}: answering a question`)
            await budget(id, me)
            const t = await ticketRef(id).read()
            const answer = MOCK
                ? "Keep it minimal: 200 with {\"status\":\"ok\"} and a JSON content-type. Anything other than GET can fall through to the existing 404."
                : (
                      await chat([
                          { role: "system", content: `${who(me)} You are the PM. Answer the engineer's question in 1-3 sentences, consistent with the spec. Be decisive.` },
                          { role: "user", content: `Spec:\n${t.spec}\n\nQuestion: ${msg.body}` },
                      ])
                  ).content ?? "Use your best judgement and keep it minimal."
            alive(me)
            await handoff(me, "engineer", id, "answer", answer, msg.from)
        })
    } else if (msg.kind === "approved") {
        await guard(id, me, () => pmVerifyAndShip(me, id, msg.body))
    }
}

/** Final gate, enforced in code: rerun the tests ourselves; only a green run can mark the ticket done. */
async function pmVerifyAndShip(me: Agent, id: string, reviewNote: string) {
    await ticketRef(id).setState("verifying")
    await status(me, "working", `${id}: verifying tests before shipping`)
    const t = await ticketRef(id).read()
    const ws = new Workspace(id, t.branch)
    await ws.prepare()
    const tests = await ws.runTests()
    const diff = await ws.diff()
    await ticketRef(id).recordBuild({ diff, testOutput: tests.output, testsPassed: tests.passed })
    alive(me)
    await log(id, "status", me.id, `final test run: ${tests.passed ? "PASS" : "FAIL"}`)
    if (!diff.trim()) {
        await ticketRef(id).fail(`no code changes were produced: the branch has no diff against the base it was cloned from. Last review note: ${oneLine(reviewNote, 300)}`)
    } else if (!tests.passed) {
        await ticketRef(id).fail(`final test run failed:\n${tests.output.slice(-800)}`)
    } else {
        const where = await ws.publishBranch()
        const merged = await ws.integrateIntoMain()
        await log(id, "system", me.id, `branch published: ${where}; ${merged.detail}`)
        await ticketRef(id).markDone()
    }
    const final = await ticketRef(id).read()
    await emp(me.id).remember(`${id}: ${final.state}`)
    await handoff(
        me,
        "customer",
        id,
        final.state === "done" ? "shipped" : "failed",
        final.state === "done" ? `Shipped "${final.title}" on branch ${final.branch}. Reviewer: ${oneLine(reviewNote, 200)}` : `Could not ship: ${final.failureReason}`,
    )
}

// ---------------------------------------------------------------- Engineer

const ENGINEER_TOOLS: ToolDef[] = [
    { type: "function", function: { name: "list_files", description: "List all files in the repo.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    { type: "function", function: { name: "read_file", description: "Read a repo file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Create or overwrite a repo file with the full new contents.",
            parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
        },
    },
    { type: "function", function: { name: "run_tests", description: "Run the test suite (bun test).", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    {
        type: "function",
        function: {
            name: "ask_pm",
            description: "Ask the PM a clarifying question (use sparingly, at most once).",
            parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
        },
    },
    {
        type: "function",
        function: {
            name: "finish",
            description: "Call when the change is complete and tests pass.",
            parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
        },
    },
]

const ENGINEER_SYSTEM = `You are a careful software engineer. You work in a small Bun + TypeScript repo via tools only.
Rules: read the relevant files before editing; write complete file contents; keep changes minimal and idiomatic; always add or update tests in test/; run_tests and make them pass before calling finish. Do not touch package.json unless needed.`

const pendingAnswers = new Map<string, (answer: string) => void>()

export async function engineerHandle(me: Agent, msg: Envelope) {
    const id = msg.ticketId
    if (msg.kind === "answer") {
        pendingAnswers.get(id)?.(msg.body)
        pendingAnswers.delete(id)
        return
    }
    if (msg.kind !== "spec" && msg.kind !== "changes") return
    await guard(id, me, async () => {
        const t = await ticketRef(id).read()
        const fixing = msg.kind === "changes"
        await ticketRef(id).setState(fixing ? "fixing" : "implementing")
        await emp(me.id).bump("ticketsTouched")
        const branch = t.branch || branchName(id, t.title)
        if (!t.branch) await ticketRef(id).setBranch(branch)
        const ws = new Workspace(id, branch)
        await ws.prepare()
        await status(me, "working", `${id}: ${fixing ? "addressing review" : "implementing"} on ${branch}`)

        // Taking over (after a replacement or restart): brief the engineer on the work already on the branch so it continues, not restarts.
        const committed = t.commits.length ? `Commits already on ${branch}: ${t.commits.join(", ")}.\nDiff vs main so far:\n${(await ws.diff()).slice(0, 4000)}\n` : ""
        const dirty = await ws.statusShort()
        const takeover = committed || dirty ? `\n\nWORK ALREADY IN PROGRESS on this branch (continue from it, do not start over; read the files before changing them):\n${committed}${dirty ? `Uncommitted changes:\n${dirty}\n` : ""}` : ""
        if (takeover) await log(id, "status", me.id, `${me.name} picks up existing work on ${branch}${t.commits.length ? ` (${t.commits.length} commits)` : ""}${dirty ? " + uncommitted changes" : ""}`)

        const task = fixing
            ? `Ticket ${id}: ${t.title}\n\nSpec:\n${t.spec}\n\nThe reviewer requested changes:\n${msg.body}\n\nAddress every comment, keep tests green, then call finish.`
            : `Ticket ${id}: ${t.title}\n\nSpec from the PM:\n${msg.body}\n\nImplement it with tests, then call finish.`
        let summary = MOCK ? await mockEngineer(me, id, ws, fixing) : await engineerLoop(me, id, ws, task + takeover)
        alive(me)
        // Guardrail: finishing without changing any file is sent back once with an explicit instruction, then fails with the engineer's own words.
        const hasChanges = async () => !!(await ws.statusShort()) || !!(await ws.diff()).trim()
        if (!(await hasChanges())) {
            await log(id, "system", me.id, `${me.name} finished without changing any file ("${oneLine(summary, 160)}"); sending back once`)
            if (!MOCK)
                summary = await engineerLoop(me, id, ws, `${task}${takeover}\n\nYou previously finished WITHOUT changing any file, saying: "${oneLine(summary, 400)}". That is not acceptable: the ticket asks for a change. Make a concrete, minimal change to the code that satisfies the spec (create the file or route if it does not exist yet), add or update tests, run them, then call finish.`)
            alive(me)
            if (!(await hasChanges())) throw new Abort(`engineer made no code changes after being asked twice. ${me.name} said: "${oneLine(summary, 300)}"`)
        }

        const tests = await ws.runTests()
        if (!tests.passed) {
            await ticketRef(id).recordBuild({ diff: await ws.diffUncommitted(), testOutput: tests.output, testsPassed: false })
            throw new Abort(`engineer could not get tests passing:\n${tests.output.slice(-600)}`)
        }
        const sha = await ws.commit(`${id}: ${fixing ? "address review feedback" : t.title}\n\n${summary}`)
        const diff = await ws.diff()
        await ticketRef(id).recordBuild({ diff, testOutput: tests.output, testsPassed: true, commit: sha ?? undefined })
        await log(id, "status", me.id, `tests PASS, commit ${sha ?? "(no changes)"} on ${branch}`)
        await emp(me.id).remember(`${id}: ${oneLine(summary, 80)}`)
        await suggestTryLinks(me, id, diff).catch(e => {
            if (e instanceof Superseded || e instanceof Abort) throw e
            console.warn(`[${me.id}] try links skipped:`, (e as Error).message)
        })
        const stat = diff.split("\n").filter(l => l.startsWith("+++ ")).map(l => l.slice(6)).join(", ")
        await handoff(me, "reviewer", id, "review_request", `Round ${t.reviews.length + 1}: ${summary}\nFiles: ${stat}\nTests: passing.`)
    })
}

async function execTool(me: Agent, id: string, ws: Workspace, name: string, args: any): Promise<string> {
    alive(me) // a replaced engineer never touches the working copy again
    try {
        switch (name) {
            case "list_files":
                return ws.listFiles().join("\n")
            case "read_file":
                return ws.readFile(String(args.path))
            case "write_file":
                await log(id, "tool", me.id, `write_file ${args.path}`)
                return ws.writeFile(String(args.path), String(args.content ?? ""))
            case "run_tests": {
                await log(id, "tool", me.id, "run_tests")
                const r = await ws.runTests()
                await log(id, "tool", me.id, `tests ${r.passed ? "PASS" : "FAIL"}`)
                return `${r.passed ? "PASS" : "FAIL"}\n${r.output}`
            }
            case "ask_pm": {
                await status(me, "waiting", `${id}: waiting on PM`)
                const answer = new Promise<string>(resolve => {
                    pendingAnswers.set(id, resolve)
                    setTimeout(() => resolve("(no answer within 90s; use your best judgement)"), 90_000)
                })
                await handoff(me, "pm", id, "question", String(args.question))
                const a = await answer
                await status(me, "working", `${id}: back to work`)
                return a
            }
            default:
                return `unknown tool ${name}`
        }
    } catch (e) {
        if (e instanceof Superseded) throw e
        if (e instanceof PathEscapeError) await log(id, "tool", me.id, `BLOCKED by guardrail: ${e.message}`)
        return `ERROR: ${(e as Error).message}`
    }
}

async function engineerLoop(me: Agent, id: string, ws: Workspace, task: string): Promise<string> {
    const messages: ChatMessage[] = [
        { role: "system", content: `${who(me)} ${ENGINEER_SYSTEM}` },
        { role: "user", content: `${task}\n\nRepo files:\n${ws.listFiles().join("\n")}` },
    ]
    for (let step = 0; step < config.maxEngineerSteps; step++) {
        if (!(await stillActive(id))) throw new Abort("ticket stopped")
        await budget(id, me)
        const reply = await chat(messages, { tools: ENGINEER_TOOLS })
        alive(me) // replaced during the LLM call: discard this result
        messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: reply.tool_calls })
        if (!reply.tool_calls?.length) {
            messages.push({ role: "user", content: "Use the tools. Call finish when tests pass." })
            continue
        }
        for (const call of reply.tool_calls) {
            let args: any = {}
            try {
                args = JSON.parse(call.function.arguments || "{}")
            } catch {}
            if (call.function.name === "finish") {
                const r = await ws.runTests()
                if (r.passed) return String(args.summary ?? "done")
                messages.push({ role: "tool", tool_call_id: call.id, content: `Cannot finish: tests fail.\n${r.output}` })
                continue
            }
            const result = await execTool(me, id, ws, call.function.name, args)
            messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 12_000) })
        }
    }
    throw new Abort(`engineer hit the ${config.maxEngineerSteps}-step cap`)
}

// ---------------------------------------------------------------- "Try it" links

const TRY_SYSTEM = `You suggest 2-5 HTTP GET requests a human can click to try the change in a running copy of this Bun HTTP app.
Respond with JSON: {"links": [{"path": "/pumpkins?spooky=true", "label": "only spooky pumpkins", "expect": "2 items; contains \`\"name\":\"Jack\"\`"}]}.
Rules: GET only; path starts with "/" (no scheme or host); include at least one regression link that checks existing behaviour still works (e.g. "/pumpkins" still returns all 3).
In "expect", write "N items" when the response is a JSON array of N items, and put any exact text the body must contain in backticks (compact JSON, no spaces).`

/** Keep only safe, relative GET paths: enforced in code (and again in the Ticket actor). */
export function sanitizeTryLinks(raw: unknown) {
    const list = Array.isArray(raw) ? raw : []
    return list
        .map((l: any) => ({ path: String(l?.path ?? "").trim(), label: String(l?.label ?? "").trim().slice(0, 120), expect: String(l?.expect ?? "").trim().slice(0, 120) }))
        .filter(l => l.path.startsWith("/") && !l.path.startsWith("//") && !/^\/*[a-z][a-z0-9+.-]*:/i.test(l.path) && !/\s/.test(l.path) && l.path.length <= 200)
        .slice(0, 5)
}

async function suggestTryLinks(me: Agent, id: string, diff: string) {
    const t = await ticketRef(id).read()
    let links
    if (MOCK) {
        links = [
            { path: "/health", label: "new health check", expect: "contains `{\"status\":\"ok\"}`" },
            { path: "/pumpkins", label: "regression: all pumpkins still listed", expect: "3 items" },
            { path: "/pumpkins/2", label: "regression: one pumpkin by id", expect: "contains `\"name\":\"Gourdon\"`" },
        ]
    } else {
        await budget(id, me) // one small call, counted against the ticket budget
        const r = await chatJson<{ links?: unknown }>(TRY_SYSTEM, `Ticket: ${t.title}\n\nSpec:\n${t.spec.slice(0, 3000)}\n\nDiff:\n${diff.slice(0, 12_000)}`)
        alive(me)
        links = r.links
    }
    const clean = await ticketRef(id).setTryLinks(sanitizeTryLinks(links))
    await log(id, "status", me.id, `try-it links: ${clean.map(l => l.path).join(", ") || "none"}`)
}

// ---------------------------------------------------------------- Reviewer

const REVIEWER_SYSTEM = `You are a strict but pragmatic code reviewer. Review the diff against the spec.
Respond with JSON: {"verdict": "approve" | "request_changes", "comments": "<short actionable bullet list, or a one-line approval note>"}.
Only request changes for real problems (missing acceptance criteria, missing tests, bugs). Approve otherwise.`

export async function reviewerHandle(me: Agent, msg: Envelope) {
    if (msg.kind !== "review_request") return
    const id = msg.ticketId
    await guard(id, me, async () => {
        await ticketRef(id).setState("reviewing")
        const t = await ticketRef(id).read()
        await status(me, "thinking", `${id}: reviewing round ${t.reviews.length + 1}`)
        await budget(id, me)
        let verdict: "approve" | "request_changes", comments: string
        if (MOCK) {
            await Bun.sleep(PACE_MS)
            ;({ verdict, comments } = mockReview(t.reviews.length, t.title))
        } else {
            const r = await chatJson<{ verdict: string; comments: string }>(
                `${who(me)} ${REVIEWER_SYSTEM}`,
                `Spec:\n${t.spec}\n\nEngineer note:\n${msg.body}\n\nDiff:\n${t.diff.slice(0, 40_000)}\n\nTest output (tail):\n${t.testOutput.slice(-1500)}`,
            )
            verdict = r.verdict === "request_changes" ? "request_changes" : "approve"
            comments = String(r.comments ?? "")
        }
        alive(me)
        const round = await ticketRef(id).addReview(verdict, comments)
        await emp(me.id).remember(`${id} round ${round}: ${verdict}`)
        // Guardrail: review loop capped in code at limits.maxReviewRounds.
        if (verdict === "request_changes" && round - (t.reviewOffset ?? 0) < t.limits.maxReviewRounds) {
            await handoff(me, "engineer", id, "changes", comments)
        } else {
            const note = verdict === "approve" ? comments : `Review cap (${t.limits.maxReviewRounds} rounds) reached; shipping with open notes: ${comments}`
            if (verdict !== "approve") await log(id, "system", me.id, `review cap of ${t.limits.maxReviewRounds} rounds reached`)
            await handoff(me, "pm", id, "approved", note)
        }
    })
}

// ---------------------------------------------------------------- Mock (no OPENAI_API_KEY)

function mockSpec(title: string, description: string) {
    return {
        spec: `[mock LLM] ${title}\n${description}\nAcceptance criteria:\n- GET /health returns 200 with JSON {"status":"ok"}\n- Response has content-type application/json\n- Existing routes and tests keep passing\n- New tests cover the endpoint`,
        plan: ["Read src/app.ts to see the routing style", "Add a GET /health branch to handle()", "Add test/health.test.ts", "Run bun test"],
    }
}

function mockReview(previousRounds: number, _title: string) {
    if (previousRounds === 0)
        return {
            verdict: "request_changes" as const,
            comments: "[mock LLM] Looks good overall. Please (1) assert the content-type header is application/json in the test, and (2) add a test that POST /health is not handled (404).",
        }
    return { verdict: "approve" as const, comments: "[mock LLM] LGTM. Endpoint, headers and negative case are covered. Ship it." }
}

async function mockEngineer(me: Agent, id: string, ws: Workspace, fixing: boolean): Promise<string> {
    const step = async (name: string, args: any = {}) => {
        await budget(id, me)
        await Bun.sleep(Math.round(PACE_MS / 2))
        return execTool(me, id, ws, name, args)
    }
    if (!fixing) {
        await step("list_files")
        const app = await step("read_file", { path: "src/app.ts" })
        await step("ask_pm", { question: "[mock LLM] Should /health be GET-only, and what should other methods return?" })
        const patched = app.includes('"/health"')
            ? app
            : app.replace(
                  `  if (req.method === "GET" && url.pathname === "/pumpkins") {`,
                  `  if (req.method === "GET" && url.pathname === "/health") {\n    return json({ status: "ok" })\n  }\n\n  if (req.method === "GET" && url.pathname === "/pumpkins") {`,
              )
        await step("write_file", { path: "src/app.ts", content: patched })
        // Demonstrates the path guardrail: this write is refused and logged.
        await step("write_file", { path: "../escape.txt", content: "should never be written" })
        await step("write_file", {
            path: "test/health.test.ts",
            content: `import { expect, test } from "bun:test"\nimport { handle } from "../src/app"\n\ntest("GET /health returns ok", async () => {\n  const res = handle(new Request("http://localhost/health"))\n  expect(res.status).toBe(200)\n  expect(await res.json()).toEqual({ status: "ok" })\n})\n`,
        })
        await step("run_tests")
        return "[mock LLM] Added GET /health returning {status:'ok'} plus a test."
    }
    await step("read_file", { path: "test/health.test.ts" })
    await step("write_file", {
        path: "test/health.test.ts",
        content: `import { describe, expect, test } from "bun:test"\nimport { handle } from "../src/app"\n\ndescribe("GET /health", () => {\n  test("returns ok as JSON", async () => {\n    const res = handle(new Request("http://localhost/health"))\n    expect(res.status).toBe(200)\n    expect(res.headers.get("content-type")).toBe("application/json")\n    expect(await res.json()).toEqual({ status: "ok" })\n  })\n\n  test("POST /health is not handled", () => {\n    const res = handle(new Request("http://localhost/health", { method: "POST" }))\n    expect(res.status).toBe(404)\n  })\n})\n`,
    })
    await step("run_tests")
    return "[mock LLM] Addressed review: content-type assertion and POST /health 404 test."
}

/** The system prompt an agent works under for its role (shown in the agent profile). */
export function systemPromptFor(me: Agent) {
    const base = me.role === "pm" ? PM_SYSTEM : me.role === "engineer" ? ENGINEER_SYSTEM : REVIEWER_SYSTEM
    return `${who(me)} ${base}`
}
