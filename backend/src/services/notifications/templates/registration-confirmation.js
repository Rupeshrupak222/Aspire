// ============================================================================
// TEMPLATE 1: REGISTRATION CONFIRMATION
// ============================================================================

const { escapeHtml, renderEmailLayout } = require('./email-layout');

function renderRegistrationConfirmation(options = {}) {
  const recipientName = options.recipientName || options.name || 'Candidate';
  const email = options.email || '';
  const college = options.college || '';
  const organizationName = options.organizationName || 'Aspire by Adyapan';
  const organizationLogoUrl = options.organizationLogoUrl || null;
  const dashboardUrl = options.dashboardUrl || 'https://aspire.adyapan.internal';
  const safeName = escapeHtml(recipientName);
  const safeCollege = college ? escapeHtml(college) : null;
  const safeEmail = escapeHtml(email);
  const subject = `Welcome to Aspire by Adyapan — Registration Confirmed`;
  const preheader = `Your candidate registration with ${organizationName} is confirmed.`;

  const contentHtml = `
    <div style="margin-bottom: 24px;">
      <span style="display: inline-block; background-color: rgba(255, 201, 0, 0.1); border: 1px solid rgba(255, 201, 0, 0.25); color: #FFC900; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; padding: 4px 10px; border-radius: 4px;">
        Account Confirmed
      </span>
    </div>

    <h1 style="font-family: 'Playfair Display', Georgia, serif; font-size: 26px; font-weight: 700; color: #F5F3EF; margin: 0 0 16px 0; line-height: 1.3;">
      Welcome, ${safeName}
    </h1>

    <p style="font-size: 15px; line-height: 1.6; color: #D4D4D8; margin: 0 0 20px 0;">
      Your registration with <strong>${escapeHtml(organizationName)}</strong> has been successfully received and confirmed. You are now enrolled in our technical talent and scholarship evaluation ecosystem.
    </p>

    <div style="background-color: #1A1D24; border: 1px solid #272B35; border-radius: 8px; padding: 18px 20px; margin-bottom: 28px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="color: #A1A1AA; font-size: 13px; padding-bottom: 8px;">Registered Email:</td>
          <td style="color: #F5F3EF; font-size: 13px; font-weight: 600; text-align: right; padding-bottom: 8px;">${safeEmail}</td>
        </tr>
        ${safeCollege ? `
        <tr>
          <td style="color: #A1A1AA; font-size: 13px; padding-bottom: 8px;">Institution:</td>
          <td style="color: #F5F3EF; font-size: 13px; font-weight: 600; text-align: right; padding-bottom: 8px;">${safeCollege}</td>
        </tr>` : ''}
        <tr>
          <td style="color: #A1A1AA; font-size: 13px;">Status:</td>
          <td style="color: #10B981; font-size: 13px; font-weight: 600; text-align: right;">Verified &amp; Active</td>
        </tr>
      </table>
    </div>

    <h3 style="font-size: 15px; font-weight: 600; color: #F5F3EF; margin: 0 0 10px 0;">
      Next Steps
    </h3>
    <ul style="font-size: 14px; line-height: 1.6; color: #A1A1AA; margin: 0 0 28px 0; padding-left: 20px;">
      <li>Log in to your candidate dashboard to view scheduled assessments.</li>
      <li>Ensure you have a supported modern web browser (Chrome, Edge, or Firefox).</li>
      <li>Review our test environment guidelines before beginning any timed evaluation.</li>
    </ul>

    <div style="text-align: center; margin: 32px 0 16px 0;">
      <a href="${escapeHtml(dashboardUrl)}" class="cta-btn" style="display: inline-block; background-color: #FFC900; color: #08090B !important; font-family: 'Poppins', sans-serif; font-size: 14px; font-weight: 600; text-decoration: none; padding: 14px 28px; border-radius: 8px; letter-spacing: 0.5px;">
        Go to Candidate Dashboard &rarr;
      </a>
    </div>
  `;

  const contentText = `
Welcome, ${recipientName}!

Your registration with ${organizationName} has been successfully received and confirmed.
Registered Email: ${email}
${college ? `Institution: ${college}\n` : ''}Status: Verified & Active

Next Steps:
- Log in to your candidate dashboard to view scheduled assessments.
- Ensure you have a supported modern web browser (Chrome, Edge, Firefox).
- Review test environment guidelines before beginning any timed evaluation.

Access your dashboard here: ${dashboardUrl}
  `.trim();

  const layout = renderEmailLayout({
    title: subject,
    preheader,
    contentHtml,
    contentText,
    organizationName,
    organizationLogoUrl,
    dashboardUrl
  });

  return {
    subject,
    html: layout.html,
    text: layout.text
  };
}

module.exports = { renderRegistrationConfirmation };
