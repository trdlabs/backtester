// Typed client errors. The backtester API returns `{ category, code, message }` bodies with HTTP
// status codes; the client maps them to these classes so consumers (e.g. the trading-lab adapter) can
// branch on failure kind without parsing strings.

export class BacktesterError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly category?: string,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400 — invalid request / module / run (validation_error). */
export class BacktesterValidationError extends BacktesterError {}

/** 409 — e.g. resume_token reused with a different request, or result requested before completion. */
export class BacktesterConflictError extends BacktesterError {}

/** 404 — run / artifact / dataset not found. */
export class BacktesterNotFoundError extends BacktesterError {}

/** 401 — missing or invalid bearer token. */
export class BacktesterAuthError extends BacktesterError {}

/** 429 — queue_full / rate limited; safe to retry after Retry-After. */
export class BacktesterRateLimitError extends BacktesterError {
  constructor(
    status: number,
    code: string,
    message: string,
    category?: string,
    payload?: unknown,
    /** Server's numeric Retry-After (seconds), when it sent one — a hint for the caller's own scheduling. */
    readonly retryAfterS?: number,
  ) {
    super(status, code, message, category, payload);
  }
}
