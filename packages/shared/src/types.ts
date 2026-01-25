export type ContentType = "text" | "json" | "markdown" | "binary" | "image";

export type ExpireDuration = "1h" | "24h" | "7d" | "30d" | "never";

export type UserTier = "free" | "pro" | "api" | "team";

export interface ShareMetadata {
  id: string;
  type: ContentType;
  createdAt: string;
  expiresAt: string | null;
  burn: boolean;
  encrypted: boolean;
  userId: string | null;
  views: number;
  name: string | null;
  size: number;
}

export interface CreateShareRequest {
  content: string;
  type?: ContentType;
  expire?: ExpireDuration;
  burn?: boolean;
  encrypt?: boolean;
  name?: string;
}

export interface CreateShareResponse {
  id: string;
  url: string;
  raw: string;
  expiresAt: string | null;
  deleteToken: string;
}

export interface CollectionItem {
  name: string;
  content: string;
  type?: ContentType;
}

export interface CreateCollectionRequest {
  items: CollectionItem[];
  expire?: ExpireDuration;
}

export interface CreateCollectionResponse {
  id: string;
  url: string;
  items: Array<{
    name: string;
    url: string;
  }>;
}

export interface ApiError {
  error: string;
  code: string;
  status: number;
}

export const TIER_LIMITS: Record<UserTier, {
  sharesPerDay: number;
  maxExpiry: ExpireDuration;
  maxSize: number;
}> = {
  free: { sharesPerDay: 50, maxExpiry: "24h", maxSize: 5 * 1024 * 1024 },
  pro: { sharesPerDay: 500, maxExpiry: "30d", maxSize: 50 * 1024 * 1024 },
  api: { sharesPerDay: 5000, maxExpiry: "30d", maxSize: 100 * 1024 * 1024 },
  team: { sharesPerDay: Infinity, maxExpiry: "never", maxSize: 500 * 1024 * 1024 },
};

export const EXPIRY_MS: Record<ExpireDuration, number | null> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "never": null,
};
