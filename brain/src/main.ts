// The "brain": connects the office to Agent Relay, runs the role loops, resumes unfinished
// tickets after a restart, and serves the office UI plus a tiny API.
import fs from "node:fs"
import path from "node:path"
import { actors } from "../generated/index.js"
import { config, DEMO_TICKET, MOCK, PACE_MS, UI_DIR, WORKSPACES } from "./config"
import { resetTokens, resolveModel, tokenUsage } from "./llm"
import { connectAgent, send } from "./relay"
import { activeAgents, assignee, resumeTicket, STAGE_ROLE, systemPromptFor } from "./roles"
import { branchName } from "./workspace"
import { sendChat, HUMAN } from "./chat"
import { hire, loadRoster, remove, replace } from "./staff"

const company = actors.Company.get(config.companyId)
const ticketRef = (id: string) => actors.Ticket.get(`ticket-${id}`)

async function boot() {
    const bootCount = await company.boot()
    const model = await resolveModel()
    console.log(`Software Factory brain #${bootCount} | LLM: ${MOCK ? "MOCK (scripted, set OPENAI_API_KEY for real agents)" : model} | pace ${PACE_MS}ms`)
    await connectAgent("customer", async msg => {
        console.log(`  [customer] got ${msg.kind} for ${msg.ticketId}: ${msg.body.slice(0, 160)}`)
    })
    // The human chatting with agents is a Relay identity too; agents' replies arrive here as DMs.
    await connectAgent(HUMAN, async msg => console.log(`  [${HUMAN}] reply from @${msg.from}: ${msg.body.slice(0, 160)}`))
    // The office is rebuilt from the durable roster in the Company actor (anyone mid-walk goes back to their desk).
    await loadRoster()
    await company.log({
        ticketId: null,
        kind: "system",
        from: "factory",
        to: null,
        text: `Office opened (boot #${bootCount}, ${MOCK ? "mock LLM" : `model ${model}`}). Relay agents online: @customer ${[...activeAgents.values()].map(a => `@${a.id}`).join(" ")}`,
    })
}

/** Re-send the Relay message that drives each unfinished ticket's current stage. */
async function resumeUnfinished() {
    const { tickets } = await company.read()
    for (const s of tickets) {
        if (s.state === "done" || s.state === "failed") continue
        const t = await ticketRef(s.id).read()
        await company.log({ ticketId: s.id, kind: "system", from: "factory", to: null, text: `Resuming ${s.id} from state "${t.state}" after restart` })
        console.log(`Resuming ${s.id} (${t.state})`)
        await resumeTicket(s.id, "resumed after restart").catch(e => console.error(`resume ${s.id} failed`, e))
    }
}

export async function fileTicket(title: string, description: string, maxLlmCalls?: number) {
    title = title.trim().slice(0, 120)
    description = description.trim().slice(0, 4000)
    if (!title) throw new Error("title required")
    const id = await company.allocateTicketId()
    // Optional lower per-ticket call cap (testing/forcing failures); can only lower the configured cap.
    const limits = maxLlmCalls && maxLlmCalls > 0 ? { ...config.limits, maxLlmCalls: Math.min(Math.floor(maxLlmCalls), config.limits.maxLlmCalls) } : config.limits
    await ticketRef(id).create({ ticketId: id, title, description, limits })
    await company.log({ ticketId: id, kind: "system", from: "customer", to: null, text: `Filed ${id}: ${title}` })
    await send("customer", (await assignee(id, "pm")).id, id, "ticket", `${title}\n\n${description}`)
    return id
}

const retrying = new Set<string>()
/** Retry a failed ticket: from the stage it failed in (keeps spec/branch/commits/reviews) or from scratch (fresh clone + branch). */
async function retryTicket(id: string, mode: "resume" | "scratch") {
    if (retrying.has(id)) throw new Error(`a retry of ${id} is already starting`)
    retrying.add(id)
    try {
        const t = await ticketRef(id).read()
        if (!t.ticketId) throw new Error(`no ticket ${id}`)
        if (t.state !== "failed") throw new Error(`${id} is not failed (it is ${t.state}); nothing to retry`)
        const stage = mode === "scratch" ? "queued" : t.failedStage || "queued"
        const role = STAGE_ROLE[stage] ?? "pm"
        if (![...activeAgents.values()].some(a => a.role === role)) throw new Error(`no active ${role} in the office: hire one in the Team card, then retry`)
        let branch: string | undefined
        if (mode === "scratch") {
            fs.rmSync(path.join(WORKSPACES, id), { recursive: true, force: true }) // fresh clone of the current main
            branch = `${branchName(id, t.title)}-r${t.retries + 1}`
        }
        const r = await ticketRef(id).retry({ mode, limits: config.limits, branch })
        await resumeTicket(id, `retry ${r.retries}/${t.maxRetries} from ${r.from}`)
        return { id, ...r }
    } finally {
        retrying.delete(id)
    }
}

const SOCKET_ACTORS = new Set(["Company", "Employee", "Ticket"])

/** Live previews: each finished ticket's working copy runs as its own loopback server, reachable at /preview/T<n>/. */
const previews = new Map<string, { port: number; proc: ReturnType<typeof Bun.spawn> }>()
async function previewPort(id: string): Promise<number> {
    const existing = previews.get(id)
    if (existing) return existing.port
    const dir = path.join(WORKSPACES, id)
    if (!fs.existsSync(path.join(dir, "src", "index.ts"))) throw new Error(`no working copy for ${id}`)
    const port = 5100 + Number(id.slice(1)) % 800
    const proc = Bun.spawn(["bun", "src/index.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdout: "ignore", stderr: "ignore" })
    previews.set(id, { port, proc })
    for (let i = 0; i < 40; i++) {
        if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) return port
        await Bun.sleep(150)
    }
    throw new Error(`preview for ${id} did not start`)
}
process.on("exit", () => previews.forEach(p => p.proc.kill()))

async function serve() {
    Bun.serve({
        port: config.port,
        idleTimeout: 60,
        async fetch(req) {
            const url = new URL(req.url)
            try {
                if (url.pathname === "/api/config") {
                    return Response.json({ companyId: config.companyId, mock: MOCK, model: await resolveModel(), limits: config.limits })
                }
                if (url.pathname === "/api/socket") {
                    // Hands the browser a short-lived direct WebSocket URL to a Terse actor.
                    const actor = url.searchParams.get("actor") ?? ""
                    const id = url.searchParams.get("id") ?? ""
                    if (!SOCKET_ACTORS.has(actor) || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) return new Response("bad actor", { status: 400 })
                    const { websocketUrl } = await (actors as any)[actor].prepareWebsocket({ actorId: id, metadata: null })
                    return Response.json({ url: websocketUrl })
                }
                if (url.pathname === "/api/tickets" && req.method === "POST") {
                    const body = (await req.json()) as { title?: string; description?: string; demo?: boolean; maxLlmCalls?: number }
                    const t = body.demo ? DEMO_TICKET : { title: String(body.title ?? ""), description: String(body.description ?? "") }
                    return Response.json({ id: await fileTicket(t.title, t.description, Number(body.maxLlmCalls) || undefined) })
                }
                const rt = url.pathname.match(/^\/api\/tickets\/(T\d+)\/retry$/)
                if (rt && req.method === "POST") {
                    const body = (await req.json().catch(() => ({}))) as { mode?: string }
                    return Response.json(await retryTicket(rt[1]!, body.mode === "scratch" ? "scratch" : "resume"))
                }
                if (url.pathname === "/api/chat" && req.method === "POST") {
                    const body = (await req.json()) as { to?: unknown; text?: unknown }
                    return Response.json(await sendChat(body.to, body.text))
                }
                if (url.pathname === "/api/agents" && req.method === "POST") {
                    return Response.json(await hire((await req.json()) as Record<string, unknown>))
                }
                const rp = url.pathname.match(/^\/api\/agents\/([a-z][a-z0-9-]{1,23})\/replace$/)
                if (rp && req.method === "POST") {
                    return Response.json(await replace(rp[1]!, (await req.json()) as Record<string, unknown>))
                }
                if (url.pathname === "/api/tokens") {
                    if (req.method === "POST") resetTokens()
                    return Response.json(tokenUsage())
                }
                const pr = url.pathname.match(/^\/api\/agents\/([a-z][a-z0-9-]{1,23})\/prompt$/)
                if (pr && req.method === "GET") {
                    const a = activeAgents.get(pr[1]!)
                    return a ? Response.json({ prompt: systemPromptFor(a) }) : Response.json({ error: "not an active agent" }, { status: 404 })
                }
                const rm = url.pathname.match(/^\/api\/agents\/([a-z][a-z0-9-]{1,23})\/remove$/)
                if (rm && req.method === "POST") return Response.json(await remove(rm[1]!))
                const pv = url.pathname.match(/^\/preview\/(T\d+)(\/.*)?$/)
                if (pv) {
                    const port = await previewPort(pv[1]!)
                    return fetch(`http://127.0.0.1:${port}${pv[2] ?? "/"}${url.search}`, { method: req.method, headers: req.headers, body: req.body })
                }
                const tm = url.pathname.match(/^\/api\/tickets\/(T\d+)$/)
                if (tm) {
                    // Reading an actor that was never created returns defaults ("queued"); that is not a real ticket.
                    const t = await ticketRef(tm[1]!).read()
                    return t.ticketId ? Response.json(t) : Response.json({ error: `no ticket ${tm[1]}` }, { status: 404 })
                }
                // static UI
                const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
                const full = path.resolve(UI_DIR, rel)
                if (full.startsWith(UI_DIR + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) return new Response(Bun.file(full))
                return new Response("not found", { status: 404 })
            } catch (e) {
                console.error(e)
                const msg = (e as Error).message
                const userError = /not failed|retries|already starting|no active|no ticket|must be|rate limit|message required|already|not an active|office is full|invalid|required/.test(msg)
                return Response.json({ error: msg }, { status: userError ? 400 : 500 })
            }
        },
    })
    console.log(`Office UI: http://localhost:${config.port}`)
}

// Token cap warnings: one event-log line at 90% and one at 100%, re-armed once the counter drops (reset).
let tokenWarned: 0 | 90 | 100 = 0
setInterval(async () => {
    const { used, cap } = tokenUsage()
    const level = used >= cap ? 100 : used >= cap * 0.9 ? 90 : 0
    if (level < tokenWarned) tokenWarned = level as 0 | 90 | 100
    if (level > tokenWarned) {
        tokenWarned = level as 0 | 90 | 100
        const text = level === 100
            ? `Token cap reached (${used.toLocaleString()} / ${cap.toLocaleString()}). Running tickets will pause at their next LLM call; click "Reset tokens" in the header to continue.`
            : `Token usage is at 90% of the cap (${used.toLocaleString()} / ${cap.toLocaleString()}). Click "Reset tokens" in the header, or raise MAX_TOTAL_TOKENS.`
        await company.log({ ticketId: null, kind: "system", from: "factory", to: null, text }).catch(() => {})
    }
}, 3000)

await boot()
await serve()
await resumeUnfinished()
