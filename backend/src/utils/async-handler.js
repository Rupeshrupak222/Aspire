// Async error forwarding wrapper for Express route handlers.
// Guarantees all rejected promises are routed to central error middleware.
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
