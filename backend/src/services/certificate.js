// ============================================================================
// ASPIRE DAY 24: UPGRADED PDF CERTIFICATE GENERATION SERVICE (PDFKit)
// A4 Landscape with Embedded Verification QR Code, Public URL & Seal
// ============================================================================

const PDFDocument = require('pdfkit');
const metrics = require('../utils/metrics');
const { db } = require('../db');
const path = require('path');
const fs = require('fs');
const { generateQrCodeBuffer } = require('./certificate/qr-code.service');

// Default Adyapan palette
const DEFAULT_ORANGE = '#F97316';
const DEFAULT_NAVY = '#0B1F3A';
const DEFAULT_NAVY_SOFT = '#13294B';
const GOLD = '#C9A227';
const GOLD_SOFT = '#E6C860';
const INK = '#1F2937';
const MUTE = '#6B7280';
const LIGHT = '#9CA3AF';
const PAPER = '#FFFFFF';
const CREAM = '#FBFAF6';

function drawDefaultLogoMark(doc, cx, cy, r, primaryColor, accentColor) {
  doc.save();
  doc.circle(cx, cy, r).lineWidth(2.5).strokeColor(accentColor).stroke();
  doc.circle(cx, cy, r - 5).lineWidth(1).strokeColor(GOLD).stroke();
  doc.circle(cx, cy, r - 9).fill(primaryColor);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(r * 1.05)
    .text('A', cx - r, cy - r * 0.62, { width: r * 2, align: 'center' });
  doc.restore();
}

function drawSeal(doc, cx, cy, r, primaryColor, accentColor, orgName) {
  doc.save();
  doc.circle(cx, cy, r).lineWidth(2).strokeColor(GOLD).stroke();
  doc.circle(cx, cy, r - 4).fillOpacity(0.12).fill(GOLD);
  doc.fillOpacity(1);
  doc.circle(cx, cy, r - 10).lineWidth(1).strokeColor(GOLD_SOFT).stroke();
  // Ribbon tails
  doc.save();
  doc.polygon([cx - 9, cy + r - 4], [cx - 3, cy + r + 22], [cx + 1, cy + r + 6]).fill(accentColor);
  doc.polygon([cx + 9, cy + r - 4], [cx + 3, cy + r + 22], [cx - 1, cy + r + 6]).fill(accentColor);
  doc.restore();
  // Seal text
  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(8)
    .text('VERIFIED', cx - r, cy - 12, { width: r * 2, align: 'center' });
  const sealOrg = (orgName || 'ADYAPAN').slice(0, 16).toUpperCase();
  doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(7)
    .text(sealOrg, cx - r, cy - 2, { width: r * 2, align: 'center' });
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(6)
    .text('ASPIRE', cx - r, cy + 7, { width: r * 2, align: 'center' });
  doc.restore();
}

const certificateCache = new Map();
const MAX_CACHE_SIZE = 1000;

function getCertificateCacheKey(organizationId, certificateId) {
  const orgPart = organizationId !== undefined && organizationId !== null ? String(organizationId) : 'global';
  return `${orgPart}:${certificateId}`;
}

function clearCertificateCache() {
  certificateCache.clear();
}

function clearCertificateCacheForOrg(organizationId) {
  if (!organizationId) {
    certificateCache.clear();
    return;
  }
  const prefix = `${organizationId}:`;
  for (const key of certificateCache.keys()) {
    if (key.startsWith(prefix)) {
      certificateCache.delete(key);
    }
  }
}

function clearCertificateCacheForCert(organizationId, certificateId) {
  if (!certificateId) return;
  const key = getCertificateCacheKey(organizationId, certificateId);
  certificateCache.delete(key);
  certificateCache.delete(`global:${certificateId}`);
  if (organizationId) {
    certificateCache.delete(`${organizationId}:${certificateId}`);
  }
}

// Hook into certificate lifecycle service for automated cache invalidation on revoke/reissue
const { setClearCacheHook } = require('./certificate/certificate.service');
setClearCacheHook(clearCertificateCacheForCert);

function getCachedCertificate(organizationId, certificateId) {
  if (!certificateId) return null;
  const key = getCertificateCacheKey(organizationId, certificateId);
  return certificateCache.get(key) || null;
}

/**
 * Generates an official PDF certificate with embedded QR code, public verification URL,
 * and dynamic organization branding.
 */
async function generateCertificate({
  name,
  percentage,
  scholarshipPct,
  certificateId,
  dateStr,
  brandName,
  organizationId = null,
  qrCodeBuffer = null,
  verificationUrl = null
}) {
  const cacheKey = certificateId ? getCertificateCacheKey(organizationId, certificateId) : null;
  if (cacheKey && certificateCache.has(cacheKey)) {
    return certificateCache.get(cacheKey);
  }

  // Fetch trusted organization branding
  let org = null;
  if (organizationId) {
    try {
      org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId);
    } catch { }
  }

  const primaryColor = (org && org.primary_color) || DEFAULT_NAVY;
  const secondaryColor = (org && org.secondary_color) || DEFAULT_NAVY_SOFT;
  const accentColor = (org && org.accent_color) || DEFAULT_ORANGE;

  let branding = {};
  if (org && org.certificate_branding_json) {
    try {
      branding = JSON.parse(org.certificate_branding_json);
    } catch { }
  }

  const certTitle = branding.certificate_title || 'Certificate of Achievement';
  const displayBrand = branding.certificate_organization_name || (org && org.name) || brandName || 'Adyapan';
  const signatoryName = branding.authorized_signatory_name || 'Co-Founder';
  const signatoryTitle = branding.authorized_signatory_title || (org ? org.name : 'Adyapan Edutech Pvt. Ltd.');
  const footerText = branding.footer_text || 'Recognised by NSDC · Skill India Digital Hub · Ministry of MSME, Govt. of India';

  // Construct canonical verification URL
  const publicBaseUrl = process.env.CERTIFICATE_PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://aspire.adyapan.com';
  const effectiveVerificationUrl = verificationUrl || `${publicBaseUrl}/verify/${certificateId}`;
  const cleanDisplayUrl = effectiveVerificationUrl.replace(/^https?:\/\//i, '');

  // Pre-generate QR code buffer if not supplied
  let effectiveQrBuffer = qrCodeBuffer;
  if (!effectiveQrBuffer && certificateId) {
    try {
      effectiveQrBuffer = await generateQrCodeBuffer(effectiveVerificationUrl, {
        width: 180,
        margin: 1,
        darkColor: primaryColor || '#08090B'
      });
    } catch (e) {
      // Continue without QR if generation throws
    }
  }

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const doc = new PDFDocument({ size: [842, 595], margin: 0 }); // A4 landscape
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      metrics.recordCertGeneration(Date.now() - t0);
      const buffer = Buffer.concat(chunks);
      if (cacheKey) {
        if (certificateCache.size >= MAX_CACHE_SIZE) {
          const oldestKey = certificateCache.keys().next().value;
          certificateCache.delete(oldestKey);
        }
        certificateCache.set(cacheKey, buffer);
      }
      resolve(buffer);
    });
    doc.on('error', reject);

    const W = 842, H = 595;

    // ---------- Background ----------
    doc.rect(0, 0, W, H).fill(CREAM);

    // Decorative corner accents (primary and accent color wedges)
    doc.save();
    doc.polygon([0, 0], [150, 0], [0, 150]).fillOpacity(0.9).fill(primaryColor);
    doc.polygon([0, 0], [120, 0], [0, 120]).fillOpacity(1).fill(accentColor);
    doc.polygon([W, H], [W - 150, H], [W, H - 150]).fillOpacity(0.9).fill(primaryColor);
    doc.polygon([W, H], [W - 120, H], [W, H - 120]).fillOpacity(1).fill(accentColor);
    doc.restore();

    // Inner paper panel + double border
    doc.rect(28, 28, W - 56, H - 56).fill(PAPER);
    doc.lineWidth(3).strokeColor(primaryColor).rect(28, 28, W - 56, H - 56).stroke();
    doc.lineWidth(1).strokeColor(GOLD).rect(38, 38, W - 76, H - 76).stroke();

    // ---------- Header: Logo + Organization Brand ----------
    drawDefaultLogoMark(doc, W / 2, 88, 28, primaryColor, accentColor);

    doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(20)
      .text(displayBrand.toUpperCase(), 0, 122, { align: 'center', width: W, characterSpacing: 3 });
    doc.fillColor(accentColor).font('Helvetica-Bold').fontSize(8.5)
      .text('LEARN  ·  EARN  ·  GET PLACED', 0, 146, { align: 'center', width: W, characterSpacing: 2 });

    // ---------- Title ----------
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(28)
      .text(certTitle, 0, 172, { align: 'center', width: W });
    // Underline flourish
    doc.strokeColor(GOLD).lineWidth(1.5)
      .moveTo(W / 2 - 140, 208).lineTo(W / 2 + 140, 208).stroke();

    doc.fillColor(MUTE).font('Helvetica').fontSize(11)
      .text('This is proudly presented to', 0, 218, { align: 'center', width: W });

    // ---------- Recipient name ----------
    doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(36)
      .text(name, 60, 240, { align: 'center', width: W - 120 });

    // Thin name underline
    doc.strokeColor(accentColor).lineWidth(1.2)
      .moveTo(W / 2 - 150, 292).lineTo(W / 2 + 150, 292).stroke();

    // ---------- Achievement line ----------
    const pct = Number(percentage).toFixed(1);
    doc.fillColor(INK).font('Helvetica').fontSize(12.5)
      .text(`for scoring ${pct}% in the Aspire Scholarship Test`, 0, 306, { align: 'center', width: W });

    if (scholarshipPct > 0) {
      // Scholarship highlight pill
      const label = `Scholarship Earned: ${scholarshipPct}%`;
      doc.font('Helvetica-Bold').fontSize(15);
      const tw = doc.widthOfString(label);
      const pillW = tw + 40, pillH = 28;
      const px = (W - pillW) / 2, py = 328;
      doc.roundedRect(px, py, pillW, pillH, 14).fill(accentColor);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15)
        .text(label, px, py + 7, { width: pillW, align: 'center' });
    } else {
      doc.fillColor(secondaryColor).font('Helvetica-Bold').fontSize(15)
        .text('Certificate of Participation', 0, 332, { align: 'center', width: W });
    }

    // ---------- Tagline ----------
    doc.fillColor(LIGHT).font('Helvetica-Oblique').fontSize(10.5)
      .text('Aspire. Achieve. Adyapan.', 0, 370, { align: 'center', width: W });

    // ---------- Center: Verification Seal ----------
    drawSeal(doc, W / 2, 442, 28, primaryColor, accentColor, displayBrand);

    // ---------- Left: QR Code & Verification Info ----------
    const qrSize = 58;
    const leftX = 64;
    const leftY = 416;

    if (effectiveQrBuffer) {
      try {
        doc.image(effectiveQrBuffer, leftX, leftY, { width: qrSize, height: qrSize });
      } catch (err) { }
    } else {
      // Fallback placeholder box
      doc.rect(leftX, leftY, qrSize, qrSize).lineWidth(1).strokeColor(GOLD).stroke();
      doc.fillColor(MUTE).font('Helvetica').fontSize(8).text('QR CODE', leftX, leftY + 24, { width: qrSize, align: 'center' });
    }

    const textX = leftX + qrSize + 10;
    const textY = leftY + 2;

    doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(9)
      .text(`ID: ${certificateId}`, textX, textY, { width: 175 });
    doc.fillColor(MUTE).font('Helvetica').fontSize(8)
      .text(`Issued: ${dateStr}`, textX, textY + 13, { width: 175 });
    doc.fillColor(MUTE).font('Helvetica').fontSize(7.5)
      .text('Scan QR or verify at:', textX, textY + 26, { width: 175 });
    doc.fillColor(accentColor).font('Helvetica-Bold').fontSize(7)
      .text(cleanDisplayUrl, textX, textY + 38, { width: 175 });

    // ---------- Right: Authorized Signatory ----------
    const sigX = W - 250, sigY = 445;
    doc.strokeColor(INK).lineWidth(1).moveTo(sigX, sigY).lineTo(sigX + 175, sigY).stroke();
    doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(10.5)
      .text(signatoryName, sigX, sigY + 6, { width: 175, align: 'center' });
    doc.fillColor(MUTE).font('Helvetica').fontSize(8.5)
      .text(signatoryTitle, sigX, sigY + 19, { width: 175, align: 'center' });

    // ---------- Bottom: Authenticity Statement & Accreditation Strip ----------
    doc.fillColor(MUTE).font('Helvetica-Oblique').fontSize(8)
      .text('This credential can be independently verified through Aspire by Adyapan.', 0, H - 68, { align: 'center', width: W });

    doc.fillColor(LIGHT).font('Helvetica').fontSize(7.5)
      .text(footerText, 0, H - 52, { align: 'center', width: W, characterSpacing: 0.3 });

    doc.end();
  });
}

module.exports = {
  generateCertificate,
  getCertificateCacheKey,
  getCachedCertificate,
  clearCertificateCache,
  clearCertificateCacheForOrg,
  clearCertificateCacheForCert
};
