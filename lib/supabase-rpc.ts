// ============================================================================
// lib/supabase-rpc.ts — minimal server-side PostgREST RPC client
// ============================================================================
// Deliberately NOT supabase-js: these route handlers make 1–2 RPC calls each,
// and supabase-js ≥2.4x eagerly constructs a Realtime WebSocket client that
// throws on Node<22 runtimes without the optional `ws` transport (found during
// v1 hardening). Plain fetch = zero cold-start weight, identical auth.
//
// SECURITY: the service-role key lives ONLY in server env; never import this
// module from client components.

export interface RpcResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export function supabaseEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

export async function callRpc<T = unknown>(
  fn: string,
  params: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<RpcResult<T>> {
  const env = supabaseEnv();
  if (!env) return { ok: false, status: 500, error: "supabase env not configured" };

  let res: Response;
  try {
    res = await fetch(`${env.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.key,
        authorization: `Bearer ${env.key}`,
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, status: 502, error: `network: ${(err as Error)?.message ?? err}` };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 500) };
  try {
    return { ok: true, status: res.status, data: (text ? JSON.parse(text) : null) as T };
  } catch {
    return { ok: true, status: res.status, data: text as unknown as T };
  }
}
