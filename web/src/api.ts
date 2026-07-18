const jsonHeaders = { "Content-Type": "application/json" };
export async function parseApiResponse(response: Response) {
  const text = await response.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { throw new Error(response.ok ? "服务返回了无法识别的数据" : `服务请求失败（HTTP ${response.status}）`); }
  }
  if (!response.ok) throw new Error(data?.message || data?.error || (text ? `请求失败（HTTP ${response.status}）` : "服务暂时不可用，请稍后重试"));
  return data;
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  return parseApiResponse(response) as Promise<T>;
}
export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) });
