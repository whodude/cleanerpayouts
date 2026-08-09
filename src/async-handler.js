// Wraps an async Express route handler so a rejected promise reaches Express's error handling
// instead of crashing/hanging the request. Express 4 doesn't auto-catch async handler
// rejections (Express 5 does), this is the standard minimal fix, applied at every route
// registration now that every handler awaits the Postgres-backed db shim.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
