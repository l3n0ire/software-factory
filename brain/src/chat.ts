// Direct chat between the human (@boss on Agent Relay) and one or more agents.
// Read-only with respect to tickets: no tools, no file writes, no state changes; only chat
// history and explicit "remember ..." notes are written (to the agent's Employee actor).
import { actors } from "../generated/index.js"
import { config, MOCK } from "./config"
import { chat } from "./llm"
import { send, type Envelope } from "./relay"
import { activeAgents, emp, STAGE_ROLE, type Agent } from "./roles"

export const HUMAN = "boss"
const MAX_TEXT = 1000
const CALLS_PER_MINUTE = 20
const callTimes: number[] = []

/** Guardrail: process-wide chat LLM calls per minute. */
function takeCallSlots(n: number) {
    const now = Date.now()
    while (callTimes.length && now - callTimes[0]! > 60_000) callTimes.shift()
    if (callTimes.length + n > CALLS_PER_MINUTE) return false
    for (let i = 0; i < n; i++) callTimes.push(now)
    return true
}

/** Group rounds: agents answer one after another so later ones see earlier replies. One round only, no agent-to-agent follow-ups. */
type Round = { members: string[]; replies: { id: string; name: string; text: string }[]; done: Map<string, Promise<void>>; resolve: Map<string, () => void> }
const rounds = new Map<string, Round>()
let roundSeq = 0

export async function sendChat(toRaw: unknown, textRaw: unknown) {
    const text = String(textRaw ?? "").trim()
    if (!text) throw new Error("message required")
    if (text.length > MAX_TEXT) throw new Error(`message must be at most ${MAX_TEXT} characters`)
    const list = Array.isArray(toRaw) ? toRaw.map(String) : [String(toRaw ?? "")]
    const to = list.includes("everyone") ? [...activeAgents.keys()] : [...new Set(list)]
    if (!to.length || to.some(id => !activeAgents.has(id))) throw new Error("recipients must be active agents")
    if (!takeCallSlots(to.length)) throw new Error(`chat rate limit: at most ${CALLS_PER_MINUTE} agent replies per minute`)
    const roundId = `r${++roundSeq}-${Date.now() % 100000}`
    const round: Round = { members: to, replies: [], done: new Map(), resolve: new Map() }
    for (const id of to) round.done.set(id, new Promise<void>(r => round.resolve.set(id, r)))
    rounds.set(roundId, round)
    setTimeout(() => rounds.delete(roundId), 5 * 60_000)
    const names = to.map(id => activeAgents.get(id)!.name)
    for (const id of to) {
        await emp(id).addChat({ from: HUMAN, text, group: to })
        // A real Relay DM per recipient; the header carries the round so group members can see each other's replies.
        await send(HUMAN, id, "chat", "chat", `${to.length > 1 ? `[group: ${names.join(", ")} #${roundId}] ` : `[#${roundId}] `}${text}`)
    }
    return { round: roundId, to }
}

async function currentWork(me: Agent) {
    const { tickets } = await actors.Company.get(config.companyId).read()
    const mine: string[] = []
    for (const s of tickets) {
        if (s.state === "done" || s.state === "failed") continue
        const t = await actors.Ticket.get(`ticket-${s.id}`).read()
        if (t.assignees?.[me.role] !== me.id) continue
        const stageRole = STAGE_ROLE[s.state]
        const doer = stageRole ? t.assignees?.[stageRole] : undefined
        const who = doer === me.id ? "you are doing this stage now" : `currently with ${doer ? (activeAgents.get(doer)?.name ?? doer) : "someone"} (${stageRole ?? "?"}), not you`
        mine.push(`${s.id} "${s.title}": stage ${s.state}, ${who}`)
    }
    return mine
}

/** Runs in the agent's Relay handler when the human DMs it. Never touches the agent's ticket work. */
export async function chatReply(me: Agent, msg: Envelope) {
    if (msg.from !== HUMAN) return // only humans start chats: no agent-to-agent loops
    const m = msg.body.match(/^\[(?:group: [^\]]*? )?#(r[\w-]+)\] ([\s\S]*)$/)
    const roundId = m?.[1] ?? ""
    const text = m?.[2] ?? msg.body
    const round = rounds.get(roundId)
    try {
        // Group: wait for the agents before me in this round (bounded), so I can see their replies.
        if (round) {
            const idx = round.members.indexOf(me.id)
            if (idx > 0) await Promise.race([round.done.get(round.members[idx - 1]!)!, Bun.sleep(45_000)])
        }
        if (!activeAgents.has(me.id)) return
        const self = await emp(me.id).read()
        const work = await currentWork(me)
        // "remember ..." is saved verbatim to durable memory, detected in code, not by the model.
        const rem = text.match(/\bremember(?: that)?[:,]?\s+([\s\S]{3,300})/i)
        if (rem) await emp(me.id).remember(`Boss asked me to remember: ${rem[1]!.trim()}`)
        const others = round?.replies.filter(r => r.id !== me.id) ?? []
        let reply: string
        if (MOCK) {
            reply = `[mock LLM] ${me.name} here (${me.role}). ${work.length ? `I'm on ${work.join(", ")}.` : "No tickets on my desk right now."}${rem ? " Noted, I'll remember that." : ""}${others.length ? ` Agree with ${others[0]!.name}.` : ""}`
        } else {
            const history = self.chat.slice(-8).map(t => `${t.from === HUMAN ? "Boss" : me.name}: ${t.text}`).join("\n")
            const sys = `You are ${me.name}, the ${me.role} in a small AI software team (the "Software Factory", Halloween-themed office).${me.persona ? ` Persona: ${me.persona}.` : ""}
You are chatting with your boss. Answer in character, briefly (1-3 sentences). You cannot change tickets or code from chat; if asked to, say you'll handle it through a ticket.
Your status: ${self.status}${self.currentTask ? `, current task: ${self.currentTask}` : ""}.
Tickets you are on (as ${me.role}): ${work.join("; ") || "none"}. Only claim work you are actually doing.
Your memory notes: ${self.notes.slice(-8).join(" | ") || "none"}.${rem ? "\nThe boss asked you to remember something; it has been saved to your notes. Confirm it." : ""}${others.length ? `\nThis is a group chat. Colleagues already replied this round:\n${others.map(o => `${o.name}: ${o.text}`).join("\n")}\nDon't repeat them; add your own angle.` : ""}`
            const r = await chat(
                [
                    { role: "system", content: sys },
                    { role: "user", content: `Recent chat:\n${history}\n\nBoss's new message: ${text}` },
                ],
                { maxTokens: 400 },
            )
            reply = (r.content ?? "").trim() || "…"
        }
        if (!activeAgents.has(me.id)) return // removed/replaced while thinking: drop the reply
        reply = reply.slice(0, 1000)
        round?.replies.push({ id: me.id, name: me.name, text: reply })
        await emp(me.id).addChat({ from: me.id, text: reply, group: round?.members ?? [me.id] })
        await send(me.id, HUMAN, "chat", "chat", reply)
    } catch (e) {
        console.error(`[chat ${me.id}]`, (e as Error).message)
        await emp(me.id).addChat({ from: me.id, text: `(couldn't reply: ${(e as Error).message.slice(0, 120)})`, group: round?.members ?? [me.id] })
    } finally {
        round?.resolve.get(me.id)?.()
    }
}
