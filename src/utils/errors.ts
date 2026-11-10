export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export const badRequest = (m: string, details?: unknown) => new ApiError(400, 'bad_request', m, details);
export const unauthorized = (m = 'Authentication required') => new ApiError(401, 'unauthorized', m);
export const forbidden = (m = 'Forbidden') => new ApiError(403, 'forbidden', m);
export const notFound = (m = 'Not found') => new ApiError(404, 'not_found', m);
export const conflict = (m: string, code = 'conflict') => new ApiError(409, code, m);
export const paymentRequired = (m = 'Premium subscription required') => new ApiError(402, 'premium_required', m);
export const tooMany = (m: string, retryAfterSeconds: number) =>
  new ApiError(429, 'too_many_requests', m, { retryAfterSeconds });
export const notImplemented = (m: string) => new ApiError(501, 'not_implemented', m);
