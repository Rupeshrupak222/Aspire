// Input sanitization and SQL LIKE pattern escaping helpers.

// Strips null bytes and dangerous invisible control characters without corrupting
// programming code tokens such as `<iostream>`, `a < b`, or `x > y`.
function sanitizeText(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\0/g, '').trim();
}

// Escapes `%`, `_`, and `\` so user input in SQLite LIKE queries is treated as literal text.
function escapeLike(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\\%_]/g, '\\$&');
}

module.exports = {
  sanitizeText,
  escapeLike
};
