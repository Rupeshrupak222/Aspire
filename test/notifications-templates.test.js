// ============================================================================
// ASPIRE DAY 23: NOTIFICATIONS TEMPLATES & LUXURY STYLING TEST SUITE
// ============================================================================

const { renderTemplate, getRegisteredTemplates } = require('../backend/src/services/notifications/templates/template-renderer.service');

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

function run() {
  console.log('====================================================');
  console.log('DAY 23: NOTIFICATIONS TEMPLATES & LUXURY STYLING');
  console.log('====================================================\n');

  try {
    console.log('--- 1. Template Registry Completeness ---');
    const registered = getRegisteredTemplates();
    ok('Exactly 6 templates registered in engine', registered.length === 6);
    ok('Registration confirmation template present', registered.includes('REGISTRATION_CONFIRMED'));
    ok('Exam invitation template present', registered.includes('EXAM_INVITATION'));
    ok('Exam reminder template present', registered.includes('EXAM_REMINDER'));
    ok('Exam completed template present', registered.includes('EXAM_COMPLETED'));
    ok('Result available template present', registered.includes('RESULT_AVAILABLE'));
    ok('Certificate available template present', registered.includes('CERTIFICATE_AVAILABLE'));

    console.log('\n--- 2. Template 1: Registration Confirmation ---');
    const t1 = renderTemplate('REGISTRATION_CONFIRMED', {
      name: 'Aditi Sharma',
      college: 'National Institute of Technology',
      dashboardUrl: 'https://aspire.internal/dashboard.html'
    });
    ok('T1 subject generated', Boolean(t1.subject));
    ok('T1 subject mentions registration or account', t1.subject.includes('Registration') || t1.subject.includes('Welcome') || t1.subject.includes('Confirmed'));
    ok('T1 HTML includes candidate name', t1.html.includes('Aditi Sharma'));
    ok('T1 HTML includes college', t1.html.includes('National Institute of Technology'));
    ok('T1 text fallback generated', Boolean(t1.text) && t1.text.includes('Aditi Sharma'));

    console.log('\n--- 3. Template 2: Exam Invitation ---');
    const t2 = renderTemplate('EXAM_INVITATION', {
      name: 'Rohan Verma',
      examTitle: 'Full-Stack Developer Scholarship',
      invitationUrl: 'https://aspire.internal/test.html?invitation=secret_token_123',
      durationMinutes: 90
    });
    ok('T2 subject mentions invitation or invited', t2.subject.includes('Invited') || t2.subject.includes('Invitation'));
    ok('T2 HTML includes exam title', t2.html.includes('Full-Stack Developer Scholarship'));
    ok('T2 HTML includes duration', t2.html.includes('90 minutes') || t2.html.includes('90'));
    ok('T2 HTML contains CTA button with link', t2.html.includes('secret_token_123'));
    ok('T2 text fallback contains link', t2.text.includes('secret_token_123'));

    console.log('\n--- 4. Template 3: Exam Reminder ---');
    const t3 = renderTemplate('EXAM_REMINDER', {
      name: 'Priya Patel',
      examTitle: 'Data Engineering Evaluation',
      timeRemainingText: 'in 24 hours',
      dashboardUrl: 'https://aspire.internal/dashboard.html'
    });
    ok('T3 subject mentions reminder', t3.subject.includes('Reminder'));
    ok('T3 HTML includes time remaining text', t3.html.includes('in 24 hours'));
    ok('T3 text fallback present', Boolean(t3.text) && t3.text.includes('in 24 hours'));

    console.log('\n--- 5. Template 4: Exam Completed ---');
    const t4 = renderTemplate('EXAM_COMPLETED', {
      name: 'Ananya Roy',
      examTitle: 'Core Java Technical Assessment',
      submittedAt: 'Wed, 12 Nov 2026 10:00:00 GMT'
    });
    ok('T4 subject acknowledges completion', t4.subject.includes('Completed') || t4.subject.includes('Received') || t4.subject.includes('Submission'));
    ok('T4 HTML mentions evaluation/grading in progress', t4.html.includes('evaluat') || t4.html.includes('recorded') || t4.html.includes('submitted'));
    ok('T4 text fallback present', Boolean(t4.text));

    console.log('\n--- 6. Template 5: Result Available ---');
    const t5 = renderTemplate('RESULT_AVAILABLE', {
      name: 'Vikram Joshi',
      examTitle: 'Advanced Cloud Architect Assessment',
      score: 92,
      totalMarks: 100,
      percentage: 92.0,
      scholarshipPercentage: 100,
      scholarshipTier: 'Premier Merit Tier',
      resultUrl: 'https://aspire.internal/results.html?id=999'
    });
    ok('T5 subject mentions result', t5.subject.includes('Result') || t5.subject.includes('Score'));
    ok('T5 HTML displays score', t5.html.includes('92'));
    ok('T5 HTML displays scholarship percentage', t5.html.includes('100%'));
    ok('T5 HTML contains result URL', t5.html.includes('results.html?id=999'));

    console.log('\n--- 7. Template 6: Certificate Available ---');
    const t6 = renderTemplate('CERTIFICATE_AVAILABLE', {
      name: 'Zara Chen',
      examTitle: 'AI & Machine Learning Assessment',
      certificateId: 'CERT-ASP-2026-9900',
      certificateUrl: 'https://aspire.internal/certificate.html?id=CERT-ASP-2026-9900',
      verificationUrl: 'https://aspire.internal/api/public/verify/CERT-ASP-2026-9900',
      scholarshipPercentage: 75
    });
    ok('T6 subject celebrates certificate achievement', t6.subject.includes('Certificate') || t6.subject.includes('Achievement'));
    ok('T6 HTML includes certificate ID', t6.html.includes('CERT-ASP-2026-9900'));
    ok('T6 HTML includes verification link', t6.html.includes('verify'));
    ok('T6 text fallback includes certificate URL', t6.text.includes('certificate.html'));

    console.log('\n--- 8. Aspire Luxury Brand Palette Verification ---');
    // Check master email layout styling
    ok('HTML contains Midnight Black #08090B or Dark Canvas styling', t1.html.includes('#08090B') || t1.html.includes('#111317'));
    ok('HTML contains Golden Yellow #FFC900 accent', t1.html.includes('#FFC900') || t1.html.includes('#E5A800'));
    ok('HTML contains Playfair Display or Poppins font references', t1.html.includes('Playfair Display') || t1.html.includes('Poppins'));

    console.log('\n--- 9. Security & HTML Injection / XSS Escaping ---');
    const maliciousPayload = {
      name: '<script>alert("xss")</script> & Bob',
      examTitle: '<b>Hacked Exam</b>',
      dashboardUrl: 'https://aspire.internal'
    };
    const escaped = renderTemplate('REGISTRATION_CONFIRMED', maliciousPayload);
    ok('Raw <script> tag is NOT present in rendered HTML', !escaped.html.includes('<script>'));
    ok('& is escaped as &amp;', escaped.html.includes('&amp;'));
    ok('<script> is escaped as &lt;script&gt;', escaped.html.includes('&lt;script&gt;'));

  } catch (err) {
    failures++;
    console.error('Unexpected test error:', err);
  } finally {
    process.exit(failures > 0 ? 1 : 0);
  }
}

run();
