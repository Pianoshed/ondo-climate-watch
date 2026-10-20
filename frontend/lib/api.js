export async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || "Request failed"), { status: res.status });
  return body;
}

export const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
