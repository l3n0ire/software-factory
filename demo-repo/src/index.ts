import { handle } from "./app"

const server = Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: handle })
console.log(`Pumpkin Patch API on http://localhost:${server.port}`)
