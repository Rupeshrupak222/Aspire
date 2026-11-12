// ============================================================================
// ASPIRE DAY 23: RESPONSIVE LUXURY EMAIL LAYOUT
// ============================================================================

/**
 * Escapes HTML characters safely to prevent injection attacks.
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wraps template body content in the master responsive Aspire luxury layout.
 */
function renderEmailLayout({
  title,
  preheader = '',
  contentHtml,
  contentText,
  organizationName = 'Aspire by Adyapan',
  organizationLogoUrl = null,
  dashboardUrl = 'https://aspire.adyapan.internal',
  unsubscribeUrl = null
}) {
  const safeTitle = escapeHtml(title);
  const safePreheader = escapeHtml(preheader);
  const safeOrgName = escapeHtml(organizationName);
  const year = new Date().getFullYear();

  const logoMarkup = organizationLogoUrl
    ? `<img src="${escapeHtml(organizationLogoUrl)}" alt="${safeOrgName}" style="max-height: 40px; max-width: 180px; display: block; border: 0;" />`
    : `<div style="font-family: 'Playfair Display', Georgia, serif; font-size: 24px; font-weight: 700; color: #F5F3EF; letter-spacing: -0.5px;">
        Aspire <span style="font-family: 'Poppins', sans-serif; font-size: 13px; font-weight: 500; color: #FFC900; letter-spacing: 1px; text-transform: uppercase;">by Adyapan</span>
       </div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #08090B;
      color: #F5F3EF;
      font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      -webkit-text-size-adjust: 100%;
    }
    table { border-collapse: separate; mso-table-lspace: 0pt; mso-table-rspace: 0pt; width: 100%; }
    td { font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; vertical-align: top; }
    .email-container { max-width: 600px; margin: 0 auto; }
    .email-card {
      background-color: #121418;
      border: 1px solid #22262E;
      border-radius: 12px;
      overflow: hidden;
    }
    .cta-btn {
      display: inline-block;
      background-color: #FFC900;
      color: #08090B !important;
      font-family: 'Poppins', sans-serif;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      padding: 14px 28px;
      border-radius: 8px;
      letter-spacing: 0.5px;
      text-align: center;
    }
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; padding: 12px !important; }
      .email-card-inner { padding: 24px 18px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #08090B; font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  ${safePreheader ? `<div style="display: none; max-height: 0px; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px; color: #08090B;">${safePreheader}</div>` : ''}

  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #08090B; padding: 32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" class="email-container" width="600" style="max-width: 600px; width: 100%; margin: 0 auto;">
          <!-- Header -->
          <tr>
            <td style="padding: 0 0 24px 0; text-align: left;">
              ${logoMarkup}
            </td>
          </tr>

          <!-- Main Card -->
          <tr>
            <td class="email-card" style="background-color: #121418; border: 1px solid #22262E; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td class="email-card-inner" style="padding: 36px 36px 40px 36px;">
                    ${contentHtml}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 12px; text-align: center; font-size: 12px; color: #71717A; line-height: 1.6;">
              <p style="margin: 0 0 8px 0; color: #A1A1AA; font-weight: 500;">
                ${safeOrgName} &bull; Scholarship Assessment & Technical Evaluation
              </p>
              <p style="margin: 0 0 8px 0;">
                You received this transactional notification regarding your account or assessment activity.
              </p>
              <p style="margin: 0; color: #52525B;">
                &copy; ${year} Adyapan. All rights reserved. &bull; <a href="${escapeHtml(dashboardUrl)}" style="color: #FFC900; text-decoration: none;">Portal Dashboard</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `
============================================================
${organizationName.toUpperCase()}
============================================================

${contentText}

------------------------------------------------------------
Dashboard: ${dashboardUrl}
(c) ${year} Adyapan. All rights reserved.
============================================================
`.trim();

  return { html, text };
}

module.exports = {
  escapeHtml,
  renderEmailLayout
};

