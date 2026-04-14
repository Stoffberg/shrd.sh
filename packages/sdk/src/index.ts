export type ExpireDuration = `${number}h` | `${number}d` | "never";

export interface PushOptions {
  contentType?: string;
  filename?: string;
  expire?: ExpireDuration;
  expiresIn?: number;
  name?: string;
  burn?: boolean;
  encrypt?: boolean;
}

interface PushResponsePayload {
  id: string;
  url: string;
  rawUrl: string;
  expiresAt: string | null;
  deleteToken: string;
  name: string | null;
}

export interface PushResult extends PushResponsePayload {
  raw: string;
}

export interface ShareMetadata {
  id: string;
  contentType: string;
  size: number;
  views: number;
  createdAt: string;
  expiresAt: string | null;
  filename: string | null;
  encrypted: boolean;
  name: string | null;
  storageType: "kv" | "r2";
}

export interface ShrdConfig {
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://shrd.stoff.dev";

function getBaseUrl(config: ShrdConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (typeof process !== "undefined" && process.env?.SHRD_BASE_URL) {
    return process.env.SHRD_BASE_URL;
  }
  return DEFAULT_BASE_URL;
}

function extractId(input: string, baseUrl: string): string {
  const [withoutHash] = input.trim().split("#", 1);
  let value = withoutHash.replace(/^https?:\/\//, "");

  try {
    const host = new URL(baseUrl).host;
    if (value.startsWith(`${host}/`)) {
      value = value.slice(host.length + 1);
    }
  } catch {}

  value = value.replace(/^shrd\.sh\//, "");
  value = value.replace(/^shrd\.stoff\.dev\//, "");

  return value
    .split("/")
    .find(Boolean)
    ?.trim() ?? value.trim();
}

function normalizePushResult(payload: PushResponsePayload): PushResult {
  return {
    ...payload,
    raw: payload.rawUrl,
  };
}

export function createClient(config: ShrdConfig = {}) {
  const baseUrl = getBaseUrl(config);

  return {
    async push(content: string, options: PushOptions = {}): Promise<PushResult> {
      const response = await fetch(`${baseUrl}/api/v1/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content,
          ...options,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Push failed: ${response.status} - ${error}`);
      }

      return normalizePushResult(await response.json() as PushResponsePayload);
    },

    async pull(id: string): Promise<string> {
      const cleanId = extractId(id, baseUrl);
      const response = await fetch(`${baseUrl}/${cleanId}/raw`);

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("Share not found or expired");
        }
        throw new Error(`Pull failed: ${response.status}`);
      }

      return response.text();
    },

    async meta(id: string): Promise<ShareMetadata> {
      const cleanId = extractId(id, baseUrl);
      const response = await fetch(`${baseUrl}/${cleanId}/meta`);

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("Share not found or expired");
        }
        throw new Error(`Meta failed: ${response.status}`);
      }

      return response.json() as Promise<ShareMetadata>;
    },

    async delete(id: string, deleteToken: string): Promise<void> {
      const cleanId = extractId(id, baseUrl);
      const response = await fetch(`${baseUrl}/api/v1/${cleanId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${deleteToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Delete failed: ${response.status}`);
      }
    },
  };
}

const defaultClient = createClient();

export const shrd = {
  push: defaultClient.push,
  pull: defaultClient.pull,
  meta: defaultClient.meta,
  delete: defaultClient.delete,
  createClient,
};

export default shrd;
