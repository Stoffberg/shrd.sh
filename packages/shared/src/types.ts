export type PresetExpireDuration = "1h" | "24h" | "7d" | "30d" | "never";
export type ExpireDuration = PresetExpireDuration | `${number}h` | `${number}d`;

export type UserTier = "free" | "pro" | "api" | "team";

export interface ShareMetadata {
  id: string;
  contentType: string;
  createdAt: string;
  expiresAt: string | null;
  burn: boolean;
  encrypted: boolean;
  name: string | null;
  filename: string | null;
  views: number;
  size: number;
  storageType: "kv" | "r2";
}

export interface CreateShareRequest {
  content: string;
  contentType?: string;
  filename?: string;
  expire?: ExpireDuration;
  expiresIn?: number;
  burn?: boolean;
  encrypted?: boolean;
  name?: string;
}

export interface CreateShareResponse {
  id: string;
  url: string;
  rawUrl: string;
  expiresAt: string | null;
  deleteToken: string;
  name: string | null;
}

export interface ApiError {
  error: string;
  code: string;
  status: number;
}

export const TIER_LIMITS: Record<UserTier, {
  sharesPerDay: number;
  maxExpiry: PresetExpireDuration;
  maxSize: number;
}> = {
  free: { sharesPerDay: 50, maxExpiry: "24h", maxSize: 5 * 1024 * 1024 },
  pro: { sharesPerDay: 500, maxExpiry: "30d", maxSize: 50 * 1024 * 1024 },
  api: { sharesPerDay: 5000, maxExpiry: "30d", maxSize: 100 * 1024 * 1024 },
  team: { sharesPerDay: Infinity, maxExpiry: "never", maxSize: 500 * 1024 * 1024 },
};

export const EXPIRY_MS: Record<PresetExpireDuration, number | null> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "never": null,
};
