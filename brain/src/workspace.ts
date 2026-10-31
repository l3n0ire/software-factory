// Per-ticket working copy of the demo repo, and the only file/git/test access the Engineer gets.
// Every path goes through resolveInside(), which rejects absolute paths, traversal, .git, and symlinks.
import fs from "node:fs"
import path from "node:path"
import { DEMO_REPO, WORKSPACES, config } from "./config"

export class PathEscapeError extends Error {}

async function run(cmd: string[], cwd: string, timeoutMs = 30_000) {
    const proc = Bun.spawn(cmd, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1", CI: "1" },
    })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    clearTimeout(timer)
    return { code, out, err, all: (out + "\n" + err).trim() }
}

async function git(args: string[], cwd: string) {
    const r = await run(["git", "-c", "user.name=Software Factory", "-c", "user.email=factory@local", ...args], cwd)
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.all}`)
    return r.out.trim()
}

export class Workspace {
    readonly root: string
    constructor(readonly ticketId: string, readonly branch: string) {
        if (!/^T\d+$/.test(ticketId)) throw new Error("bad ticket id")
        this.root = path.join(WORKSPACES, ticketId)
    }

    /** Idempotent: clones once, then always ensures the ticket branch is checked out. */
    async prepare() {
        fs.mkdirSync(WORKSPACES, { recursive: true })
        if (!fs.existsSync(path.join(this.root, ".git"))) {
            await git(["clone", "--quiet", DEMO_REPO, this.root], WORKSPACES)
        }
        const branches = await git(["branch", "--list", this.branch], this.root)
        if (branches) await git(["checkout", "--quiet", this.branch], this.root)
        else await git(["checkout", "--quiet", "-b", this.branch], this.root)
    }

    /** Resolve a repo-relative path, refusing anything that could escape the working copy. */
    resolveInside(rel: string): string {
        if (typeof rel !== "string" || rel.length === 0 || rel.length > 300) throw new PathEscapeError("invalid path")
        if (rel.includes("\0")) throw new PathEscapeError("invalid path")
        if (path.isAbsolute(rel)) throw new PathEscapeError(`absolute paths are not allowed: ${rel}`)
        const root = fs.realpathSync(this.root)
        const full = path.resolve(root, rel)
        if (full !== root && !full.startsWith(root + path.sep)) throw new PathEscapeError(`path escapes the working copy: ${rel}`)
        const parts = path.relative(root, full).split(path.sep).filter(Boolean)
        if (parts[0] === ".git" || parts.includes("node_modules")) throw new PathEscapeError(`access to ${parts[0]} is not allowed`)
        // Walk every existing component; any symlink is refused so nothing can point outside.
        let cur = root
        for (const part of parts) {
            cur = path.join(cur, part)
            let st: fs.Stats
            try {
                st = fs.lstatSync(cur)
            } catch {
                break // does not exist yet (new file); remaining components are created by us
            }
            if (st.isSymbolicLink()) throw new PathEscapeError(`symlinks are not allowed: ${path.relative(root, cur)}`)
        }
        return full
    }

    listFiles(): string[] {
        const out: string[] = []
        const walk = (dir: string) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                if (ent.name === ".git" || ent.name === "node_modules") continue
                const full = path.join(dir, ent.name)
                if (ent.isSymbolicLink()) continue
                if (ent.isDirectory()) walk(full)
                else out.push(path.relative(this.root, full))
            }
        }
        walk(this.root)
        return out.sort()
    }

    readFile(rel: string): string {
        const full = this.resolveInside(rel)
        const st = fs.statSync(full)
        if (!st.isFile()) throw new Error(`not a file: ${rel}`)
        if (st.size > 200_000) throw new Error("file too large")
        return fs.readFileSync(full, "utf8")
    }

    writeFile(rel: string, content: string) {
        if (content.length > 200_000) throw new Error("content too large")
        const full = this.resolveInside(rel)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        // Re-check after mkdir in case a directory component was swapped for a symlink.
        this.resolveInside(rel)
        fs.writeFileSync(full, content)
        return `wrote ${content.length} bytes to ${rel}`
    }

    async runTests() {
        const r = await run(["bun", "test"], this.root, config.testTimeoutMs)
        return { passed: r.code === 0, output: r.all.slice(-6000) }
    }

    /** Commit everything; returns the short sha or null when there was nothing to commit. */
    async commit(message: string) {
        await git(["add", "-A"], this.root)
        const status = await git(["status", "--porcelain"], this.root)
        if (!status) return null
        await git(["commit", "--quiet", "-m", message], this.root)
        return await git(["rev-parse", "--short", "HEAD"], this.root)
    }

    async diff() {
        return await git(["diff", "main...HEAD"], this.root)
    }

    /** Short `git status` of uncommitted work, used to brief an engineer who takes over mid-ticket. */
    async statusShort() {
        return await git(["status", "--porcelain"], this.root)
    }

    async diffUncommitted() {
        await git(["add", "-A"], this.root)
        return await git(["diff", "--cached"], this.root)
    }

    /** Deliverable: copy the ticket branch into the demo repo so it shows up as a real local branch. */
    async publishBranch() {
        await git(["fetch", "--quiet", this.root, `+${this.branch}:${this.branch}`], DEMO_REPO)
        return `${DEMO_REPO} @ ${this.branch}`
    }

    /**
     * Integration rule: a shipped ticket's branch is merged into demo-repo `main`, and every new ticket is
     * cloned from `main`, so follow-up tickets build on earlier shipped work. Serialised; on a merge conflict
     * the merge is aborted and `main` is left unchanged (the ticket branch is still published).
     */
    async integrateIntoMain(): Promise<{ ok: boolean; detail: string }> {
        const run = integrateLock.then(async () => {
            try {
                await git(["checkout", "--quiet", "main"], DEMO_REPO)
                await git(["merge", "--no-ff", "--no-edit", "-m", `Merge ${this.branch} (Software Factory ${this.ticketId})`, this.branch], DEMO_REPO)
                return { ok: true, detail: `merged ${this.branch} into main` }
            } catch (e) {
                await run2(["git", "merge", "--abort"], DEMO_REPO)
                return { ok: false, detail: `not merged into main (conflict): ${(e as Error).message.slice(0, 200)}` }
            }
        })
        integrateLock = run.catch(() => {})
        return run
    }
}

let integrateLock: Promise<unknown> = Promise.resolve()
const run2 = (cmd: string[], cwd: string) => run(cmd, cwd)

export function branchName(ticketId: string, title: string) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)
    return `factory/${ticketId.toLowerCase()}-${slug || "ticket"}`
}
