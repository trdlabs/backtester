/** Postgres LISTEN/NOTIFY channel for queue-wake. NOTIFY and LISTEN sides import this — never inline the literal. */
export const QUEUE_NOTIFY_CHANNEL = 'backtest_job_queued';
