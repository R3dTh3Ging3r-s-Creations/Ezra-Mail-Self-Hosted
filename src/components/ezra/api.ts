export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(payload.error || `Request failed with ${response.status}.`, response.status);
  }
  return payload;
}

export function post<T>(url: string, body: unknown) {
  return api<T>(url, { method: "POST", body: JSON.stringify(body) });
}
