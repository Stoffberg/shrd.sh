import { Hono } from "hono"
import { cors } from "hono/cors"
import type { Env } from "./types"
import { registerRoutes } from "./routes"
import { handleScheduled } from "./scheduled"

const app = new Hono<{ Bindings: Env }>()

app.use("*", cors())

registerRoutes(app)

export { app }

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
}
