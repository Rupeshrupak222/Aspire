// ============================================================================
// ASPIRE DAY 20: CSV EXPORT SERVICE
// ============================================================================
// RFC-4180 compliant CSV generator with strict Formula Injection (DDE)
// mitigation, UTF-8 output encoding, and safe field escaping.
// ============================================================================

/**
 * Mitigates CSV Formula Injection (DDE attack vectors).
 * Prevents Excel/Sheets from interpreting candidate-supplied text as executable formulas.
 * Trigger characters: '=', '+', '-', '@', '\t', '\r'
 */
function sanitizeCsvCell(value) {
  if (value === null || value === undefined) return '';

  let str = String(value);

  // If numeric or boolean, output directly
  if (typeof value === 'number' || typeof value === 'boolean') {
    return str;
  }

  // Check for formula trigger characters at start of string or after whitespace
  const trimmed = str.trimStart();
  if (/^[=+\-@\t\r]/.test(trimmed)) {
    // Prepend single quote to neutralize formula execution in spreadsheet applications
    str = `'${str}`;
  }

  // RFC-4180 escaping: if contains comma, quote, or newline, escape quotes and wrap in quotes
  if (/[",\n\r]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Generates an RFC-4180 compliant CSV string from report data.
 * @param {Object} reportData - Normalized report object { title, columns, records, summary }
 * @returns {string} - UTF-8 encoded CSV string
 */
function generateCsv(reportData) {
  const { columns, records, title, summary } = reportData;
  const lines = [];

  // UTF-8 BOM for Excel UTF-8 compatibility
  const BOM = '\uFEFF';

  // Optional: Header metadata block
  if (title) {
    lines.push(`# ${title}`);
    lines.push(`# Generated At: ${new Date().toISOString()}`);
    if (summary) {
      const summaryPairs = Object.entries(summary)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
        .join(' | ');
      lines.push(`# Summary: ${summaryPairs}`);
    }
    lines.push(''); // blank separator line
  }

  // Column header row
  const headerRow = columns.map((col) => sanitizeCsvCell(col.label)).join(',');
  lines.push(headerRow);

  // Data rows
  for (const record of records) {
    const row = columns.map((col) => {
      const rawVal = record[col.key];
      return sanitizeCsvCell(rawVal);
    }).join(',');
    lines.push(row);
  }

  return BOM + lines.join('\r\n');
}

module.exports = {
  sanitizeCsvCell,
  generateCsv
};

