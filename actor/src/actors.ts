import { Actor, Emittable, Persisted, type ActorSocket } from "terse-sdk/actor"

// ---------- shared shapes ----------

export type Role = "pm" | "engineer" | "reviewer"

export type FactoryEvent = {
    id: number
    ts: number
    ticketId: string | null
    /** relay = an inter-agent message that went over Agent Relay */
    kind: "relay" | "status" | "tool" | "system" | "result" | "staff"
    from: string
    to: string | null
    text: string
}

export type TicketSummary = { id: string; title: string; state: TicketState; updatedAt: number }

export type TicketState =
    | "queued"
    | "speccing"
    | "implementing"
    | "reviewing"
    | "fixing"
    | "verifying"
    | "done"
    | "failed"

export const TERMINAL: TicketState[] = ["done", "failed"]

export type ReviewRound = { round: number; verdict: "approve" | "request_changes"; comments: string; ts: number }

const MAX_EVENTS = 400

/** One person in the office. Retired entries stay in the roster so their history remains visible. */
export type RosterEntry = {
    id: string
    name: string
    role: Role
    persona: string
    status: "active" | "retired"
    desk: number
    hiredAt: number
    retiredAt: number
    replaces: string
    replacedBy: string
}

export const MAX_ACTIVE_AGENTS = 8
export const DESK_SLOTS = 8
const AGENT_ID = /^[a-z][a-z0-9-]{1,23}$/
const AGENT_NAME = /^[A-Za-z][A-Za-z0-9 '_-]{1,23}$/
const RESERVED_IDS = ["customer", "factory", "desk", "whiteboard", "exit"]

const DEFAULT_ROSTER: RosterEntry[] = [
    { id: "pm", name: "Pumpkin", role: "pm", persona: "", status: "active", desk: 0, hiredAt: 0, retiredAt: 0, replaces: "", replacedBy: "" },
    { id: "reviewer", name: "Mortimer", role: "reviewer", persona: "", status: "active", desk: 3, hiredAt: 0, retiredAt: 0, replaces: "", replacedBy: "" },
    { id: "engineer", name: "Casper", role: "engineer", persona: "", status: "active", desk: 5, hiredAt: 0, retiredAt: 0, replaces: "", replacedBy: "" },
]

// ---------- Company: roster, ticket queue, event log ----------

export class Company extends Actor<null, { type: "ping" }> {
    @Persisted @Emittable name = "Software Factory"
    @Persisted @Emittable roster: RosterEntry[] = DEFAULT_ROSTER
    @Persisted @Emittable tickets: TicketSummary[] = []
    @Persisted @Emittable events: FactoryEvent[] = []
    @Persisted @Emittable bootCount = 0
    @Persisted nextTicket = 1
    @Persisted nextEvent = 1

    async read() {
        return { name: this.name, roster: this.roster, tickets: this.tickets, events: this.events, bootCount: this.bootCount }
    }

    /** Migrates the old fixed three-person roster to the dynamic one. Idempotent. */
    async ensureRoster() {
        const ok = this.roster.length > 0 && this.roster.every(r => typeof (r as Partial<RosterEntry>).role === "string" && typeof (r as Partial<RosterEntry>).desk === "number")
        if (!ok) this.roster = DEFAULT_ROSTER
        return this.roster
    }

    /** Hire: validated here, at the durable boundary. Returns the new entry (with its desk slot). */
    async hire(input: { id: string; name: string; role: Role; persona: string; replaces?: string }) {
        if (!AGENT_ID.test(input.id) || RESERVED_IDS.includes(input.id)) throw new Error(`invalid agent id "${input.id}"`)
        if (!AGENT_NAME.test(input.name)) throw new Error("name must be 2-24 letters, digits, spaces, ' _ -, starting with a letter")
        if (!["pm", "engineer", "reviewer"].includes(input.role)) throw new Error("role must be pm, engineer or reviewer")
        if (this.roster.some(r => r.id === input.id)) throw new Error(`an agent with id "${input.id}" already exists (ids are never reused)`)
        if (this.roster.some(r => r.status === "active" && r.name.toLowerCase() === input.name.toLowerCase())) throw new Error(`${input.name} already works here`)
        const active = this.roster.filter(r => r.status === "active")
        if (active.length >= MAX_ACTIVE_AGENTS) throw new Error(`the office is full (${MAX_ACTIVE_AGENTS} active agents max)`)
        const taken = new Set(active.map(r => r.desk))
        let desk = 0
        while (taken.has(desk) && desk < DESK_SLOTS) desk++
        const entry: RosterEntry = {
            id: input.id,
            name: input.name,
            role: input.role,
            persona: String(input.persona ?? "").slice(0, 200),
            status: "active",
            desk,
            hiredAt: Date.now(),
            retiredAt: 0,
            replaces: input.replaces ?? "",
            replacedBy: "",
        }
        this.roster = [...this.roster, entry]
        return entry
    }

    async retire(id: string, replacedBy: string) {
        const cur = this.roster.find(r => r.id === id)
        if (!cur || cur.status !== "active") throw new Error(`${id} is not an active agent`)
        this.roster = this.roster.map(r => (r.id === id ? { ...r, status: "retired" as const, retiredAt: Date.now(), replacedBy, desk: -1 } : r))
        return true
    }

    /** Called by the brain on every start; proves persistence across restarts. */
    async boot() {
        this.bootCount = this.bootCount + 1
        return this.bootCount
    }

    async allocateTicketId() {
        const id = `T${this.nextTicket}`
        this.nextTicket = this.nextTicket + 1
        return id
    }

    async upsertTicket(summary: TicketSummary) {
        const rest = this.tickets.filter(t => t.id !== summary.id)
        this.tickets = [...rest, summary].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
    }

    async log(ev: Omit<FactoryEvent, "id" | "ts"> & { ts?: number }) {
        const full: FactoryEvent = { ...ev, id: this.nextEvent, ts: ev.ts ?? Date.now() }
        this.nextEvent = this.nextEvent + 1
        const next = [...this.events, full]
        this.events = next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
        return full.id
    }

    async reset() {
        this.tickets = []
        this.events = []
        // Ticket actors persist across resets, so never reuse an id: a reused id lands on an old finished ticket and is silently ignored.
        this.nextTicket = Math.max(this.nextTicket, 10)
        this.nextEvent = 1
    }

    async onMessage(_socket: ActorSocket<null, { type: "ping" }>, _message: { type: "ping" }) {}
}

// ---------- Employee: role, status, task, notes, position ----------

export type Spot = "desk" | "pm" | "engineer" | "reviewer" | "whiteboard" | "coffee"

export class Employee extends Actor<null, { type: "ping" }> {
    @Persisted @Emittable role: Role | "" = ""
    @Persisted @Emittable displayName = ""
    @Persisted @Emittable status: "idle" | "thinking" | "working" | "walking" | "waiting" | "retired" = "idle"
    @Persisted @Emittable persona = ""
    @Persisted @Emittable currentTask = ""
    /** "desk", "whiteboard", "exit", or the id of a colleague being visited. */
    @Persisted @Emittable location: string = "desk"
    @Persisted @Emittable notes: string[] = []
    @Persisted @Emittable stats = { ticketsTouched: 0, messagesSent: 0, llmCalls: 0 }
    /** Direct chat with the human (last 50 turns). `group` lists every agent the human's message went to. */
    @Persisted @Emittable chat: { ts: number; from: string; text: string; group: string[] }[] = []

    async init(role: Role, displayName: string, persona?: string) {
        if (!this.role) {
            this.role = role
            this.displayName = displayName
            this.persona = persona ?? ""
        }
        return this.read()
    }

    /** A replacement inherits the predecessor's memory. */
    async inherit(notes: string[], from: string) {
        const next = [...notes, `Took over from ${from}`]
        this.notes = next.length > 20 ? next.slice(next.length - 20) : next
    }

    async addChat(turn: { from: string; text: string; group: string[] }) {
        const next = [...this.chat, { ts: Date.now(), from: String(turn.from).slice(0, 40), text: String(turn.text).slice(0, 2000), group: (turn.group ?? []).slice(0, 8) }]
        this.chat = next.length > 50 ? next.slice(next.length - 50) : next
    }

    async retire() {
        this.status = "retired"
        this.currentTask = ""
        this.location = "exit"
    }

    async read() {
        return {
            role: this.role,
            displayName: this.displayName,
            persona: this.persona,
            status: this.status,
            currentTask: this.currentTask,
            location: this.location,
            notes: this.notes,
            stats: this.stats,
            chat: this.chat,
        }
    }

    async setStatus(status: Employee["status"], currentTask?: string) {
        if (this.status === "retired") return
        this.status = status
        if (currentTask !== undefined) this.currentTask = currentTask
    }

    async moveTo(location: string) {
        if (this.status === "retired") return
        if (!/^[a-z][a-z0-9-]{0,23}$/.test(location)) throw new Error("bad location")
        this.location = location
    }

    /** Wipes memory notes and chat history (used by scripts/reset.sh). Role, persona and name stay. */
    async clearMemory() {
        this.notes = []
        this.chat = []
        this.stats = { ticketsTouched: 0, messagesSent: 0, llmCalls: 0 }
    }

    async remember(note: string) {
        const next = [...this.notes, note]
        this.notes = next.length > 20 ? next.slice(next.length - 20) : next
    }

    async bump(field: "ticketsTouched" | "messagesSent" | "llmCalls") {
        this.stats = { ...this.stats, [field]: this.stats[field] + 1 }
    }

    async onMessage(_socket: ActorSocket<null, { type: "ping" }>, _message: { type: "ping" }) {}
}

// ---------- Ticket: spec, plan, branch, diff, review rounds, state ----------

/** A "try it" request the engineer suggests for exercising the shipped change. GET only, path on the preview server. */
export type TryLink = { path: string; label: string; expect: string }

export type TicketLimits = { maxReviewRounds: number; maxLlmCalls: number; wallClockMs: number }

export class Ticket extends Actor<null, { type: "ping" }> {
    @Persisted @Emittable ticketId = ""
    @Persisted @Emittable title = ""
    @Persisted @Emittable description = ""
    @Persisted @Emittable state: TicketState = "queued"
    @Persisted @Emittable spec = ""
    @Persisted @Emittable plan: string[] = []
    @Persisted @Emittable branch = ""
    @Persisted @Emittable diff = ""
    @Persisted @Emittable testOutput = ""
    @Persisted @Emittable testsPassed: boolean | null = null
    @Persisted @Emittable reviews: ReviewRound[] = []
    @Persisted @Emittable reviewRound = 0
    @Persisted @Emittable failureReason = ""
    @Persisted @Emittable llmCalls = 0
    @Persisted @Emittable createdAt = 0
    @Persisted @Emittable deadline = 0
    @Persisted @Emittable finishedAt = 0
    @Persisted @Emittable commits: string[] = []
    @Persisted @Emittable limits: TicketLimits = { maxReviewRounds: 2, maxLlmCalls: 60, wallClockMs: 15 * 60_000 }
    @Persisted @Emittable resumes = 0
    @Persisted companyId = "main"
    /** Which agent owns each role's part of this ticket. Durable so replacement and restart can route work. */
    @Persisted @Emittable assignees: Record<string, string> = {}
    @Persisted @Emittable tryLinks: TryLink[] = []
    /** Stage the ticket was in when it failed, and retry bookkeeping (cap enforced here). */
    @Persisted @Emittable failedStage: TicketState | "" = ""
    @Persisted @Emittable retries = 0
    @Persisted @Emittable maxRetries = 3
    /** Reviews before this offset belong to earlier attempts; the review-round cap counts from here. */
    @Persisted @Emittable reviewOffset = 0

    async create(input: { ticketId: string; title: string; description: string; limits: TicketLimits; companyId?: string }) {
        if (this.ticketId) return this.read() // idempotent
        const now = Date.now()
        this.companyId = input.companyId ?? "main"
        this.ticketId = input.ticketId
        this.title = input.title
        this.description = input.description
        this.limits = input.limits
        this.createdAt = now
        this.deadline = now + input.limits.wallClockMs
        // Durable wall-clock guardrail: even if the brain dies, the ticket fails at the deadline.
        this.alarm.set(this.deadline)
        await this.publish()
        return this.read()
    }

    async read() {
        return {
            ticketId: this.ticketId,
            title: this.title,
            description: this.description,
            state: this.state,
            spec: this.spec,
            plan: this.plan,
            branch: this.branch,
            diff: this.diff,
            testOutput: this.testOutput,
            testsPassed: this.testsPassed,
            reviews: this.reviews,
            reviewRound: this.reviewRound,
            failureReason: this.failureReason,
            llmCalls: this.llmCalls,
            createdAt: this.createdAt,
            deadline: this.deadline,
            finishedAt: this.finishedAt,
            commits: this.commits,
            limits: this.limits,
            resumes: this.resumes,
            assignees: this.assignees,
            tryLinks: this.tryLinks,
            failedStage: this.failedStage,
            retries: this.retries,
            maxRetries: this.maxRetries,
            reviewOffset: this.reviewOffset,
        }
    }

    private async publish() {
        await Company.get(this.companyId).upsertTicket({ id: this.ticketId, title: this.title, state: this.state, updatedAt: Date.now() })
    }

    async setState(state: TicketState) {
        if (TERMINAL.includes(this.state)) return false
        if (state === "done") throw new Error("use markDone()")
        if (state === "failed") throw new Error("use fail()")
        this.state = state
        await this.publish()
        return true
    }

    async setSpec(spec: string, plan: string[]) {
        this.spec = spec
        this.plan = plan
    }

    async setBranch(branch: string) {
        this.branch = branch
    }

    async recordBuild(input: { diff: string; testOutput: string; testsPassed: boolean; commit?: string }) {
        this.diff = input.diff
        this.testOutput = input.testOutput.slice(-6000)
        this.testsPassed = input.testsPassed
        if (input.commit) this.commits = [...this.commits, input.commit]
    }

    async addReview(verdict: ReviewRound["verdict"], comments: string) {
        const round = this.reviews.length + 1
        this.reviews = [...this.reviews, { round, verdict, comments, ts: Date.now() }]
        this.reviewRound = round
        return round
    }

    /** Guardrail: LLM call budget. Returns false (and fails the ticket) once exhausted. */
    async consumeLlmCall() {
        if (TERMINAL.includes(this.state)) return false
        if (Date.now() > this.deadline) {
            await this.fail(`wall-clock cap of ${Math.round(this.limits.wallClockMs / 1000)}s exceeded`)
            return false
        }
        if (this.llmCalls >= this.limits.maxLlmCalls) {
            await this.fail(`LLM call cap of ${this.limits.maxLlmCalls} reached`)
            return false
        }
        this.llmCalls = this.llmCalls + 1
        return true
    }

    /** Guardrail: a ticket only reaches done when the last recorded test run passed. */
    async markDone() {
        if (TERMINAL.includes(this.state)) return this.state
        if (this.testsPassed !== true) {
            await this.fail("tests did not pass, refusing to mark done")
            return this.state
        }
        this.state = "done"
        this.finishedAt = Date.now()
        this.alarm.delete()
        await this.publish()
        await Company.get(this.companyId).log({ ticketId: this.ticketId, kind: "result", from: "factory", to: null, text: `${this.ticketId} DONE on branch ${this.branch}` })
        return this.state
    }

    async fail(reason: string) {
        if (TERMINAL.includes(this.state)) return this.state
        this.failedStage = this.state
        this.state = "failed"
        this.failureReason = reason
        this.finishedAt = Date.now()
        this.alarm.delete()
        await this.publish()
        await Company.get(this.companyId).log({ ticketId: this.ticketId, kind: "result", from: "factory", to: null, text: `${this.ticketId} FAILED while ${this.failedStage}: ${reason}` })
        return this.state
    }

    /**
     * Retry a failed ticket (cap: maxRetries). "resume" keeps spec/branch/commits/reviews and goes back to the
     * stage it failed in; "scratch" clears the work and starts at queued. Each retry gets a fresh call budget and clock.
     */
    async retry(input: { mode: "resume" | "scratch"; limits: TicketLimits; branch?: string }) {
        if (this.state !== "failed") throw new Error(`${this.ticketId} is not failed (it is ${this.state}); nothing to retry`)
        if (this.retries >= this.maxRetries) throw new Error(`${this.ticketId} already used all ${this.maxRetries} retries`)
        this.retries = this.retries + 1
        const from: TicketState = input.mode === "scratch" || !this.failedStage || TERMINAL.includes(this.failedStage as TicketState) ? "queued" : (this.failedStage as TicketState)
        if (input.mode === "scratch") {
            this.spec = ""
            this.plan = []
            this.branch = input.branch ?? ""
            this.diff = ""
            this.commits = []
            this.testOutput = ""
            this.testsPassed = null
            this.tryLinks = []
            this.assignees = {}
        }
        this.reviewOffset = this.reviews.length
        this.limits = input.limits
        this.llmCalls = 0
        this.failureReason = ""
        this.finishedAt = 0
        this.deadline = Date.now() + input.limits.wallClockMs
        this.alarm.set(this.deadline)
        this.state = from
        await this.publish()
        await Company.get(this.companyId).log({ ticketId: this.ticketId, kind: "system", from: "factory", to: null, text: `${this.ticketId} retry ${this.retries}/${this.maxRetries} ${input.mode === "scratch" ? "from scratch" : `from ${from}`}` })
        return { retries: this.retries, from }
    }

    /** Validated here too: relative GET paths only (no scheme/host), at most 5, short text. */
    async setTryLinks(links: TryLink[]) {
        const clean: TryLink[] = []
        for (const l of Array.isArray(links) ? links : []) {
            const path = String(l?.path ?? "").trim()
            if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /^\/*[a-z][a-z0-9+.-]*:/i.test(path) || path.length > 200 || /\s/.test(path)) continue
            clean.push({ path, label: String(l?.label ?? "").trim().slice(0, 120), expect: String(l?.expect ?? "").trim().slice(0, 120) })
            if (clean.length === 5) break
        }
        this.tryLinks = clean
        return clean
    }

    async assign(role: Role, agentId: string) {
        this.assignees = { ...this.assignees, [role]: agentId }
    }

    async noteResume() {
        this.resumes = this.resumes + 1
    }

    async onAlarm() {
        if (!TERMINAL.includes(this.state)) await this.fail(`wall-clock cap of ${Math.round(this.limits.wallClockMs / 1000)}s exceeded (actor alarm)`)
    }

    async onMessage(_socket: ActorSocket<null, { type: "ping" }>, _message: { type: "ping" }) {}
}
