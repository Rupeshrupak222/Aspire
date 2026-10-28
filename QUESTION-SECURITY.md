# ASPIRE — QUESTION SECURITY & DETERMINISTIC SHUFFLING SPECIFICATION

## 1. Threat Model & Client-Side Trust Assumptions

In the Aspire assessment architecture, **the candidate's browser is treated as hostile and untrusted**:
- A candidate can inspect network requests, DOM elements, JavaScript heap memory, and local/session storage.
- A candidate can manipulate request payloads, headers, timers, and attempt parameters.
- **Principle**: *Never send secret evaluation criteria to the client, and never trust client-asserted assessment state.*

---

## 2. Zero-Leakage Candidate API Sanitization

When candidate endpoints deliver assessment content (`GET /api/attempt/:token`), the payload passes through `snapshotService.sanitizeCandidateQuestions()`:

### Stripped Fields
| Field | Status | Rationale |
| :--- | :---: | :--- |
| `correct_index` | **STRIPPED** | Candidate cannot determine correct MCQ answer through DevTools/inspect. |
| `answer_key` | **STRIPPED** | Candidate cannot read answer key strings. |
| `test_cases` (Hidden) | **STRIPPED** | Candidate receives only public starter code and problem statement. |
| `admin_notes` | **STRIPPED** | Internal review notes and rubric details are kept strictly on the backend. |
| `audit_metadata` | **STRIPPED** | Question creation, author, and internal version timestamps are hidden. |

### Coding Questions
For code assessment:
- Candidate receives: `question_text`, `language`, `code_starter`, `marks`, `display_order`.
- Candidate **never receives**: Hidden unit test suites, execution timeouts, judge credentials, or expected test outputs.
- Evaluation runs strictly server-side against the attempt's frozen question snapshot when `POST /api/attempt/:token/submit` is called.

---

## 3. Deterministic Shuffling Engine

### Algorithm: Fisher-Yates with Cryptographic Counter DRNG
Aspire strictly prohibits `array.sort(() => Math.random() - 0.5)` due to statistical bias, lack of reproducibility, and unpredictable sorting behaviors across JavaScript engines.

Instead, Aspire implements deterministic shuffling via:
1. **Cryptographic Seed Generation**: `crypto.randomBytes(32).toString('hex')` generated once per candidate attempt.
2. **SHA-256 Counter DRNG**:
   $$H_i = \text{SHA-256}(\text{seed} \parallel \text{counter})$$
   Converting 4 bytes into uniform floats in $[0, 1)$.
3. **Fisher-Yates Shuffle**:
   ```javascript
   function fisherYatesShuffle(array, prng) {
     const result = array.slice();
     for (let i = result.length - 1; i > 0; i--) {
       const j = Math.floor(prng() * (i + 1));
       [result[i], result[j]] = [result[j], result[i]];
     }
     return result;
   }
   ```

---

## 4. Shuffle Map Persistence & Audit Trail

Rather than hoping to re-seed pseudo-randomness on every request, Aspire **persists the concrete permutation map** in `attempts.shuffle_map_json`:

```json
{
  "seed": "e1f8...3a92",
  "questions": [104, 101, 105, 102],
  "options": {
    "101": [2, 0, 3, 1],
    "104": [1, 2, 0, 3]
  },
  "sections": {
    "1": [104, 101],
    "2": [105, 102]
  }
}
```

### Benefits
- **Auditability**: During candidate disputes, administrators can inspect the exact order the candidate saw on screen.
- **Idempotency**: Refreshing the browser or reconnecting across multiple tabs always presents the identical sequence.
- **Cross-Candidate Isolation**: Each attempt generates a unique seed, preventing adjacent candidates from copying ordering.

---

## 5. Authoritative Option Mapping & Reverse Grading

When MCQ options are shuffled, the candidate sees display indices $0, 1, 2, \dots$. The candidate submits display index $D$.

Before grading, the server must translate display index $D$ back to logical bank index $L$:

$$L = \text{optionPermutation}[D]$$

### Implementation
```javascript
function reverseOptionIndex(displayIndex, optionPermutationMap) {
  if (!Array.isArray(optionPermutationMap)) return displayIndex;
  const parsed = parseInt(displayIndex, 10);
  if (isNaN(parsed) || parsed < 0 || parsed >= optionPermutationMap.length) {
    return null;
  }
  return optionPermutationMap[parsed];
}
```

Grading logic in `public.js`:
```javascript
const optPerm = (shuffleMap.options && shuffleMap.options[q.id]) || shuffleMap[q.id];
const logicalIndex = reverseOptionIndex(userDisplayIndex, optPerm);
const isCorrect = (logicalIndex === q.correct_index);
```

---

## 6. Cryptographic Snapshot Tamper Detection

To detect accidental database corruption or unauthorized direct modifications to stored attempt records, Aspire calculates a SHA-256 HMAC digest of the attempt's assessment data upon creation:

$$\text{SnapshotHash} = \text{HMAC-SHA256}_{K}(\text{canonical}(\text{examSnapshot}) \parallel \text{canonical}(\text{questionsSnapshot}) \parallel \text{canonical}(\text{shuffleMap}))$$

### Verification
Whenever an attempt is fetched (`GET /api/attempt/:token`) or submitted (`POST /api/attempt/:token/submit`):
```javascript
snapshotService.verifySnapshotIntegrity(attemptRecord);
```
If the stored hash does not match the recomputed hash, execution is aborted immediately with HTTP 409 Conflict:
```json
{
  "success": false,
  "error": "SNAPSHOT_INTEGRITY_FAILURE",
  "code": "SNAPSHOT_INTEGRITY_FAILURE",
  "message": "Attempt snapshot integrity verification failed. Assessment record has been tampered with."
}
```

---

## 7. Question Bank Mutation Isolation

Once an attempt begins, it depends solely on its frozen `questions_snapshot_json`.
- If an admin edits a question in the Question Bank (`UPDATE questions SET question_text = '...', marks = 999`), the active and historical attempts remain unaffected.
- The candidate continues to see the question text and options that existed at the exact moment their attempt was initialized.
- Grading evaluates answers against the frozen snapshot's `correct_index` and frozen `marks`.
