import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startApiServer } from "../helpers/server"

const repoRoot = resolve(__dirname, "../../../..")
const cliManifest = join(repoRoot, "cli/Cargo.toml")
const cliBin = join(repoRoot, "cli/target/debug/shrd")

let api: Awaited<ReturnType<typeof startApiServer>>
let homeDir: string

function run(command: string[], input?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cliBin, command, {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: join(homeDir, ".config"),
        SHRD_BASE_URL: api.url,
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, 20_000)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ status: null, stdout, stderr: stderr || error.message })
    })
    child.on("close", (status) => {
      clearTimeout(timer)
      resolve({
        status,
        stdout,
        stderr: stderr || (timedOut ? `timed out after 20000ms: ${command.join(" ")}` : ""),
      })
    })

    if (input !== undefined) {
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }
  })
}

function extractUrl(output: string): string {
  const match = output.match(/https?:\/\/\S+/)
  if (!match) {
    throw new Error(`No URL in output: ${output}`)
  }
  return match[0]
}

beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "shrd-e2e-"))
  const build = spawnSync("cargo", [
    "build",
    "--manifest-path",
    cliManifest,
    "--locked",
    "--no-default-features",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  if (build.status !== 0) {
    throw new Error(build.stderr || build.stdout)
  }
  api = await startApiServer()
})

afterAll(async () => {
  await api?.close()
  if (homeDir) {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

describe("CLI and API e2e", () => {
  it("uploads text and reads it back", async () => {
    const upload = await run(["upload", "--no-copy", "hello from e2e"])
    expect(upload.status).toBe(0)
    const url = extractUrl(upload.stdout)

    const get = await run(["get", url, "--raw", "--output", "-"])
    expect(get.status).toBe(0)
    expect(get.stdout).toBe("hello from e2e")
  })

  it("uses direct upload for files above the inline threshold", async () => {
    const path = join(homeDir, "payload.txt")
    const payload = "x".repeat(32 * 1024)
    writeFileSync(path, payload)

    const upload = await run(["upload", "--no-copy", path])
    expect(upload.status).toBe(0)
    const url = extractUrl(upload.stdout)

    const meta = await run(["get", url, "--meta"])
    expect(meta.status).toBe(0)
    expect(JSON.parse(meta.stdout)).toMatchObject({
      filename: "payload.txt",
      storageType: "r2",
    })

    const get = await run(["get", url, "--raw", "--output", "-"])
    expect(get.status).toBe(0)
    expect(get.stdout).toBe(payload)
  })
})
