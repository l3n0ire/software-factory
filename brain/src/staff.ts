// Hiring and replacing agents. The roster lives in the Company actor (durable); this module
// keeps the brain's live view of it (activeAgents) and each agent's Relay identity in sync.
import { actors } from "../generated/index.js"
import { config } from "./config"
import { connectAgent, disconnectAgent } from "./relay"
import { activeAgents, emp, handlerFor, resumeTicket, STAGE_ROLE, type Agent, type Role } from "./roles"

const company = () => actors.Company.get(config.companyId)
const ticketRef = (id: string) => actors.Ticket.get(`ticket-${id}`)

const NAME = /^[A-Za-z][A-Za-z0-9 '_-]{1,23}$/
const ROLES: Role[] = ["pm", "engineer", "reviewer"]

/** Turn a display name into a fresh, never-reused agent id (also the Relay handle). */
async function newAgentId(name: string) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18) || "agent"
    const start = /^[a-z]/.test(base) ? base : `a-${base}`
    const { roster } = await company().read()
    const used = new Set(roster.map(r => r.id))
    if (!used.has(start)) return start
    for (let i = 2; ; i++) if (!used.has(`${start}-${i}`)) return `${start}-${i}`
}

function validate(input: { name?: unknown; role?: unknown; persona?: unknown }) {
    const name = String(input.name ?? "").trim()
    const role = String(input.role ?? "") as Role
    const persona = String(input.persona ?? "").trim().slice(0, 200)
    if (!NAME.test(name)) throw new Error("name must be 2-24 characters: letters, digits, spaces, ' _ - and start with a letter")
    if (!ROLES.includes(role)) throw new Error("role must be pm, engineer or reviewer")
    return { name, role, persona }
}

/** Bring one roster entry online: Employee actor, Relay identity, live handler. */
async function activate(a: Agent) {
    await emp(a.id).init(a.role, a.name, a.persona)
    await emp(a.id).moveTo("desk")
    await emp(a.id).setStatus("idle")
    activeAgents.set(a.id, a)
    await connectAgent(a.id, handlerFor(a))
}

/** On boot: rebuild the office from the durable roster. */
export async function loadRoster() {
    const roster = await company().ensureRoster()
    for (const r of roster) if (r.status === "active") await activate({ id: r.id, name: r.name, role: r.role, persona: r.persona })
    return roster
}

export async function hire(input: { name?: unknown; role?: unknown; persona?: unknown }) {
    const { name, role, persona } = validate(input)
    const id = await newAgentId(name)
    const entry = await company().hire({ id, name, role, persona }) // enforces the 8-agent cap and uniqueness durably
    await activate({ id, name, role, persona })
    await company().log({ ticketId: null, kind: "staff", from: id, to: null, text: `${name} joined as ${role}${persona ? ` (${persona})` : ""} at desk ${entry.desk + 1}` })
    console.log(`[staff] hired ${name} (${id}) as ${role}`)
    return entry
}

/**
 * Replace an active agent: retire it (Relay listener removed, identity released, in-flight work discarded),
 * hire a successor in the same role who inherits its memory notes and its unfinished tickets, then
 * re-send each ticket's current handoff over Relay so the successor continues from the ticket's state.
 */
export async function replace(oldId: string, input: { name?: unknown; persona?: unknown }) {
    const old = activeAgents.get(oldId)
    if (!old) throw new Error(`${oldId} is not an active agent`)
    const { name, persona } = validate({ ...input, role: old.role })
    const newId = await newAgentId(name)

    // 1. Retire first, so nothing the old agent is still doing can land (alive() checks fail from here on).
    activeAgents.delete(oldId)
    await disconnectAgent(oldId)
    await company().retire(oldId, newId)
    const oldState = await emp(oldId).read()
    await emp(oldId).retire()

    // 2. Hire the successor in the same role (takes the freed desk) and hand over memory.
    await company().hire({ id: newId, name, role: old.role, persona, replaces: oldId })
    await activate({ id: newId, name, role: old.role, persona })
    await emp(newId).inherit(oldState.notes, old.name)

    // 3. Inherit unfinished tickets and resume the ones currently waiting on this role.
    const { tickets } = await company().read()
    const inherited: string[] = []
    for (const s of tickets) {
        if (s.state === "done" || s.state === "failed") continue
        const t = await ticketRef(s.id).read()
        if (t.assignees?.[old.role] !== oldId) continue
        await ticketRef(s.id).assign(old.role, newId)
        inherited.push(`${s.id} at ${t.state}`)
        const resuming = STAGE_ROLE[t.state] === old.role
        await company().log({
            ticketId: s.id,
            kind: "staff",
            from: newId,
            to: null,
            text: `${old.name} replaced by ${name}, ${resuming ? "resuming" : "inheriting"} ${s.id} at ${t.state}`,
        })
        if (resuming) await resumeTicket(s.id, `taking over from ${old.name}`)
    }
    if (!inherited.length) await company().log({ ticketId: null, kind: "staff", from: newId, to: null, text: `${old.name} replaced by ${name} (${old.role}); no tickets in flight` })
    console.log(`[staff] ${old.name} -> ${name}; inherited: ${inherited.join(", ") || "none"}`)
    return { retired: oldId, hired: newId, inherited }
}

/**
 * Remove an active agent with no successor. The last agent of a role cannot be removed (the pipeline would
 * stall), use replace for that. Tickets the agent owned move to the least busy remaining agent of the role;
 * the one currently waiting on this role is resumed there from its saved state.
 */
export async function remove(oldId: string) {
    const old = activeAgents.get(oldId)
    if (!old) throw new Error(`${oldId} is not an active agent`)
    if (![...activeAgents.values()].some(a => a.role === old.role && a.id !== oldId)) {
        throw new Error(`${old.name} is the only ${old.role}; hire another ${old.role} first, or use Replace`)
    }
    // Retire first, so nothing the old agent is still doing can land.
    activeAgents.delete(oldId)
    await disconnectAgent(oldId)
    await company().retire(oldId, "")
    await emp(oldId).retire()
    await company().log({ ticketId: null, kind: "staff", from: oldId, to: null, text: `${old.name} (${old.role}) was removed from the office` })

    const { tickets } = await company().read()
    const moved: string[] = []
    for (const s of tickets) {
        if (s.state === "done" || s.state === "failed") continue
        const t = await ticketRef(s.id).read()
        if (t.assignees?.[old.role] !== oldId) continue
        moved.push(`${s.id} at ${t.state}`)
        if (STAGE_ROLE[t.state] === old.role) {
            await company().log({ ticketId: s.id, kind: "staff", from: oldId, to: null, text: `${old.name} removed, reassigning ${s.id} at ${t.state}` })
            await resumeTicket(s.id, `reassigned after ${old.name} was removed`)
        }
    }
    console.log(`[staff] removed ${old.name}; reassigned: ${moved.join(", ") || "none"}`)
    return { removed: oldId, reassigned: moved }
}
