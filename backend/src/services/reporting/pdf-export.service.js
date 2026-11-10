// ============================================================================
// ASPIRE DAY 20: PDF REPORT SERVICE
// ============================================================================
// Multi-page, branded, print-ready PDF reporting generator using PDFKit.
// Implements A4 geometry, repeated table headers, automatic page breaking,
// and Aspire luxury visual identity accents.
// ============================================================================

const PDFDocument = require('pdfkit');

// Brand palette constants
const COLOR_MIDNIGHT = '#08090B';
const COLOR_IVORY = '#F5F3EF';
const COLOR_GOLD = '#FFC900';
const COLOR_GOLD_DARK = '#C9A227';
const COLOR_TEXT_MUTED = '#6B7280';
const COLOR_BORDER = '#E5E7EB';
const COLOR_ROW_ALT = '#F9FAFB';

/**
 * Generates a branded, multi-page PDF buffer from report data using PDFKit.
 * @param {Object} reportData - Normalized report object { title, summary, columns, records, organization }
 * @returns {Promise<Buffer>} - Resolves with PDF binary buffer
 */
function generatePdf(reportData) {
  return new Promise((resolve, reject) => {
    try {
      const {
        reportType,
        title,
        summary,
        columns,
        records,
        organization
      } = reportData;

      // Select columns (up to 8 primary columns to prevent overlapping in A4 landscape)
      const displayColumns = columns.slice(0, 8);

      // Create PDF Document (A4 Landscape, standard 36pt / 0.5in margins)
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margins: { top: 36, bottom: 44, left: 36, right: 36 },
        bufferPages: true,
        autoFirstPage: true
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const contentWidth = pageWidth - 72; // 36 margin on each side

      // ------------------------------------------------------------------------
      // Header Section
      // ------------------------------------------------------------------------
      function drawHeader() {
        doc.save();

        // Top decorative gold accent line
        doc.rect(36, 36, contentWidth, 3).fill(COLOR_GOLD);

        // Brand Title
        doc.fillColor(COLOR_MIDNIGHT)
          .font('Helvetica-Bold')
          .fontSize(16)
          .text(title || 'Aspire Assessment Report', 36, 48);

        // Subtitle & Org info
        const orgName = (organization && organization.name) ? organization.name : 'Aspire by Adyapan';
        const dateStr = new Date().toLocaleDateString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        doc.fillColor(COLOR_TEXT_MUTED)
          .font('Helvetica')
          .fontSize(9)
          .text(`Organization: ${orgName}  |  Generated: ${dateStr}  |  Scope: Institutional`, 36, 68);

        doc.restore();
      }

      drawHeader();

      // ------------------------------------------------------------------------
      // Summary KPI Metrics Strip
      // ------------------------------------------------------------------------
      let currentY = 88;
      if (summary) {
        const kpiEntries = Object.entries(summary).slice(0, 5);
        if (kpiEntries.length > 0) {
          const cardWidth = Math.floor(contentWidth / kpiEntries.length) - 6;

          kpiEntries.forEach(([key, val], idx) => {
            const cardX = 36 + idx * (cardWidth + 6);

            // Card background & border
            doc.save();
            doc.rect(cardX, currentY, cardWidth, 42)
              .fillAndStroke(COLOR_IVORY, COLOR_BORDER);

            // Left gold indicator line on card
            doc.rect(cardX, currentY, 2.5, 42).fill(COLOR_GOLD_DARK);

            const label = key.replace(/_/g, ' ').toUpperCase();
            doc.fillColor(COLOR_TEXT_MUTED)
              .font('Helvetica')
              .fontSize(6.5)
              .text(label.length > 22 ? `${label.slice(0, 20)}...` : label, cardX + 8, currentY + 7);

            doc.fillColor(COLOR_MIDNIGHT)
              .font('Helvetica-Bold')
              .fontSize(12)
              .text(val !== null && val !== undefined ? String(val) : '0', cardX + 8, currentY + 20);

            doc.restore();
          });

          currentY += 50;
        }
      }

      // ------------------------------------------------------------------------
      // Data Table
      // ------------------------------------------------------------------------
      const colCount = displayColumns.length;
      const colWidth = Math.floor(contentWidth / colCount);
      const rowHeight = 20;
      const tableStartY = currentY + 6;

      function drawTableHeader(y) {
        doc.save();
        // Header background
        doc.rect(36, y, contentWidth, rowHeight).fill(COLOR_MIDNIGHT);

        displayColumns.forEach((col, idx) => {
          const x = 36 + idx * colWidth;
          doc.fillColor('#FFFFFF')
            .font('Helvetica-Bold')
            .fontSize(7.5)
            .text(col.label, x + 4, y + 6, { width: colWidth - 8, ellipsis: true });
        });
        doc.restore();
      }

      let yPos = tableStartY;
      drawTableHeader(yPos);
      yPos += rowHeight;

      // Render records
      records.forEach((record, rIdx) => {
        // Check if page break is needed
        if (yPos + rowHeight > pageHeight - 50) {
          doc.addPage();
          drawHeader();
          yPos = 90;
          drawTableHeader(yPos);
          yPos += rowHeight;
        }

        doc.save();
        // Row background (zebra striping)
        if (rIdx % 2 === 1) {
          doc.rect(36, yPos, contentWidth, rowHeight).fill(COLOR_ROW_ALT);
        }

        // Row bottom hairline border
        doc.rect(36, yPos + rowHeight - 0.5, contentWidth, 0.5).fill(COLOR_BORDER);

        // Cells
        displayColumns.forEach((col, idx) => {
          const x = 36 + idx * colWidth;
          const val = record[col.key];
          const textVal = val !== undefined && val !== null ? String(val) : '—';

          doc.fillColor(COLOR_MIDNIGHT)
            .font('Helvetica')
            .fontSize(7)
            .text(textVal, x + 4, yPos + 6, { width: colWidth - 8, ellipsis: true });
        });

        doc.restore();
        yPos += rowHeight;
      });

      // ------------------------------------------------------------------------
      // Footers with Global Page Numbering
      // ------------------------------------------------------------------------
      const totalPages = doc.bufferedPageRange().count;
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);

        // Hairline separator
        doc.rect(36, pageHeight - 34, contentWidth, 0.5).fill(COLOR_BORDER);

        doc.fillColor(COLOR_TEXT_MUTED)
          .font('Helvetica')
          .fontSize(7)
          .text(
            'CONFIDENTIAL — FOR AUTHORIZED INSTITUTIONAL USE ONLY  |  ASPIRE BY ADYAPAN',
            36,
            pageHeight - 25,
            { align: 'left', width: contentWidth / 2 }
          );

        doc.text(
          `Page ${i + 1} of ${totalPages}`,
          36 + contentWidth / 2,
          pageHeight - 25,
          { align: 'right', width: contentWidth / 2 }
        );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generatePdf };

