// Guardrail tests. The Ticket tests need the Terse actor dev server running (scripts/start.sh).
import { describe, expect, test, beforeAll } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { actors } from "../generated/index.js"
import { WORKSPACES } from "../src/config"
import { Workspace } from "../src/workspace"

describe("engineer file access is confined to the working copy", () => {
    const ws = new Workspace("T9999", "factory/t9999-guardrail-test")
    beforeAll(async () => {
        fs.rmSync(ws.root, { recursive: true, force: true })
        await ws.prepare()
        fs.symlinkSync("/etc", path.join(ws.root, "etc-link"))
        fs.symlinkSync(path.join(WORKSPACES, ".."), path.join(ws.root, "up-link"))
    })

    test("rejects traversal, absolute paths and .git", () => {
        expect(() => ws.writeFile("../escape.txt", "x")).toThrow(/escapes/)
        expect(() => ws.writeFile("src/../../escape.txt", "x")).toThrow(/escapes/)
        expect(() => ws.readFile("/etc/passwd")).toThrow(/absolute/)
        expect(() => ws.writeFile(".git/config", "x")).toThrow(/not allowed/)
    })

    test("rejects symlink escapes for reads and writes", () => {
        expect(() => ws.readFile("etc-link/passwd")).toThrow(/symlink/)
        expect(() => ws.writeFile("up-link/pwned.txt", "x")).toThrow(/symlink/)
        expect(fs.existsSync(path.join(WORKSPACES, "..", "pwned.txt"))).toBe(false)
    })

    test("allows normal files inside the copy", () => {
        expect(ws.writeFile("src/new/thing.ts", "export const x = 1\n")).toContain("wrote")
        expect(ws.readFile("src/new/thing.ts")).toBe("export const x = 1\n")
    })
})

describe("ticket actor guardrails", () => {
    test("LLM call cap fails the ticket", async () => {
        const id = `G${Date.now()}`
        const t = actors.Ticket.get(`guard-${id}`)
        await t.create({ ticketId: id, title: "cap test", description: "", limits: { maxReviewRounds: 2, maxLlmCalls: 2, wallClockMs: 60_000 }, companyId: "guardtest" })
        expect(await t.consumeLlmCall()).toBe(true)
        expect(await t.consumeLlmCall()).toBe(true)
        expect(await t.consumeLlmCall()).toBe(false)
        const s = await t.read()
        expect(s.state).toBe("failed")
        expect(s.failureReason).toContain("LLM call cap")
    })

    test("cannot reach done without passing tests", async () => {
        const id = `G${Date.now()}b`
        const t = actors.Ticket.get(`guard-${id}`)
        await t.create({ ticketId: id, title: "tests gate", description: "", limits: { maxReviewRounds: 2, maxLlmCalls: 5, wallClockMs: 60_000 }, companyId: "guardtest" })
        await t.recordBuild({ diff: "x", testOutput: "1 fail", testsPassed: false })
        expect(await t.markDone()).toBe("failed")
        expect((await t.read()).failureReason).toContain("tests did not pass")
    })

    test("wall-clock alarm fails a stuck ticket even with no brain running", async () => {
        const id = `G${Date.now()}c`
        const t = actors.Ticket.get(`guard-${id}`)
        await t.create({ ticketId: id, title: "alarm", description: "", limits: { maxReviewRounds: 2, maxLlmCalls: 5, wallClockMs: 1500 }, companyId: "guardtest" })
        await Bun.sleep(4000)
        const s = await t.read()
        expect(s.state).toBe("failed")
        expect(s.failureReason).toContain("actor alarm")
    }, 10_000)
})

describe("roster guardrails (Company actor)", () => {
    test("validates ids/names, never reuses ids, caps the office at 8 active agents", async () => {
        const c = actors.Company.get(`guard-roster-${Date.now()}`)
        await c.ensureRoster() // 3 default agents
        await expect(c.hire({ id: "../x", name: "Evil", role: "engineer", persona: "" })).rejects.toThrow(/invalid agent id/)
        await expect(c.hire({ id: "bob", name: "<script>", role: "engineer", persona: "" })).rejects.toThrow(/name must be/)
        await expect(c.hire({ id: "engineer", name: "Casper Two", role: "engineer", persona: "" })).rejects.toThrow(/never reused/)
        for (let i = 0; i < 5; i++) await c.hire({ id: `eng-${i}`, name: `Eng ${i}`, role: "engineer", persona: "" })
        await expect(c.hire({ id: "eng-9", name: "Eng Nine", role: "engineer", persona: "" })).rejects.toThrow(/office is full/)
        await c.retire("eng-0", "eng-9")
        const e = await c.hire({ id: "eng-9", name: "Eng Nine", role: "engineer", persona: "" })
        expect(e.desk).toBeGreaterThanOrEqual(0)
    })
})
