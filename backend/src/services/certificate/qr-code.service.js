// ============================================================================
// ASPIRE DAY 24: HIGH-CONTRAST QR CODE GENERATION SERVICE
// Pure Public Verification URL Encoding with PDFKit Buffer & DataURL Support
// ============================================================================

const QRCode = require('qrcode');
const logger = require('../../utils/logger');

/**
 * Generates high-quality, high-contrast QR code image as a PNG Buffer for embedding in PDFKit.
 * Strictly encodes ONLY the public verification URL.
 * Never includes secrets, signatures, claim codes, or candidate PII.
 * 
 * @param {string} verificationUrl - Canonical public verification URL
 * @param {object} options - Custom geometry and color options
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function generateQrCodeBuffer(verificationUrl, options = {}) {
  if (!verificationUrl || typeof verificationUrl !== 'string') {
    throw new Error('A valid verificationUrl string is required for QR code generation');
  }

  const width = options.width || 256;
  const margin = options.margin !== undefined ? options.margin : 2;
  const darkColor = options.darkColor || '#08090B'; // Midnight Black
  const lightColor = options.lightColor || '#FFFFFF'; // Crisp White

  try {
    const buffer = await QRCode.toBuffer(verificationUrl, {
      type: 'png',
      errorCorrectionLevel: 'H', // 30% error recovery for robust physical print scanning
      margin,
      width,
      color: {
        dark: darkColor,
        light: lightColor
      }
    });

    return buffer;
  } catch (err) {
    logger.error({ verificationUrl, err: err.message }, 'Failed generating QR code buffer');
    throw err;
  }
}

/**
 * Generates QR code as a base64 Data URL (useful for frontend previews and email embedding).
 * 
 * @param {string} verificationUrl - Canonical public verification URL
 * @param {object} options - Custom geometry and color options
 * @returns {Promise<string>} Base64 Data URL
 */
async function generateQrCodeDataUrl(verificationUrl, options = {}) {
  if (!verificationUrl || typeof verificationUrl !== 'string') {
    throw new Error('A valid verificationUrl string is required for QR code generation');
  }

  const width = options.width || 256;
  const margin = options.margin !== undefined ? options.margin : 2;
  const darkColor = options.darkColor || '#08090B';
  const lightColor = options.lightColor || '#FFFFFF';

  try {
    return await QRCode.toDataURL(verificationUrl, {
      errorCorrectionLevel: 'H',
      margin,
      width,
      color: {
        dark: darkColor,
        light: lightColor
      }
    });
  } catch (err) {
    logger.error({ verificationUrl, err: err.message }, 'Failed generating QR code DataURL');
    throw err;
  }
}

module.exports = {
  generateQrCodeBuffer,
  generateQrCodeDataUrl
};

