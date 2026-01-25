import { customAlphabet } from "nanoid";

const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const ID_LENGTH = 6;

export const generateId = customAlphabet(ID_ALPHABET, ID_LENGTH);

export const generateDeleteToken = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  32
);

export function detectContentType(content: string): "json" | "markdown" | "text" {
  const trimmed = content.trim();
  
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not valid JSON
    }
  }
  
  const markdownPatterns = [
    /^#{1,6}\s/m,
    /^\s*[-*+]\s/m,
    /^\s*\d+\.\s/m,
    /\[.+\]\(.+\)/,
    /```[\s\S]*```/,
    /^\s*>\s/m,
    /\*\*.+\*\*/,
    /__.+__/,
  ];
  
  if (markdownPatterns.some((pattern) => pattern.test(content))) {
    return "markdown";
  }
  
  return "text";
}

export function parseExpiry(expire: string): Date | null {
  if (expire === "never") return null;
  
  const match = expire.match(/^(\d+)(h|d)$/);
  if (!match) return null;
  
  const [, value, unit] = match;
  const num = parseInt(value, 10);
  const now = Date.now();
  
  if (unit === "h") {
    return new Date(now + num * 60 * 60 * 1000);
  }
  if (unit === "d") {
    return new Date(now + num * 24 * 60 * 60 * 1000);
  }
  
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

export const BASE_URL = process.env.SHRD_BASE_URL || "https://shrd.stoff.dev";
