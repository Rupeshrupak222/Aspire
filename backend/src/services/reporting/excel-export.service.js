// ============================================================================
// ASPIRE DAY 20: EXCEL EXPORT SERVICE
// ============================================================================
// Multi-worksheet Excel (.xlsx) workbook generator using SheetJS (xlsx 0.18.5).
// Implements formula injection mitigation, auto-column widths, and
// structured institutional summary sheets.
// ============================================================================

const XLSX = require('xlsx');

/**
 * Sanitizes cell value for Excel to mitigate Formula Injection.
 */
function sanitizeExcelCell(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number' || typeof val === 'boolean') return val;

  const str = String(val);
  const trimmed = str.trimStart();
  if (/^[=+\-@\t\r]/.test(trimmed)) {
    return `'${str}`;
  }
  return str;
}

/**
 * Computes optimal column widths based on maximum string lengths.
 */
function calculateColumnWidths(headers, rows) {
  return headers.map((h, colIndex) => {
    let maxLen = h.length;
    for (const r of rows) {
      const cellVal = r[colIndex] !== undefined && r[colIndex] !== null ? String(r[colIndex]) : '';
      if (cellVal.length > maxLen) {
        maxLen = cellVal.length;
      }
    }
    return { wch: Math.min(60, Math.max(12, maxLen + 3)) };
  });
}

/**
 * Generates an Excel workbook buffer from report data.
 * @param {Object} reportData - Normalized report object
 * @returns {Buffer} - .xlsx binary buffer
 */
function generateExcel(reportData) {
  const { reportType, title, summary, columns, records } = reportData;

  const workbook = XLSX.utils.book_new();

  // Set workbook metadata properties
  workbook.Props = {
    Title: title || 'Aspire Report',
    Subject: `${reportType} reporting export`,
    Author: 'Aspire by Adyapan',
    Company: 'Adyapan Assessment SaaS',
    CreatedDate: new Date()
  };

  // 1. Primary Data Worksheet
  const headerLabels = columns.map((c) => c.label);
  const dataRows = records.map((rec) => {
    return columns.map((col) => sanitizeExcelCell(rec[col.key]));
  });

  const primarySheetData = [headerLabels, ...dataRows];
  const primarySheet = XLSX.utils.aoa_to_sheet(primarySheetData);

  // Auto-width columns
  primarySheet['!cols'] = calculateColumnWidths(headerLabels, dataRows);

  const primarySheetName = getPrimarySheetName(reportType);
  XLSX.utils.book_append_sheet(workbook, primarySheet, primarySheetName);

  // 2. Summary & Overview Worksheet
  if (summary) {
    const summaryRows = [
      ['REPORT OVERVIEW', ''],
      ['Report Type', reportType.toUpperCase()],
      ['Title', title],
      ['Generated At', new Date().toISOString()],
      ['Total Records', records.length],
      ['', ''],
      ['KEY METRIC', 'VALUE']
    ];

    for (const [k, v] of Object.entries(summary)) {
      const formattedKey = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      summaryRows.push([formattedKey, v !== null && v !== undefined ? String(v) : '0']);
    }

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
    summarySheet['!cols'] = [{ wch: 32 }, { wch: 28 }];
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary & KPIs');
  }

  // Generate binary Excel buffer
  const buffer = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true
  });

  return buffer;
}

function getPrimarySheetName(reportType) {
  switch (reportType) {
    case 'candidates': return 'Candidate Roster';
    case 'exams': return 'Exam Performance';
    case 'colleges': return 'Colleges Benchmark';
    case 'scholarships': return 'Scholarship Grants';
    case 'questions': return 'Question Psychometrics';
    case 'proctoring': return 'Integrity Risk Audit';
    default: return 'Data';
  }
}

module.exports = {
  sanitizeExcelCell,
  generateExcel
};

