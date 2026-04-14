import { describe, expect, it, vi } from "vitest"
import { isExpired, parseExpiry } from "../../../packages/shared/src/utils"

describe("shared utils", () => {
  it("parses duration strings", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-14T00:00:00.000Z"))

    const oneHour = parseExpiry("1h")
    const sevenDays = parseExpiry("7d")

    expect(oneHour?.toISOString()).toBe("2026-04-14T01:00:00.000Z")
    expect(sevenDays?.toISOString()).toBe("2026-04-21T00:00:00.000Z")

    vi.useRealTimers()
  })

  it("supports never and rejects invalid values", () => {
    expect(parseExpiry("never")).toBeNull()
    expect(parseExpiry("later")).toBeNull()
  })

  it("detects expired timestamps", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-14T00:00:00.000Z"))

    expect(isExpired("2026-04-13T23:59:59.000Z")).toBe(true)
    expect(isExpired("2026-04-14T00:00:01.000Z")).toBe(false)
    expect(isExpired(null)).toBe(false)

    vi.useRealTimers()
  })
})
