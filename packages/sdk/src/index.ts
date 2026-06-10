export type ExpireDuration = `${number}h` | `${number}d` | "never";

export interface PushOptions {
  contentType?: string;
  filename?: string;
  expire?: ExpireDuration;
  expiresIn?: number | ExpireDuration;
  name?: string;
  burn?: boolean;
  encrypt?: boolean;
}

export interface UploadOptions {
  contentType?: string;
  filename?: string;
  expire?: ExpireDuration;
  expiresIn?: number | ExpireDuration;
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

function uploadHeaders(options: UploadOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.contentType) headers["X-Content-Type"] = options.contentType;
  if (options.filename) headers["X-Filename"] = options.filename;
  if (options.expire) headers["X-Expire"] = options.expire;
  if (options.expiresIn !== undefined) headers["X-Expires-In"] = String(options.expiresIn);
  if (options.name) headers["X-Name"] = options.name;
  if (options.burn) headers["X-Burn"] = "true";
  if (options.encrypt) headers["X-Encrypted"] = "true";
  return headers;
}

export function createClient(config: ShrdConfig = {}) {
  const baseUrl = getBaseUrl(config);

  async function download(id: string): Promise<Response> {
    const cleanId = extractId(id, baseUrl);
    const response = await fetch(`${baseUrl}/${cleanId}/raw`);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("Share not found or expired");
      }
      throw new Error(`Download failed: ${response.status}`);
    }

    return response;
  }

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

    async upload(body: RequestInit["body"], options: UploadOptions = {}): Promise<PushResult> {
      const response = await fetch(`${baseUrl}/api/v1/upload`, {
        method: "POST",
        headers: uploadHeaders(options),
        body,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Upload failed: ${response.status} - ${error}`);
      }

      return normalizePushResult(await response.json() as PushResponsePayload);
    },

    download,

    async pull(id: string): Promise<string> {
      return (await download(id)).text();
    },
  };
}

const defaultClient = createClient();

export const shrd = {
  push: defaultClient.push,
  upload: defaultClient.upload,
  download: defaultClient.download,
  pull: defaultClient.pull,
  createClient,
};

export default shrd;
