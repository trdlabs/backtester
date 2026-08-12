import type { ValidationIssue } from '@trading/research-contracts/research';

// Shared runner error. `code` becomes the job's terminal_code; `terminalStatus` selects the terminal
// state (sandbox wall-time → timed_out; everything else → failed). Lives apart from the worker so the
// sandbox executor can throw it without a circular import.

export class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly terminalStatus: 'failed' | 'timed_out' = 'failed',
    /**
     * Структурированная причина отказа — то, чего `code` сказать не может.
     *
     * Для большинства кодов её нет и не нужно: `missing_dataset` или `lease_expired` — сами по себе
     * полная причина. `validation_error` объединяет десятки разных отказов, и без подробности
     * оператор видит слово, из которого не следует ничего.
     *
     * Именно СТРУКТУРА, а не текст: `code`, `message`, `path` контракта. Склеенная строка
     * заставила бы каждого читателя разбирать её обратно, каждого по-своему, а пустой JSON Pointer
     * (`path: ''`, нормативный для причины без нарушающего узла) в ней исчез бы молча.
     */
    readonly issues?: readonly ValidationIssue[],
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}
