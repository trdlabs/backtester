// Shared runner error. `code` becomes the job's terminal_code; `terminalStatus` selects the terminal
// state (sandbox wall-time → timed_out; everything else → failed). Lives apart from the worker so the
// sandbox executor can throw it without a circular import.

export class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly terminalStatus: 'failed' | 'timed_out' = 'failed',
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}
