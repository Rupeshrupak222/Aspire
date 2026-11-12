# ASPIRE BY ADYAPAN
# NOTIFICATION EVENT CATALOG
## Comprehensive Specification of Transactional Communication Events

**Date:** 2026-11-12  
**Version:** 1.0.0  
**Milestone:** Day 23 — Event-Driven Notification & Email Delivery System  

---

## 1. Catalog Overview

The Aspire by Adyapan communication pipeline defines **six distinct transactional event types**. Each event maps directly to an authoritative lifecycle transition, enforces a deterministic idempotency key, defines a strict JSON payload schema, and renders an editorial, luxury-branded email template.

```
+-------------------------------------------------------------------------------------------------------+
|                                    TRANSACTIONAL EVENT SUMMARY                                        |
+--------------------------+------------------------------+--------------------+------------------------+
| Event Type               | Trigger                      | Recipient          | Mutability Policy      |
+--------------------------+------------------------------+--------------------+------------------------+
| REGISTRATION_CONFIRMED   | Candidate signs up           | Student Candidate  | MANDATORY (Immutable)  |
| EXAM_INVITATION          | Admin issues exam invite     | Student Candidate  | Respects Preferences   |
| EXAM_REMINDER            | 24h / 1h countdown schedule  | Student Candidate  | Respects Preferences   |
| EXAM_COMPLETED           | Assessment submitted         | Student Candidate  | Respects Preferences   |
| RESULT_AVAILABLE         | Grading finalized & released | Student Candidate  | Respects Preferences   |
| CERTIFICATE_AVAILABLE    | Credential issued            | Student Candidate  | Respects Preferences   |
+--------------------------+------------------------------+--------------------+------------------------+
```

---

## 2. Event Specification: `REGISTRATION_CONFIRMED`

### 2.1 Description & Trigger
Fires immediately upon the successful registration of a candidate in `routes/public.js` (`POST /api/register`). Confirms candidate identity, records college affiliation, and delivers their permanent candidate portal access link.

### 2.2 Operational Metadata
- **Template Key:** `REGISTRATION_CONFIRMED`
- **Recipient:** Candidate (`students.email`)
- **Preference Invariance:** **MANDATORY**. Cannot be muted by candidate or tenant preferences.
- **Idempotency Key:** `registration_confirmed_{studentId}`

### 2.3 Payload Schema
```json
{
  "studentId": 1042,
  "name": "Jane Doe",
  "college": "Indian Institute of Technology",
  "dashboardUrl": "https://aspire.yourdomain.com/dashboard.html"
}
```

### 2.4 Subject & Content Preview
- **Subject:** `Welcome to Aspire — Registration Confirmed`
- **Headline:** `Welcome to Aspire.`
- **Body Excerpt:**
  > Dear Jane Doe,
  >
  > Your candidate profile for **Indian Institute of Technology** has been successfully registered. You may now access your dashboard to view eligible scholarship assessments, track your progress, and prepare for upcoming evaluations.
- **CTA Button:** `Go to Your Dashboard` (`#FFC900` Gold Pill)

---

## 3. Event Specification: `EXAM_INVITATION`

### 3.1 Description & Trigger
Fires when an Organization Administrator or Exam Manager invites a candidate to a private or scheduled assessment via `POST /api/organization/exams/:id/invite`.

### 3.2 Operational Metadata
- **Template Key:** `EXAM_INVITATION`
- **Recipient:** Candidate (`email`)
- **Preference Invariance:** Respects `exam_invitations` preference toggle.
- **Idempotency Key:** `exam_invitation_{examId}_{studentId_or_email}`

### 3.3 Payload Schema
```json
{
  "examId": 88,
  "studentId": 1042,
  "name": "Jane Doe",
  "examTitle": "Senior Full-Stack Scholarship Assessment",
  "examDate": "2026-11-20T10:00:00Z",
  "durationMinutes": 90,
  "instructions": "Standard algorithmic and systems assessment. Webcams and screen monitoring required.",
  "invitationUrl": "https://aspire.yourdomain.com/test.html?invitation=inv_9a8b7c6d5e"
}
```

### 3.4 Subject & Content Preview
- **Subject:** `Invitation: Senior Full-Stack Scholarship Assessment — Aspire`
- **Headline:** `You Have Been Invited.`
- **Body Excerpt:**
  > Dear Jane Doe,
  >
  > You have been invited to participate in the **Senior Full-Stack Scholarship Assessment**.
  >
  > **Assessment Details:**
  > - Duration: 90 minutes
  > - Date: Friday, November 20, 2026
  > - Format: Proctored Technical Evaluation
- **CTA Button:** `Enter Assessment Stage`

---

## 4. Event Specification: `EXAM_REMINDER`

### 4.1 Description & Trigger
Fires via scheduled background tasks at designated intervals prior to an assessment's scheduled start time (typically at $T-24\text{ hours}$ and $T-1\text{ hour}$).

### 4.2 Operational Metadata
- **Template Key:** `EXAM_REMINDER`
- **Recipient:** Registered Candidate
- **Preference Invariance:** Respects `exam_reminders` preference toggle.
- **Idempotency Key:** `exam_reminder_{examId}_{studentId_or_email}_{reminderType}` (`reminderType`: `24h` or `1h`)

### 4.3 Payload Schema
```json
{
  "examId": 88,
  "studentId": 1042,
  "name": "Jane Doe",
  "examTitle": "Senior Full-Stack Scholarship Assessment",
  "startTime": "2026-11-20T10:00:00Z",
  "durationMinutes": 90,
  "timeRemainingText": "in 24 hours",
  "dashboardUrl": "https://aspire.yourdomain.com/dashboard.html"
}
```

### 4.4 Subject & Content Preview
- **Subject:** `Reminder: Senior Full-Stack Scholarship Assessment begins in 24 hours`
- **Headline:** `Your Assessment Starts Soon.`
- **Body Excerpt:**
  > Dear Jane Doe,
  >
  > This is a friendly reminder that your upcoming evaluation, **Senior Full-Stack Scholarship Assessment**, will commence **in 24 hours**.
  >
  > Please ensure your testing environment meets our technical and proctoring requirements ahead of time.
- **CTA Button:** `Review Exam Instructions`

---

## 5. Event Specification: `EXAM_COMPLETED`

### 5.1 Description & Trigger
Fires immediately upon the candidate submitting their exam or when the timer expires in `timer-submission.service.js` (`submitAttempt()`). Serves as an authoritative delivery receipt.

### 5.2 Operational Metadata
- **Template Key:** `EXAM_COMPLETED`
- **Recipient:** Candidate
- **Preference Invariance:** Respects `registration_updates` / operational receipt preferences.
- **Idempotency Key:** `exam_completed_{attemptId}`

### 5.3 Payload Schema
```json
{
  "attemptId": 501,
  "studentId": 1042,
  "name": "Jane Doe",
  "examTitle": "Senior Full-Stack Scholarship Assessment",
  "submittedAt": "Thu, 12 Nov 2026 10:45:00 GMT",
  "dashboardUrl": "https://aspire.yourdomain.com/dashboard.html"
}
```

### 5.4 Subject & Content Preview
- **Subject:** `Assessment Received: Senior Full-Stack Scholarship Assessment`
- **Headline:** `Assessment Submitted.`
- **Body Excerpt:**
  > Dear Jane Doe,
  >
  > We have received your submission for **Senior Full-Stack Scholarship Assessment** on Thursday, November 12, 2026.
  >
  > Your responses and code submissions are now being processed by our automated evaluation pipeline. You will receive an email as soon as your results and scholarship allocation are finalized.
- **CTA Button:** `View Candidate Dashboard`

---

## 6. Event Specification: `RESULT_AVAILABLE`

### 6.1 Description & Trigger
Fires when automated grading and scholarship allocations are finalized and published in `timer-submission.service.js`.

### 6.2 Operational Metadata
- **Template Key:** `RESULT_AVAILABLE`
- **Recipient:** Candidate
- **Preference Invariance:** Respects `result_updates` preference toggle.
- **Idempotency Key:** `result_available_{attemptId}`

### 6.3 Payload Schema
```json
{
  "attemptId": 501,
  "studentId": 1042,
  "name": "Jane Doe",
  "examTitle": "Senior Full-Stack Scholarship Assessment",
  "score": 92,
  "totalMarks": 100,
  "percentage": 92.0,
  "scholarshipPercentage": 100,
  "scholarshipTier": "Top Tier (100% Scholarship)",
  "resultUrl": "https://aspire.yourdomain.com/results.html?attemptId=501"
}
```

### 6.4 Subject & Content Preview
- **Subject:** `Your Results Are Ready: Senior Full-Stack Scholarship Assessment`
- **Headline:** `Results Published.`
- **Body Excerpt:**
  > Dear Jane Doe,
  >
  > The evaluation for **Senior Full-Stack Scholarship Assessment** is complete.
  >
  > **Your Score:** 92 / 100 (92.0%)  
  > **Award Status:** Top Tier (100% Scholarship)
  >
  > Congratulations on your exceptional performance. View your detailed breakdown, question analyses, and scholarship offer below.
- **CTA Button:** `View Detailed Results`

---

## 7. Event Specification: `CERTIFICATE_AVAILABLE`

### 7.1 Description & Trigger
Fires when an official completion or scholarship certificate is minted and cryptographically hashed for verification.

### 7.2 Operational Metadata
- **Template Key:** `CERTIFICATE_AVAILABLE`
- **Recipient:** Candidate
- **Preference Invariance:** Respects `certificate_updates` preference toggle.
- **Idempotency Key:** `certificate_available_{certificateId}`

### 7.3 Payload Schema
```json
{
  "certificateId": "CERT-2026-88-1042",
  "attemptId": 501,
  "studentId": 1042,
  "name": "Jane Doe",
  "examTitle": "Senior Full-Stack Scholarship Assessment",
  "scholarshipPercentage": 100,
  "certificateUrl": "https://aspire.yourdomain.com/certificate.html?id=CERT-2026-88-1042",
  "verificationUrl": "https://aspire.yourdomain.com/api/public/verify/CERT-2026-88-1042"
}
```

### 7.4 Subject & Content Preview
- **Subject:** `Certificate Issued: Senior Full-Stack Scholarship Assessment — Aspire`
- **Headline:** `Achievement Unlocked.`
- **Body Excerpt:**
  > Dear Jane Doe,
  >
  > We are delighted to award your official Certificate of Scholarship Achievement for **Senior Full-Stack Scholarship Assessment** with a 100% scholarship merit.
  >
  > **Certificate ID:** `CERT-2026-88-1042`
  >
  > This credential is cryptographically verifiable and permanent. You can view, download, or share it on your professional profiles.
- **CTA Button:** `View Your Certificate`

---

## 8. Code Usage Reference

All notification triggers utilize the centralized methods in `notification.service.js`:

```javascript
const {
  sendRegistrationConfirmation,
  sendExamInvitation,
  scheduleExamReminder,
  sendExamCompleted,
  sendResultAvailable,
  sendCertificateAvailable
} = require('./services/notifications/notification.service');

// Example: Triggering a certificate notification
sendCertificateAvailable({
  organizationId: 1,
  certificateId: 'CERT-2026-88-1042',
  attemptId: 501,
  studentId: 1042,
  email: 'jane.doe@example.com',
  name: 'Jane Doe',
  examTitle: 'Senior Full-Stack Assessment',
  scholarshipPercentage: 100
});
```

