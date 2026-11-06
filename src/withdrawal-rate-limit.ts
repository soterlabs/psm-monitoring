export class WithdrawalRateLimitError extends Error {
  constructor(readonly retryAfter: string | null) {
    super("Withdrawal index is temporarily rate limited");
  }
}

export interface WithdrawalRefreshState {
  retryAt: string | null;
  failures: number;
  error: { message: string; at: string; code?: "rate_limited" } | null;
}

export function withdrawalRetryAt(header: string | null, failures: number, now = Date.now()): string {
  const seconds = header?.trim() ? Number(header) : NaN;
  const requested = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : header ? Date.parse(header) : NaN;
  const fallback = now + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 5));
  const valid = Number.isFinite(requested) && requested <= 8.64e15;
  return new Date(Math.max(now + 60_000, valid ? requested : fallback)).toISOString();
}
