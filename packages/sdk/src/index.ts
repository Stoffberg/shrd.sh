export interface PushOptions {
  type?: "text" | "json" | "markdown";
  expire?: "1h" | "24h" | "7d" | "30d" | "never";
  name?: string;
  burn?: boolean;
  encrypt?: boolean;
}

export interface PushResult {
  id: string;
  url: string;
  raw: string;
  expiresAt: string | null;
  deleteToken: string;
}

export interface ShareMetadata {
  id: string;
  type: string;
  size: number;
  views: number;
  createdAt: string;
  expiresAt: string | null;
}

export interface ShrdConfig {
  baseUrl?: string;
  apiKey?: string;
}

const DEFAULT_BASE_URL = "https://shrd.stoff.dev";

function getBaseUrl(config: ShrdConfig): string {
  // Priority: 1. Explicit config, 2. Environment variable, 3. Default
  if (config.baseUrl) return config.baseUrl;
  if (typeof process !== "undefined" && process.env?.SHRD_BASE_URL) {
    return process.env.SHRD_BASE_URL;
  }
  return DEFAULT_BASE_URL;
}

function extractId(input: string, baseUrl: string): string {
  let id = input;
  // Remove common URL prefixes
  id = id.replace(/^https?:\/\//, "");
  // Remove the base URL host if present
  try {
    const host = new URL(baseUrl).host;
    id = id.replace(new RegExp(`^${host.replace(".", "\\.")}/`), "");
  } catch {
    // If baseUrl is invalid, try common patterns
  }
  // Remove common known hosts
  id = id.replace(/^shrd\.sh\//, "");
  id = id.replace(/^shrd\.stoff\.dev\//, "");
  // Remove any remaining path components after the ID
  id = id.split("/")[0];
  return id;
}

export function createClient(config: ShrdConfig = {}) {
  const baseUrl = getBaseUrl(config);
  const headers: Record<string, string> = {};

  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  return {
    async push(content: string, options: PushOptions = {}): Promise<PushResult> {
      const response = await fetch(`${baseUrl}/api/v1/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
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

      return response.json() as Promise<PushResult>;
    },

    async pull(id: string): Promise<string> {
      const cleanId = extractId(id, baseUrl);

      const response = await fetch(`${baseUrl}/${cleanId}/raw`, {
        headers,
      });

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

      const response = await fetch(`${baseUrl}/${cleanId}/meta`, {
        headers,
      });

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
          ...headers,
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
