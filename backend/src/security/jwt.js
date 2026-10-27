// JWT signing and verification using `jose`, and password hashing using `bcrypt`.
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { SignJWT, jwtVerify } = require('jose');
const { AuthenticationError } = require('../errors/app-error');

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// Bcrypt work factor (10 for production/dev; 6 for fast test execution)
const BCRYPT_SALT_ROUNDS = isTest ? 6 : 10;

// Access token lifetime
const TOKEN_EXPIRY = process.env.AUTH_TOKEN_EXPIRES_IN || '2h';

let cachedKey = null;

function getAuthSecret() {
  const secret = process.env.AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    if (isProd) {
      console.error('[FATAL] AUTH_SECRET environment variable must be set in production!');
      process.exit(1);
    }
    // Stable ephemeral fallback for dev/test if unset
    if (!process.env._EPHEMERAL_AUTH_SECRET) {
      process.env._EPHEMERAL_AUTH_SECRET = crypto.randomBytes(32).toString('hex');
    }
    return process.env._EPHEMERAL_AUTH_SECRET;
  }
  return secret;
}

function getSigningKey() {
  const secret = getAuthSecret();
  return new TextEncoder().encode(secret);
}

// Normalize email (lowercase and trimmed)
function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

// Hash password with bcrypt
async function hashPassword(plainPassword) {
  if (typeof plainPassword !== 'string' || !plainPassword) {
    throw new Error('Password must be a non-empty string');
  }
  return bcrypt.hash(plainPassword, BCRYPT_SALT_ROUNDS);
}

// Compare password with bcrypt
async function verifyPassword(plainPassword, passwordHash) {
  if (!plainPassword || !passwordHash) return false;
  return bcrypt.compare(plainPassword, passwordHash);
}

// Sign JWT token using jose
async function signAccessToken(payload) {
  const key = getSigningKey();
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(key);
  return jwt;
}

// Verify JWT token using jose
async function verifyAccessToken(token) {
  if (!token || typeof token !== 'string') {
    throw new AuthenticationError('Authentication token is required');
  }
  const key = getSigningKey();
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256']
    });
    return payload;
  } catch (err) {
    if (err && err.code === 'ERR_JWT_EXPIRED') {
      throw new AuthenticationError('Authentication token has expired');
    }
    throw new AuthenticationError('Invalid authentication token');
  }
}

// Generate cryptographically secure random session ID
function generateSessionId() {
  return crypto.randomBytes(24).toString('hex');
}

// Compute SHA-256 hash of a token (for safe storage/lookups)
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  getAuthSecret,
  normalizeEmail,
  hashPassword,
  verifyPassword,
  signAccessToken,
  verifyAccessToken,
  generateSessionId,
  hashToken,
  TOKEN_EXPIRY
};
