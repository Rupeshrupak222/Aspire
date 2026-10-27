// Production HTTP Security Headers using Helmet.
// Enforces clickjacking prevention, MIME sniffing mitigation, restrictive CSP, and Permissions-Policy.
const helmet = require('helmet');

const isProd = process.env.NODE_ENV === 'production';

function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Needed for instructions page & local client config
        styleSrc: ["'self'", "'unsafe-inline'"],  // Needed for dynamic inline color tokens & UI states
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"], // Defends against clickjacking
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    // Explicit clickjacking defense
    frameguard: { action: 'deny' },
    // MIME-type sniffing defense
    noSniff: true,
    // Referrer policy
    referrerPolicy: { policy: 'same-origin' },
    // Strict Transport Security (HSTS) in production
    hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' }
  });
}

// Extra custom permissions policy header
function permissionsPolicy(req, res, next) {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
}

module.exports = {
  securityHeaders,
  permissionsPolicy
};
