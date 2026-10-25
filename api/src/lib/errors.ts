export type ErrorDetail = { path?: string; message: string };

// One error type for the whole API. Services throw it, the error handler turns it into JSON.
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "AppError";
  }

  static unauthorized(message = "You must be signed in") {
    return new AppError(401, "UNAUTHORIZED", message);
  }

  static forbidden(message = "You do not have permission to do this") {
    return new AppError(403, "FORBIDDEN", message);
  }

  static notFound(what = "Resource") {
    return new AppError(404, "NOT_FOUND", `${what} not found`);
  }

  static conflict(code: string, message: string) {
    return new AppError(409, code, message);
  }

  static validation(details: ErrorDetail[], message = "Invalid request data") {
    return new AppError(400, "VALIDATION_ERROR", message, details);
  }
}
