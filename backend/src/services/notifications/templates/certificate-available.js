// ============================================================================
// TEMPLATE 6: CERTIFICATE AVAILABLE
// ============================================================================

const { escapeHtml, renderEmailLayout } = require('./email-layout');

function renderCertificateAvailable({
  recipientName = 'Candidate',
  examTitle = 'Scholarship Assessment',
  certificateId = '',
  scholarshipPercentage = null,
  certificateUrl = 'https://aspire.adyapan.internal',
  verificationUrl = null,
  organizationName = 'Aspire by Adyapan',
  organizationLogoUrl = null
}) {
  const safeName = escapeHtml(recipientName);
  const safeExamTitle = escapeHtml(examTitle);
  const safeCertId = escapeHtml(certificateId);
  const hasScholarship = scholarshipPercentage && Number(scholarshipPercentage) > 0;
  const safeScholarship = hasScholarship ? `${Number(scholarshipPercentage)}% Tuition Scholarship` : 'Certificate of Merit & Achievement';
  const subject = `Your Aspire Scholarship Certificate Is Ready`;
  const preheader = `Your official certificate for ${examTitle} is issued and ready for download.`;

  const contentHtml = `
    <div style="margin-bottom: 24px;">
      <span style="display: inline-block; background-color: rgba(255, 201, 0, 0.1); border: 1px solid rgba(255, 201, 0, 0.3); color: #FFC900; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; padding: 4px 10px; border-radius: 4px;">
        Official Credential Issued
      </span>
    </div>

    <h1 style="font-family: 'Playfair Display', Georgia, serif; font-size: 26px; font-weight: 700; color: #F5F3EF; margin: 0 0 16px 0; line-height: 1.3;">
      Congratulations, ${safeName}!
    </h1>

    <p style="font-size: 15px; line-height: 1.6; color: #D4D4D8; margin: 0 0 20px 0;">
      We are delighted to confirm that your official credential for <strong>${safeExamTitle}</strong> has been signed and issued.
    </p>

    <!-- Certificate Box -->
    <div style="background-color: #1A1D24; border: 1px solid #D4AF37; border-radius: 10px; padding: 24px; margin-bottom: 28px; text-align: center;">
      <div style="font-size: 12px; font-weight: 600; color: #D4AF37; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px;">
        ${safeScholarship}
      </div>
      <div style="font-family: 'Playfair Display', Georgia, serif; font-size: 20px; font-weight: 700; color: #F5F3EF; margin-bottom: 12px;">
        ${safeName}
      </div>
      <div style="font-size: 12px; color: #A1A1AA; font-family: monospace; letter-spacing: 1px;">
        Credential ID: ${safeCertId}
      </div>
    </div>

    <p style="font-size: 14px; line-height: 1.6; color: #A1A1AA; margin: 0 0 20px 0;">
      Your certificate is cryptographically verifiable and downloadable in high-resolution PDF format. You can share your verified credential with prospective academic advisors, employers, and on your professional profile.
    </p>

    ${verificationUrl ? `
    <div style="font-size: 13px; color: #71717A; margin-bottom: 24px;">
      Public Verification Link: <a href="${escapeHtml(verificationUrl)}" style="color: #FFC900; text-decoration: none;">${escapeHtml(verificationUrl)}</a>
    </div>` : ''}

    <div style="text-align: center; margin: 32px 0 16px 0;">
      <a href="${escapeHtml(certificateUrl)}" class="cta-btn" style="display: inline-block; background-color: #FFC900; color: #08090B !important; font-family: 'Poppins', sans-serif; font-size: 14px; font-weight: 600; text-decoration: none; padding: 14px 28px; border-radius: 8px; letter-spacing: 0.5px;">
        Download Certificate (PDF) &rarr;
      </a>
    </div>
  `;

  const contentText = `
Congratulations, ${recipientName}!

Your official certificate for "${examTitle}" has been issued.
Honors / Award: ${safeScholarship}
Credential ID: ${certificateId}

Download your certificate: ${certificateUrl}
${verificationUrl ? `Verify credential authenticity: ${verificationUrl}\n` : ''}
  `.trim();

  const layout = renderEmailLayout({
    title: subject,
    preheader,
    contentHtml,
    contentText,
    organizationName,
    organizationLogoUrl,
    dashboardUrl: certificateUrl
  });

  return {
    subject,
    html: layout.html,
    text: layout.text
  };
}

module.exports = { renderCertificateAvailable };

