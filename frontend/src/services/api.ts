/**
 * Base fetch client.
 *
 * - Reads VITE_API_URL from env (falls back to localhost for dev).
 * - Injects Authorization header from the Zustand-persisted token in localStorage.
 * - On 401 clears auth and redirects to /login.
 * - Throws ApiError with { status, message } on non-2xx responses.
 */

export const BASE_URL =
  import.meta.env.VITE_API_URL ??
  'https://https-github-com-your-org-nosheeet-production.up.railway.app';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function getToken(): string | null {
  try {
    // Zustand persists to localStorage under 'nosheeet-auth'
    const raw = localStorage.getItem('nosheeet-auth');
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { sessionToken?: string } };
      if (parsed.state?.sessionToken && !parsed.state.sessionToken.startsWith('mock-')) {
        return parsed.state.sessionToken;
      }
    }
  } catch {
    // ignore
  }
  // Fallback: plain token key used by the existing simple frontend
  return localStorage.getItem('token');
}

export async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('nosheeet-auth');
    window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      // ignore JSON parse failure
    }
    throw new ApiError(res.status, message);
  }

  return res.json() as Promise<T>;
}

export const get  = <T>(path: string)                       => request<T>(path, { method: 'GET' });
export const post = <T>(path: string, body: unknown)        => request<T>(path, { method: 'POST',  body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown)       => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del  = <T>(path: string)                       => request<T>(path, { method: 'DELETE' });
