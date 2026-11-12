// ============================================================================
// TEMPLATE 3: EXAM REMINDER
// ============================================================================

const { escapeHtml, renderEmailLayout } = require('./email-layout');

function renderExamReminder({
  recipientName = 'Candidate',
  examTitle = 'Scholarship Assessment',
  startTime = null,
  durationMinutes = 90,
  timeRemainingText = 'soon',
  dashboardUrl = 'https://aspire.adyapan.internal',
  organizationName = 'Aspire by Adyapan',
  organizationLogoUrl = null
}) {
  const safeName = escapeHtml(recipientName);
  const safeExamTitle = escapeHtml(examTitle);
  const safeStart = startTime ? escapeHtml(startTime) : 'Upcoming Session';
  const safeDuration = `${parseInt(durationMinutes, 10) || 90} Minutes`;
  const subject = `Reminder: Your Aspire Assessment Is Approaching`;
  const preheader = `Your assessment "${examTitle}" starts ${timeRemainingText}. Prepare your testing workstation.`;

  const contentHtml = `
    <div style="margin-bottom: 24px;">
      <span style="display: inline-block; background-color: rgba(212, 175, 55, 0.1); border: 1px solid rgba(212, 175, 55, 0.3); color: #D4AF37; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; padding: 4px 10px; border-radius: 4px;">
        Assessment Reminder (${escapeHtml(timeRemainingText)})
      </span>
    </div>

    <h1 style="font-family: 'Playfair Display', Georgia, serif; font-size: 26px; font-weight: 700; color: #F5F3EF; margin: 0 0 16px 0; line-height: 1.3;">
      Upcoming Evaluation, ${safeName}
    </h1>

    <p style="font-size: 15px; line-height: 1.6; color: #D4D4D8; margin: 0 0 20px 0;">
      This is a quick notification to remind you that your evaluation session for <strong>${safeExamTitle}</strong> is scheduled to commence <strong>${escapeHtml(timeRemainingText)}</strong>.
    </p>

    <div style="background-color: #1A1D24; border: 1px solid #272B35; border-radius: 8px; padding: 18px 20px; margin-bottom: 28px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="color: #A1A1AA; font-size: 13px; padding-bottom: 8px;">Exam:</td>
          <td style="color: #F5F3EF; font-size: 13px; font-weight: 600; text-align: right; padding-bottom: 8px;">${safeExamTitle}</td>
        </tr>
        <tr>
          <td style="color: #A1A1AA; font-size: 13px; padding-bottom: 8px;">Start Time:</td>
          <td style="color: #F5F3EF; font-size: 13px; font-weight: 600; text-align: right; padding-bottom: 8px;">${safeStart}</td>
        </tr>
        <tr>
          <td style="color: #A1A1AA; font-size: 13px;">Duration:</td>
          <td style="color: #FFC900; font-size: 13px; font-weight: 600; text-align: right;">${safeDuration}</td>
        </tr>
      </table>
    </div>

    <h3 style="font-size: 15px; font-weight: 600; color: #F5F3EF; margin: 0 0 10px 0;">
      Pre-Flight Checklist
    </h3>
    <ul style="font-size: 14px; line-height: 1.6; color: #A1A1AA; margin: 0 0 28px 0; padding-left: 20px;">
      <li>Ensure your device is connected to a reliable power supply.</li>
      <li>Close unnecessary background applications, browser tabs, and VPNs.</li>
      <li>Have a valid photo ID ready if identity verification is requested.</li>
    </ul>

    <div style="text-align: center; margin: 32px 0 16px 0;">
      <a href="${escapeHtml(dashboardUrl)}" class="cta-btn" style="display: inline-block; background-color: #FFC900; color: #08090B !important; font-family: 'Poppins', sans-serif; font-size: 14px; font-weight: 600; text-decoration: none; padding: 14px 28px; border-radius: 8px; letter-spacing: 0.5px;">
        Open Candidate Portal &rarr;
      </a>
    </div>
  `;

  const contentText = `
Reminder: Assessment Approaching (${timeRemainingText})

Hello ${recipientName},

Your evaluation session for "${examTitle}" begins ${timeRemainingText}.
Start Time: ${startTime || 'Scheduled Time'}
Duration: ${durationMinutes} Minutes

Pre-Flight Checklist:
- Ensure your device is plugged into power.
- Close unnecessary tabs, applications, and VPNs.
- Prepare your testing environment.

Access portal: ${dashboardUrl}
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

module.exports = { renderExamReminder };

