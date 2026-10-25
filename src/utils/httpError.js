// Throw from anywhere inside a route; the global error handler turns it into JSON.
class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
module.exports = { HttpError };
