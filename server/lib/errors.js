/** An error that maps directly to an HTTP response. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message  Safe, user-facing message.
   * @param {unknown} [details]
   */
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Please join a care circle first') => new HttpError(401, msg);
export const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const tooMany = (retryAfter) =>
  new HttpError(429, 'Too many attempts. Please wait a little and try again.', { retryAfter });
