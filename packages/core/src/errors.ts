/** An error the local API turns into an HTTP status (see `LocalApi.handle`). */
export class CoreError extends Error {
  constructor(
    readonly code: 'bad_request' | 'not_found' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}
