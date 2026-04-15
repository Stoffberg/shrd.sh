import { describe, expect, it } from "vitest"
import { getServedContentType, isBinaryContent, render404, renderBinaryPage, renderContentPage } from "../src/html"
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

  it("keeps plain content pages visible", () => {
    const html = renderContentPage("hello", createMetadata(), "https://shrd.sh")

    expect(html).toContain('<div class="content-box" id="content"><pre>hello</pre></div>')
    expect(html).not.toContain('<div id="loading" class="loading-box">')
    expect(html).not.toContain('<div id="error" class="error-box">')
    expect(html).not.toContain("#content { display: none; }")
  })

  it("hides encrypted content until decryption completes", () => {
    const html = renderContentPage(
      "secret",
      createMetadata({ encrypted: true }),
      "https://shrd.sh"
    )

    expect(html).toContain('<div id="loading" class="loading-box">')
    expect(html).toContain('<div id="error" class="error-box">')
    expect(html).toContain('<div class="content-box" id="content"></div>')
    expect(html).toContain("document.getElementById('content').style.display = 'block';")
  })

  it("renders browser-friendly binary previews inline", () => {
    const imageHtml = renderBinaryPage(
      createMetadata({ contentType: "image/png", filename: "photo.png" }),
      "https://shrd.sh"
    )
    const videoHtml = renderBinaryPage(
      createMetadata({ contentType: "video/mp4", filename: "clip.mp4" }),
      "https://shrd.sh"
    )
    const audioHtml = renderBinaryPage(
      createMetadata({ contentType: "audio/mpeg", filename: "track.mp3" }),
      "https://shrd.sh"
    )
    const pdfHtml = renderBinaryPage(
      createMetadata({ contentType: "application/pdf", filename: "scan.pdf" }),
      "https://shrd.sh"
    )

    expect(imageHtml).toContain('<img src="https://shrd.sh/abc123/raw" class="media" alt="photo.png">')
    expect(videoHtml).toContain('<video controls autoplay class="media"><source src="https://shrd.sh/abc123/raw" type="video/mp4">')
    expect(audioHtml).toContain('<audio controls class="media"><source src="https://shrd.sh/abc123/raw" type="audio/mpeg">')
    expect(pdfHtml).toContain('<iframe src="https://shrd.sh/abc123/raw" class="media pdf"></iframe>')
  })

  it("uses filename heuristics when the content type is generic", () => {
    expect(isBinaryContent("application/octet-stream", "notes.yaml")).toBe(false)
    expect(isBinaryContent("application/octet-stream", "deploy.log")).toBe(false)
    expect(isBinaryContent("application/octet-stream", "script.sh")).toBe(false)
    expect(isBinaryContent("application/octet-stream", "index.html")).toBe(false)
    expect(isBinaryContent("application/octet-stream", "report.csv")).toBe(false)
    expect(isBinaryContent("application/octet-stream", "Dockerfile")).toBe(false)

    expect(isBinaryContent("application/octet-stream", "vector.svg")).toBe(true)
    expect(isBinaryContent("application/octet-stream", "photo.png")).toBe(true)
    expect(isBinaryContent("application/octet-stream", "clip.mp4")).toBe(true)
    expect(isBinaryContent("application/octet-stream", "track.mp3")).toBe(true)
    expect(isBinaryContent("application/octet-stream", "scan.pdf")).toBe(true)
    expect(isBinaryContent("application/octet-stream", "archive.bin")).toBe(true)
  })

  it("infers displayable content types for generic media uploads", () => {
    expect(getServedContentType("application/octet-stream", "photo.png")).toBe("image/png")
    expect(getServedContentType("application/octet-stream", "clip.mp4")).toBe("video/mp4")
    expect(getServedContentType("application/octet-stream", "track.mp3")).toBe("audio/mpeg")
    expect(getServedContentType("application/octet-stream", "scan.pdf")).toBe("application/pdf")
    expect(getServedContentType("application/octet-stream", "notes.yaml")).toBe("application/octet-stream")
  })

  it("renders generic uploads from filename hints", () => {
    const imageHtml = renderBinaryPage(
      createMetadata({ contentType: "application/octet-stream", filename: "vector.svg" }),
      "https://shrd.sh"
    )
    const videoHtml = renderBinaryPage(
      createMetadata({ contentType: "application/octet-stream", filename: "clip.mp4" }),
      "https://shrd.sh"
    )
    const audioHtml = renderBinaryPage(
      createMetadata({ contentType: "application/octet-stream", filename: "track.mp3" }),
      "https://shrd.sh"
    )
    const pdfHtml = renderBinaryPage(
      createMetadata({ contentType: "application/octet-stream", filename: "scan.pdf" }),
      "https://shrd.sh"
    )

    expect(imageHtml).toContain('<img src="https://shrd.sh/abc123/raw" class="media" alt="vector.svg">')
    expect(videoHtml).toContain('<video controls autoplay class="media"><source src="https://shrd.sh/abc123/raw" type="video/mp4">')
    expect(audioHtml).toContain('<audio controls class="media"><source src="https://shrd.sh/abc123/raw" type="audio/mpeg">')
    expect(pdfHtml).toContain('<iframe src="https://shrd.sh/abc123/raw" class="media pdf"></iframe>')
  })

  it("keeps unsupported binaries as downloads", () => {
    const html = renderBinaryPage(
      createMetadata({ contentType: "application/zip", filename: "archive.zip", size: 4096 }),
      "https://shrd.sh"
    )

    expect(html).toContain('Download File')
    expect(html).toContain('archive.zip &middot; 4.0 KB')
    expect(html).not.toContain('<img src=')
    expect(html).not.toContain('<video controls autoplay class="media">')
    expect(html).not.toContain('<audio controls class="media">')
    expect(html).not.toContain('<iframe src=')
  })

  it("keeps encrypted binary previews aligned with filename-based detection", () => {
    const html = renderBinaryPage(
      createMetadata({
        encrypted: true,
        contentType: "application/octet-stream",
        filename: "scan.pdf",
      }),
      "https://shrd.sh"
    )

    expect(html).toContain(`document.getElementById('content').innerHTML = '<iframe src="' + blobUrl + '" class="media pdf"></iframe>';`)
  })

  it("renders the 404 page without broken Geist stylesheet links", () => {
    const html = render404()

    expect(html).toContain(`href="${GEIST_SANS_WOFF2_URL}"`)
    expect(html).toContain(`href="${GEIST_MONO_WOFF2_URL}"`)
    expect(html).not.toContain("style.min.css")
  })
})
