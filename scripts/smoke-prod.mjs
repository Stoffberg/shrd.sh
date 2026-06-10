const baseUrl = (process.env.SHRD_API_URL ?? "https://shrd.stoff.dev").replace(/\/$/, "")
const content = `shrd smoke ${Date.now()}`
const name = `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

let created

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function eventually(label, operation, attempts = 8) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await sleep(attempt * 500)
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError?.message ?? lastError}`)
}

async function readJson(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Expected JSON from ${response.url}, got ${response.status}: ${text.slice(0, 160)}`)
  }
}

async function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    const text = await response.text().catch(() => "")
    throw new Error(`${label} returned ${response.status}, expected ${expected}: ${text.slice(0, 160)}`)
  }
}

async function deleteCreated() {
  if (!created) {
    return
  }

  await eventually("delete", async () => {
    const response = await fetch(`${baseUrl}/api/v1/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${created.deleteToken}` },
    })
    await expectStatus(response, 200, "delete")
  })
  created = undefined
}

try {
  const health = await fetch(`${baseUrl}/health`)
  await expectStatus(health, 200, "health")
  const healthBody = await readJson(health)
  if (healthBody.status !== "ok") {
    throw new Error(`health returned unexpected body: ${JSON.stringify(healthBody)}`)
  }

  const upload = await fetch(`${baseUrl}/api/v1/upload`, {
    method: "POST",
    headers: {
      "X-Name": name,
      "X-Content-Type": "text/plain",
      "X-Filename": "smoke.txt",
      "X-Expire": "1h",
    },
    body: content,
  })
  await expectStatus(upload, 201, "upload")
  created = await readJson(upload)

  await eventually("download", async () => {
    const download = await fetch(created.url)
    await expectStatus(download, 200, "download")
    const downloaded = await download.text()
    if (downloaded !== content) {
      throw new Error("downloaded content did not match uploaded content")
    }
  })

  await eventually("raw download", async () => {
    const raw = await fetch(created.rawUrl)
    await expectStatus(raw, 200, "raw download")
    const rawDownloaded = await raw.text()
    if (rawDownloaded !== content) {
      throw new Error("raw content did not match uploaded content")
    }
  })

  await deleteCreated()
  console.log(`Smoke passed for ${baseUrl}`)
} finally {
  if (created) {
    await deleteCreated().catch((error) => {
      console.error(`Smoke cleanup failed: ${error.message}`)
      process.exitCode = 1
    })
  }
}
