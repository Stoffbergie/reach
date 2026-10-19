import { defaultCommandTimeoutSeconds, maxCommandTimeoutSeconds } from "./config";

export class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
  }
}

export class BadRequestError extends Error {}

export async function readLimitedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new PayloadTooLargeError(maxBytes);
  return bytes;
}

export function textResponse(value: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(value, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers }
  });
}

export function cleanString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

export function normalizeTimeout(value: unknown): number {
  if (value === null || value === undefined || value === "") return defaultCommandTimeoutSeconds;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultCommandTimeoutSeconds;
  return Math.min(Math.max(Math.trunc(parsed), 1), maxCommandTimeoutSeconds);
}
