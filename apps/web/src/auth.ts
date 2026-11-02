/** Private preview: authenticate before routing, including API and WebSocket requests. */
export async function authenticate(request: Request, env: { PREVIEW_USER?: string; PREVIEW_PASSWORD?: string }): Promise<Response | null> {
  const headers = { "Cache-Control": "no-store", "WWW-Authenticate": 'Basic realm="Private preview", charset="UTF-8"' };
  if (!env.PREVIEW_USER || !env.PREVIEW_PASSWORD) return new Response("Private preview is not configured", { status: 503, headers });
  const value = request.headers.get("Authorization") || "";
  const match = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(value);
  let supplied = "";
  try { if (match) supplied = atob(match[1]); } catch { /* Invalid credentials. */ }
  const encode = new TextEncoder();
  const hash = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encode.encode(s)));
  const [a, b] = await Promise.all([hash(supplied), hash(`${env.PREVIEW_USER}:${env.PREVIEW_PASSWORD}`)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return match && !diff ? null : new Response("Authentication required", { status: 401, headers });
}
