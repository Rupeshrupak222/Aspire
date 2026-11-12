// ============================================================================
// TEMPLATE 4: EXAM COMPLETED
// ============================================================================

const { escapeHtml, renderEmailLayout } = require('./email-layout');

function renderExamCompleted({
  recipientName = 'Candidate',
  examTitle = 'Scholarship Assessment',
  submittedAt = null,
  dashboardUrl = 'https://aspire.adyapan.internal',
  organizationName = 'Aspire by Adyapan',
  organizationLogoUrl = null
}) {
  const safeName = escapeHtml(recipientName);
  const safeExamTitle = escapeHtml(examTitle);
  const safeTime = submittedAt ? escapeHtml(submittedAt) : new Date().toUTCString();
  const subject = `Assessment Completed — Aspire by Adyapan`;
  const preheader = `Your submission for ${examTitle} has been received.`;

  const contentHtml = `
    <div style="margin-bottom: 24px;">
      <span style="display: inline-block; background-color: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.25); color: #10B981; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; padding: 4px 10px; border-radius: 4px;">
        Assessment Finalized
      </span>
    </div>

    <h1 style="font-family: 'Playfair Display', Georgia, serif; font-size: 26px; font-weight: 700; color: #F5F3EF; margin: 0 0 16px 0; line-height: 1.3;">
      Well Done, ${safeName}
    </h1>

    <p style="font-size: 15px; line-height: 1.6; color: #D4D4D8; margin: 0 0 20px 0;">
      Your responses for <strong>${safeExamTitle}</strong> have been securely received and recorded. Your assessment session is now officially sealed.
    </p>

    <div style="background-color: #1A1D24; border: 1px solid #272B35; border-radius: 8px; padding: 18px 20px; margin-bottom: 28px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="color: #A1A1AA; font-size: 13px; padding-bottom: 8px;">Exam:</td>
          <td style="color: #F5F3EF; font-size: 13px; font-weight: 600; text-align: right; padding-bottom: 8px;">${safeExamTitle}</td>
        </tr>
        <tr>
          <td style="color: #A1A1AA; font-size: 13px; padding-bottom: 8px;">Submitted At:</td>
          <td style="color: #F5F3EF; font-size: 13px; font-weight: 600; text-align: right; padding-bottom: 8px;">${safeTime}</td>
        </tr>
        <tr>
          <td style="color: #A1A1AA; font-size: 13px;">Evaluation Status:</td>
          <td style="color: #10B981; font-size: 13px; font-weight: 600; text-align: right;">Under Review &amp; Grading</td>
        </tr>
      </table>
    </div>

    <h3 style="font-size: 15px; font-weight: 600; color: #F5F3EF; margin: 0 0 10px 0;">
      What Happens Next?
    </h3>
    <p style="font-size: 14px; line-height: 1.6; color: #A1A1AA; margin: 0 0 28px 0;">
      Our automated grading engine is compiling your technical performance and proctoring telemetry. Official results and scholarship allocation determinations will be announced and made available via your candidate portal once verification is complete.
    </p>

    <div style="text-align: center; margin: 32px 0 16px 0;">
      <a href="${escapeHtml(dashboardUrl)}" class="cta-btn" style="display: inline-block; background-color: #FFC900; color: #08090B !important; font-family: 'Poppins', sans-serif; font-size: 14px; font-weight: 600; text-decoration: none; padding: 14px 28px; border-radius: 8px; letter-spacing: 0.5px;">
        View Assessment Status &rarr;
      </a>
    </div>
  `;

  const contentText = `
Assessment Completed — Aspire by Adyapan

Congratulations, ${recipientName}!

Your assessment "${examTitle}" was successfully submitted and sealed.
Submission Timestamp: ${submittedAt || 'Recorded'}
Evaluation Status: Under Review & Grading

What Happens Next:
Our evaluation engine is reviewing your scores and proctoring telemetry.
Official results and scholarship eligibility will be announced via your candidate portal.

Track status: ${dashboardUrl}
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

module.exports = { renderExamCompleted };

