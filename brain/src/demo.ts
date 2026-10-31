// Headless demo: file the demo ticket against a running brain and stream the event log
// (read from the Company actor) until the ticket is done or failed.
// Usage: bun src/demo.ts [--title "..." --description "..."] [--watch T1]
import { actors } from "../generated/index.js"
import { config } from "./config"

const args = process.argv.slice(2)
const opt = (k: string) => {
    const i = args.indexOf(k)
    return i >= 0 ? args[i + 1] : undefined
}
const base = `http://localhost:${config.port}`
const company = actors.Company.get(config.companyId)

let ticketId = opt("--watch")
if (!ticketId) {
    const title = opt("--title")
    const body = title ? { title, description: opt("--description") ?? "" } : { demo: true }
    const res = await fetch(`${base}/api/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`brain not reachable at ${base}: ${res.status} ${await res.text()}`)
    ticketId = ((await res.json()) as { id: string }).id
}
console.log(`Watching ${ticketId}\n`)

const fmt = (ts: number) => new Date(ts).toLocaleTimeString()
let lastId = 0
const t0 = Date.now()
for (;;) {
    const { events, tickets } = await company.read()
    for (const e of events) {
        if (e.id <= lastId || (e.ticketId && e.ticketId !== ticketId)) continue
        lastId = Math.max(lastId, e.id)
        if (e.ts < t0 - 1000 && !args.includes("--watch")) continue
        const who = e.to ? `@${e.from} -> @${e.to}` : `@${e.from}`
        const tag = e.kind === "relay" ? "RELAY " : e.kind.toUpperCase().padEnd(6)
        console.log(`${fmt(e.ts)}  ${tag} ${who.padEnd(26)} ${e.text.replace(/\s+/g, " ").slice(0, 220)}`)
    }
    const s = tickets.find(t => t.id === ticketId)
    if (s && (s.state === "done" || s.state === "failed")) break
    await Bun.sleep(700)
}

const t = await actors.Ticket.get(`ticket-${ticketId}`).read()
console.log(`\n=== ${t.ticketId} ${t.state.toUpperCase()} ===`)
console.log(`branch: ${t.branch}  reviews: ${t.reviews.map(r => `${r.round}:${r.verdict}`).join(", ")}  llmCalls: ${t.llmCalls}  tests: ${t.testsPassed ? "PASS" : "FAIL"}`)
if (t.failureReason) console.log(`reason: ${t.failureReason}`)
console.log(`\n${t.diff}`)
process.exit(t.state === "done" ? 0 : 1)
