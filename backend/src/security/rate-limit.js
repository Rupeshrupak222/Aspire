// Production rate limiting configuration using express-rate-limit.
const rateLimit = require('express-rate-limit');

const isTest = process.env.NODE_ENV === 'test';

function standardLimiterHandler(req, res) {
  res.status(429).json({
    success: false,
    error: 'RATE_LIMITED',
    code: 'RATE_LIMITED',
    message: 'Too many requests. Please slow down and try again later.',
    requestId: req.id || undefined
  });
}

// 1. General public API limiter
const publicApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? 50000 : 300,  // 300 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardLimiterHandler
});

// 2. Candidate registration limiter (prevent bot signups / DB spam)
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? 1000 : 15,    // 15 registrations per IP per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardLimiterHandler
});

// 3. Assessment submit limiter (prevent double-clicks & Judge0 exhaustion)
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: isTest ? 1000 : 10,   // 10 submits per IP per min
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardLimiterHandler
});

// 4. Admin authentication brute-force limiter
const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? 5000 : 40,   // 40 requests per IP per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardLimiterHandler
});

// 5. Certificate download limiter (prevent enumeration & scraping)
const certificateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 minutes
  max: isTest ? 2000 : 30,   // 30 certificate requests per IP per 5 min
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardLimiterHandler
});

// 6. Dedicated Admin login brute-force limiter (10 attempts per 15 minutes)
const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? 5000 : 10,   // 10 login attempts per IP per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardLimiterHandler
});

// 7. Dedicated coding execution limiter (prevent API spam & provider exhaustion)
const codeExecutionLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: isTest ? 5000 : 25,   // 25 execution requests per IP per min
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'RATE_LIMITED',
      code: 'RATE_LIMITED',
      message: 'Too many code execution requests. Please wait a moment before trying again.',
      requestId: req.id || undefined
    });
  }
});

module.exports = {
  publicApiLimiter,
  registerLimiter,
  submitLimiter,
  adminAuthLimiter,
  certificateLimiter,
  authLoginLimiter,
  codeExecutionLimiter,
  standardLimiterHandler
};
