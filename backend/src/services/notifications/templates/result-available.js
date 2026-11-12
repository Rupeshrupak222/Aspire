// ============================================================================
// TEMPLATE 5: RESULT AVAILABLE
// ============================================================================

const { escapeHtml, renderEmailLayout } = require('./email-layout');

function renderResultAvailable({
  recipientName = 'Candidate',
  examTitle = 'Scholarship Assessment',
  score = null,
  totalMarks = null,
  percentage = null,
  scholarshipPercentage = 0,
  scholarshipTier = null,
  resultUrl = 'https://aspire.adyapan.internal',
  organizationName = 'Aspire by Adyapan',
  organizationLogoUrl = null
}) {
  const safeName = escapeHtml(recipientName);
  const safeExamTitle = escapeHtml(examTitle);
  const safePct = percentage !== null ? `${Number(percentage).toFixed(1)}%` : 'Published';
  const hasScholarship = scholarshipPercentage > 0;
  const safeTier = scholarshipTier ? escapeHtml(scholarshipTier) : (hasScholarship ? `${scholarshipPercentage}% Scholarship Award` : 'Evaluation Completed');
  const subject = `Your Aspire Assessment Results Are Ready`;
  const preheader = `Official results for ${examTitle} have been published. Check your score and scholarship eligibility.`;

  const contentHtml = `
    <div style="margin-bottom: 24px;">
      <span style="display: inline-block; background-color: rgba(255, 201, 0, 0.1); border: 1px solid rgba(255, 201, 0, 0.25); color: #FFC900; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; padding: 4px 10px; border-radius: 4px;">
        Official Results Published
      </span>
    </div>

    <h1 style="font-family: 'Playfair Display', Georgia, serif; font-size: 26px; font-weight: 700; color: #F5F3EF; margin: 0 0 16px 0; line-height: 1.3;">
      Results Released, ${safeName}
    </h1>

    <p style="font-size: 15px; line-height: 1.6; color: #D4D4D8; margin: 0 0 20px 0;">
      Your evaluation results for <strong>${safeExamTitle}</strong> have been finalized and officially published by <strong>${escapeHtml(organizationName)}</strong>.
    </p>

    <!-- Score Card -->
    <div style="background-color: #1A1D24; border: 1px solid #272B35; border-radius: 10px; padding: 24px; margin-bottom: 28px; text-align: center;">
      <div style="font-size: 12px; font-weight: 600; color: #A1A1AA; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">
        Assessment Score
      </div>
      <div style="font-family: 'Playfair Display', Georgia, serif; font-size: 40px; font-weight: 700; color: #FFC900; line-height: 1.1; margin-bottom: 8px;">
        ${safePct}
      </div>
      <div style="font-size: 14px; font-weight: 600; color: ${hasScholarship ? '#10B981' : '#F5F3EF'};">
        ${safeTier}
      </div>
      ${score !== null && totalMarks !== null ? `
      <div style="font-size: 12px; color: #71717A; margin-top: 8px;">
        Raw Score: ${score} / ${totalMarks} Marks
      </div>` : ''}
    </div>

    <p style="font-size: 14px; line-height: 1.6; color: #A1A1AA; margin: 0 0 28px 0;">
      Log in to your candidate dashboard to access a complete breakdown of section-by-section metrics, difficulty tier insights, and merit standing.
    </p>

    <div style="text-align: center; margin: 32px 0 16px 0;">
      <a href="${escapeHtml(resultUrl)}" class="cta-btn" style="display: inline-block; background-color: #FFC900; color: #08090B !important; font-family: 'Poppins', sans-serif; font-size: 14px; font-weight: 600; text-decoration: none; padding: 14px 28px; border-radius: 8px; letter-spacing: 0.5px;">
        View Full Performance Breakdown &rarr;
      </a>
    </div>
  `;

  const contentText = `
Your Assessment Results Are Ready!

Hello ${recipientName},

Official results for "${examTitle}" are now published.
Percentage Score: ${safePct}
Status / Award: ${safeTier}
${score !== null && totalMarks !== null ? `Marks: ${score} / ${totalMarks}\n` : ''}
Access full score details and analytics here: ${resultUrl}
  `.trim();

  const layout = renderEmailLayout({
    title: subject,
    preheader,
    contentHtml,
    contentText,
    organizationName,
    organizationLogoUrl,
    dashboardUrl: resultUrl
  });

  return {
    subject,
    html: layout.html,
    text: layout.text
  };
}

module.exports = { renderResultAvailable };

