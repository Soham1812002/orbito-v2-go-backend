export type ErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid_input';

export class ApplicationError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
