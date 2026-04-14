import { describe, expect, it } from "vitest"
import { render404, renderContentPage } from "../src/html"
import type { ContentMetadata } from "../src/types"
import { GEIST_MONO_WOFF2_URL, GEIST_SANS_WOFF2_URL } from "../../../packages/shared/src/fonts"

function createMetadata(overrides: Partial<ContentMetadata> = {}): ContentMetadata {
  return {
    id: "abc123",
    deleteToken: "x".repeat(32),
    contentType: "text/plain",
    size: 12,
    createdAt: "2026-04-15T00:00:00.000Z",
    expiresAt: null,
    views: 0,
    storageType: "kv",
    ...overrides,
  }
}

describe("HTML font assets", () => {
  it("renders content pages with pinned Geist font files", () => {
    const html = renderContentPage("hello", createMetadata(), "https://shrd.sh")

    expect(html).toContain(`href="${GEIST_SANS_WOFF2_URL}"`)
    expect(html).toContain(`href="${GEIST_MONO_WOFF2_URL}"`)
    expect(html).toContain(`src: url('${GEIST_SANS_WOFF2_URL}') format('woff2')`)
    expect(html).toContain(`src: url('${GEIST_MONO_WOFF2_URL}') format('woff2')`)
    expect(html).not.toContain("style.min.css")
  })

  it("renders the 404 page without broken Geist stylesheet links", () => {
    const html = render404()

    expect(html).toContain(`href="${GEIST_SANS_WOFF2_URL}"`)
    expect(html).toContain(`href="${GEIST_MONO_WOFF2_URL}"`)
    expect(html).not.toContain("style.min.css")
  })
})
