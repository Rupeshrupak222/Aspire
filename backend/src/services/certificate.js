// Branded PDF certificate generation (PDFKit). A4 landscape.
// Redesigned to resemble Adyapan's official recognition certificates:
// crest-style logo mark, navy + gold palette, verification seal,
// signature line (Co-Founder), and a recognitions strip.
const PDFDocument = require('pdfkit');
const metrics = require('../utils/metrics');

// --- Adyapan palette ---
const ORANGE = '#F97316';   // Adyapan brand accent
const NAVY = '#0B1F3A';     // deep navy (primary)
const NAVY_SOFT = '#13294B';
const GOLD = '#C9A227';      // seal / foil gold
const GOLD_SOFT = '#E6C860';
const INK = '#1F2937';
const MUTE = '#6B7280';
const LIGHT = '#9CA3AF';
const PAPER = '#FFFFFF';
const CREAM = '#FBFAF6';

function drawLogoMark(doc, cx, cy, r) {
  // Circular crest with a stylised "A" — stands in for the Adyapan mark.
  doc.save();
  // outer ring
  doc.circle(cx, cy, r).lineWidth(2.5).strokeColor(ORANGE).stroke();
  doc.circle(cx, cy, r - 5).lineWidth(1).strokeColor(GOLD).stroke();
  // filled inner disc
  doc.circle(cx, cy, r - 9).fill(NAVY);
  // "A" monogram
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(r * 1.05)
    .text('A', cx - r, cy - r * 0.62, { width: r * 2, align: 'center' });
  doc.restore();
}

function drawSeal(doc, cx, cy, r) {
  // Gold verification seal with scalloped feel (two rings + star burst).
  doc.save();
  doc.circle(cx, cy, r).lineWidth(2).strokeColor(GOLD).stroke();
  doc.circle(cx, cy, r - 4).fillOpacity(0.12).fill(GOLD);
  doc.fillOpacity(1);
  doc.circle(cx, cy, r - 10).lineWidth(1).strokeColor(GOLD_SOFT).stroke();
  // ribbon tails
  doc.save();
  doc.polygon([cx - 9, cy + r - 4], [cx - 3, cy + r + 22], [cx + 1, cy + r + 6]).fill(ORANGE);
  doc.polygon([cx + 9, cy + r - 4], [cx + 3, cy + r + 22], [cx - 1, cy + r + 6]).fill(ORANGE);
  doc.restore();
  // seal text
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8)
    .text('VERIFIED', cx - r, cy - 12, { width: r * 2, align: 'center' });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(7)
    .text('ADYAPAN', cx - r, cy - 2, { width: r * 2, align: 'center' });
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(6)
    .text('ASPIRE', cx - r, cy + 7, { width: r * 2, align: 'center' });
  doc.restore();
}

const certificateCache = new Map();
const MAX_CACHE_SIZE = 1000;

function clearCertificateCache() {
  certificateCache.clear();
}

function generateCertificate({ name, percentage, scholarshipPct, certificateId, dateStr, brandName }) {
  if (certificateId && certificateCache.has(certificateId)) {
    return Promise.resolve(certificateCache.get(certificateId));
  }

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const doc = new PDFDocument({ size: [842, 595], margin: 0 }); // A4 landscape
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      metrics.recordCertGeneration(Date.now() - t0);
      const buffer = Buffer.concat(chunks);
      if (certificateId) {
        if (certificateCache.size >= MAX_CACHE_SIZE) {
          const oldestKey = certificateCache.keys().next().value;
          certificateCache.delete(oldestKey);
        }
        certificateCache.set(certificateId, buffer);
      }
      resolve(buffer);
    });
    doc.on('error', reject);

    const W = 842, H = 595;
    const brand = brandName || 'Adyapan';

    // ---------- Background ----------
    doc.rect(0, 0, W, H).fill(CREAM);

    // Decorative corner accents (navy wedges)
    doc.save();
    doc.polygon([0, 0], [150, 0], [0, 150]).fillOpacity(0.9).fill(NAVY);
    doc.polygon([0, 0], [120, 0], [0, 120]).fillOpacity(1).fill(ORANGE);
    doc.polygon([W, H], [W - 150, H], [W, H - 150]).fillOpacity(0.9).fill(NAVY);
    doc.polygon([W, H], [W - 120, H], [W, H - 120]).fillOpacity(1).fill(ORANGE);
    doc.restore();

    // Inner paper panel + double border
    doc.rect(28, 28, W - 56, H - 56).fill(PAPER);
    doc.lineWidth(3).strokeColor(NAVY).rect(28, 28, W - 56, H - 56).stroke();
    doc.lineWidth(1).strokeColor(GOLD).rect(38, 38, W - 76, H - 76).stroke();

    // ---------- Header: logo + brand ----------
    drawLogoMark(doc, W / 2, 92, 30);

    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(22)
      .text(brand.toUpperCase(), 0, 128, { align: 'center', width: W, characterSpacing: 3 });
    doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(9)
      .text('LEARN  ·  EARN  ·  GET PLACED', 0, 154, { align: 'center', width: W, characterSpacing: 2 });

    // ---------- Title ----------
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(30)
      .text('Certificate of Achievement', 0, 182, { align: 'center', width: W });
    // underline flourish
    doc.strokeColor(GOLD).lineWidth(1.5)
      .moveTo(W / 2 - 150, 220).lineTo(W / 2 + 150, 220).stroke();

    doc.fillColor(MUTE).font('Helvetica').fontSize(12)
      .text('This is proudly presented to', 0, 232, { align: 'center', width: W });

    // ---------- Recipient name ----------
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(38)
      .text(name, 60, 256, { align: 'center', width: W - 120 });

    // thin name underline
    doc.strokeColor(ORANGE).lineWidth(1.2)
      .moveTo(W / 2 - 160, 310).lineTo(W / 2 + 160, 310).stroke();

    // ---------- Achievement line ----------
    const pct = Number(percentage).toFixed(1);
    doc.fillColor(INK).font('Helvetica').fontSize(13)
      .text(`for scoring ${pct}% in the Aspire Scholarship Test`, 0, 324, { align: 'center', width: W });

    if (scholarshipPct > 0) {
      // Scholarship highlight pill
      const label = `Scholarship Earned: ${scholarshipPct}%`;
      doc.font('Helvetica-Bold').fontSize(16);
      const tw = doc.widthOfString(label);
      const pillW = tw + 44, pillH = 30;
      const px = (W - pillW) / 2, py = 348;
      doc.roundedRect(px, py, pillW, pillH, 15).fill(ORANGE);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(16)
        .text(label, px, py + 8, { width: pillW, align: 'center' });
    } else {
      doc.fillColor(NAVY_SOFT).font('Helvetica-Bold').fontSize(16)
        .text('Certificate of Participation', 0, 352, { align: 'center', width: W });
    }

    // ---------- Tagline ----------
    doc.fillColor(LIGHT).font('Helvetica-Oblique').fontSize(11)
      .text('Aspire. Achieve. Adyapan.', 0, 392, { align: 'center', width: W });

    // ---------- Verification seal (center-right above footer) ----------
    drawSeal(doc, W / 2, 452, 30);

    // ---------- Signature (right) ----------
    const sigX = W - 260, sigY = 470;
    doc.strokeColor(INK).lineWidth(1).moveTo(sigX, sigY).lineTo(sigX + 180, sigY).stroke();
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11)
      .text('Co-Founder', sigX, sigY + 6, { width: 180, align: 'center' });
    doc.fillColor(MUTE).font('Helvetica').fontSize(9)
      .text('Adyapan Edutech Pvt. Ltd.', sigX, sigY + 20, { width: 180, align: 'center' });

    // ---------- Issue details (left) ----------
    const detX = 70, detY = 470;
    doc.strokeColor(INK).lineWidth(1).moveTo(detX, detY).lineTo(detX + 180, detY).stroke();
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9)
      .text(`Certificate ID: ${certificateId}`, detX, detY + 6, { width: 180, align: 'center' });
    doc.fillColor(MUTE).font('Helvetica').fontSize(9)
      .text(`Issued: ${dateStr}`, detX, detY + 20, { width: 180, align: 'center' });

    // ---------- Recognitions strip (bottom center) ----------
    doc.fillColor(LIGHT).font('Helvetica').fontSize(7.5)
      .text('Recognised by NSDC · Skill India Digital Hub · Ministry of MSME, Govt. of India',
        0, H - 58, { align: 'center', width: W, characterSpacing: 0.3 });

    doc.end();
  });
}

module.exports = { generateCertificate };
