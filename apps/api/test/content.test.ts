import { describe, expect, it } from "vitest"
import { getContentDisposition, getDownloadFilename, getServedContentType } from "../src/content"

describe("content downloads", () => {
  it("infers useful content types for generic uploads", () => {
    expect(getServedContentType("application/octet-stream", "photo.png")).toBe("image/png")
    expect(getServedContentType("application/octet-stream", "clip.mp4")).toBe("video/mp4")
    expect(getServedContentType("application/octet-stream", "document.pdf")).toBe("application/pdf")
    expect(getServedContentType("text/plain", "payload.bin")).toBe("text/plain")
  })

  it("builds attachment filenames from file metadata first", () => {
    expect(getDownloadFilename("abc123", "folder/report.pdf", "named")).toBe("report.pdf")
    expect(getDownloadFilename("abc123", null, "named")).toBe("named")
    expect(getDownloadFilename("abc123")).toBe("abc123")
    expect(getContentDisposition("abc123", "résumé.pdf")).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")
  })
})
