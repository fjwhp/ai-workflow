const jsonHeaders = { "Content-Type": "application/json" };
export class ApiError extends Error {
  readonly error: string;
  readonly code: string;
  constructor(error: string, message: string, readonly details: unknown = null, readonly status?: number) {
    super(message);
    this.name = "ApiError";
    this.error = error;
    this.code = error;
  }
}
export async function parseApiResponse(response: Response) {
  const text = await response.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { throw new Error(response.ok ? "服务返回了无法识别的数据" : `服务请求失败（HTTP ${response.status}）`); }
  }
  if (!response.ok) {
    const message = data?.message || data?.error || (text ? `请求失败（HTTP ${response.status}）` : "服务暂时不可用，请稍后重试");
    throw new ApiError(data?.error || "HTTP_ERROR", message, data?.details ?? null, response.status);
  }
  return data;
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  return parseApiResponse(response) as Promise<T>;
}
export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) });
