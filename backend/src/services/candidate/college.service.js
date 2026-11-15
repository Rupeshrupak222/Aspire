// ============================================================================
// ASPIRE DAY 25: COLLEGE & INSTITUTION AUTOCOMPLETE SERVICE
// ============================================================================

const { db } = require('../../db');

/**
 * Searches the verified colleges catalogue and historical student institutions.
 * @param {string} query - Case-insensitive prefix/sub-string search term
 * @param {number} limit - Maximum results to return (default: 10, max: 50)
 * @returns {Array<Object>} List of matched institutions
 */
function searchColleges(query = '', limit = 10) {
  const cleanQ = (query || '').trim().toLowerCase();
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);

  if (!cleanQ) {
    // Return top accredited institutions by default
    return db.prepare(`
      SELECT id, name, city, state, category
      FROM colleges
      ORDER BY id ASC
      LIMIT ?
    `).all(safeLimit);
  }

  // Parameterized LIKE search on verified catalogue
  const catalogMatches = db.prepare(`
    SELECT id, name, city, state, category
    FROM colleges
    WHERE LOWER(name) LIKE ? OR LOWER(city) LIKE ?
    ORDER BY
      CASE
        WHEN LOWER(name) LIKE ? THEN 1
        WHEN LOWER(name) LIKE ? THEN 2
        ELSE 3
      END,
      name ASC
    LIMIT ?
  `).all(
    `%${cleanQ}%`,
    `%${cleanQ}%`,
    `${cleanQ}%`,       // Prefix match gets highest priority
    `% ${cleanQ}%`,      // Word boundary match gets second priority
    safeLimit
  );

  // If catalogue has enough results, return directly
  if (catalogMatches.length >= safeLimit) {
    return catalogMatches;
  }

  // Supplement with distinct historical entries from students table if still room
  const existingNames = new Set(catalogMatches.map((c) => c.name.toLowerCase()));
  const remainingSlots = safeLimit - catalogMatches.length;

  const studentMatches = db.prepare(`
    SELECT DISTINCT college as name
    FROM students
    WHERE college IS NOT NULL
      AND TRIM(college) != ''
      AND LOWER(college) LIKE ?
    LIMIT ?
  `).all(`%${cleanQ}%`, remainingSlots * 2);

  for (const row of studentMatches) {
    const trimmed = (row.name || '').trim();
    if (trimmed && !existingNames.has(trimmed.toLowerCase())) {
      existingNames.add(trimmed.toLowerCase());
      catalogMatches.push({
        id: `legacy_${catalogMatches.length + 1}`,
        name: trimmed,
        city: null,
        state: null,
        category: 'Affiliated / Registered Institution'
      });
      if (catalogMatches.length >= safeLimit) break;
    }
  }

  return catalogMatches;
}

module.exports = {
  searchColleges
};

