// Clears the Company's ticket list and event log (actor state), workspaces and published demo branches.
import { actors } from "../generated/index.js"
import { config, WORKSPACES, DEMO_REPO } from "../src/config"
import fs from "node:fs"
const company = actors.Company.get(config.companyId)
const { roster } = await company.read()
for (const r of roster) await actors.Employee.get(`${config.companyId}-${r.id}`).clearMemory()
await company.reset()
fs.rmSync(WORKSPACES, { recursive: true, force: true })
const branches = Bun.spawnSync(["git", "branch", "--list", "factory/*", "--format=%(refname:short)"], { cwd: DEMO_REPO }).stdout.toString().split("\n").filter(Boolean)
for (const b of branches) Bun.spawnSync(["git", "branch", "-D", b], { cwd: DEMO_REPO })
console.log(`reset company ${config.companyId}; cleared memory of ${roster.length} agents; removed workspaces and ${branches.length} factory branches`)
