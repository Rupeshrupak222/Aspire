// ============================================================================
// TEMPLATE 2: EXAM INVITATION
// ============================================================================

const { escapeHtml, renderEmailLayout } = require('./email-layout');

function renderExamInvitation(options = {}) {
  const recipientName = options.recipientName || options.name || 'Candidate';
  const examTitle = options.examTitle || 'Scholarship Assessment';
  const examDate = options.examDate || null;
  const durationMinutes = options.durationMinutes !== undefined ? options.durationMinutes : 90;
  const instructions = options.instructions || null;
  const invitationUrl = options.invitationUrl || 'https://aspire.adyapan.internal';
  const organizationName = options.organizationName || 'Aspire by Adyapan';
  const organizationLogoUrl = options.organizationLogoUrl || null;
  const safeName = escapeHtml(recipientName);
  const safeExamTitle = escapeHtml(examTitle);
  const safeDate = examDate ? escapeHtml(examDate) : 'Open Access / Self-Paced Window';
  const safeDuration = `${parseInt(durationMinutes, 10) || 90} Minutes`;
  const subject = `You're Invited: ${examTitle} | Aspire by Adyapan`;
  const preheader = `You have been officially invited to undertake the ${examTitle}.`;

  const contentHtml = `
    <div style="margin-bottom: 24px;">
      <span style="display: inline-block; background-color: rgba(255, 201, 0, 0.1); border: 1px solid rgba(255, 201, 0, 0.25); color: #FFC900; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; padding: 4px 10px; border-radius: 4px;">
        Assessment Invitation
      </span>
    </div>

    <h1 style="font-family: 'Playfair Display', Georgia, serif; font-size: 26px; font-weight: 700; color: #F5F3EF; margin: 0 0 16px 0; line-height: 1.3;">
      You're Invited, ${safeName}
    </h1>

    <p style="font-size: 15px; line-height: 1.6; color: #D4D4D8; margin: 0 0 20px 0;">
      You have been officially selected and invited by <strong>${escapeHtml(organizationName)}</strong> to take part in the <strong>${safeExamTitle}</strong>.
    </p>

    <div style="background-color: #1A1D24; border: 1px solid #272B35; border-radius: 8px; padding: 18px 20px; margin-bottom: 28px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="color: #A1A1AA; font-size: 13px; padding-bottom: 8px;">Assessment:</td>
          <td style="color: #F5F3EF; font-size: 13px; font-weight: 600; text-align: right; padding-bottom: 8px;">${safeExamTitle}</td>
        </tr>
        <tr>
          <td style="color: #A1A1AA; font-size: 13px; padding-bottom: 8px;">Scheduled Date:</td>
          <td style="color: #F5F3EF; font-size: 13px; font-weight: 600; text-align: right; padding-bottom: 8px;">${safeDate}</td>
        </tr>
        <tr>
          <td style="color: #A1A1AA; font-size: 13px;">Allowed Duration:</td>
          <td style="color: #FFC900; font-size: 13px; font-weight: 600; text-align: right;">${safeDuration}</td>
        </tr>
      </table>
    </div>

    ${instructions ? `
    <div style="margin-bottom: 24px;">
      <h3 style="font-size: 14px; font-weight: 600; color: #F5F3EF; margin: 0 0 8px 0;">Special Instructions:</h3>
      <p style="font-size: 13px; color: #A1A1AA; line-height: 1.5; margin: 0;">${escapeHtml(instructions)}</p>
    </div>` : ''}

    <h3 style="font-size: 15px; font-weight: 600; color: #F5F3EF; margin: 0 0 10px 0;">
      Important Assessment Guidelines
    </h3>
    <ul style="font-size: 14px; line-height: 1.6; color: #A1A1AA; margin: 0 0 28px 0; padding-left: 20px;">
      <li>Ensure stable broadband internet connection before starting.</li>
      <li>Once started, the authoritative timer runs continuously without pause.</li>
      <li>Fullscreen proctoring monitors tab-switches and window blurring.</li>
    </ul>

    <div style="text-align: center; margin: 32px 0 16px 0;">
      <a href="${escapeHtml(invitationUrl)}" class="cta-btn" style="display: inline-block; background-color: #FFC900; color: #08090B !important; font-family: 'Poppins', sans-serif; font-size: 14px; font-weight: 600; text-decoration: none; padding: 14px 28px; border-radius: 8px; letter-spacing: 0.5px;">
        Start Assessment &rarr;
      </a>
    </div>
  `;

  const contentText = `
You're Invited, ${recipientName}!

You have been officially invited by ${organizationName} to participate in:
Assessment: ${examTitle}
Scheduled Date: ${examDate || 'Open Access Window'}
Duration: ${durationMinutes} Minutes

${instructions ? `Special Instructions: ${instructions}\n\n` : ''}Important Guidelines:
- Ensure a stable broadband connection.
- The timer runs continuously once started.
- Proctoring monitors tab-switches and window blur events.

Begin your assessment: ${invitationUrl}
  `.trim();

  const layout = renderEmailLayout({
    title: subject,
    preheader,
    contentHtml,
    contentText,
    organizationName,
    organizationLogoUrl,
    dashboardUrl: invitationUrl
  });

  return {
    subject,
    html: layout.html,
    text: layout.text
  };
}

module.exports = { renderExamInvitation };
