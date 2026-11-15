# ASPIRE BY ADYAPAN — DAY 25
# TECHNICAL ARCHITECTURE DECISION: CODE EDITOR SELECTION
## Monaco Editor vs. CodeMirror 6 Evaluation & Integration Strategy

---

## 1. Context & Objectives

Aspire by Adyapan supports technical coding questions within candidate scholarship assessments across four primary programming languages:
1. Python (3.14)
2. JavaScript (Node.js 24)
3. C++ (GCC 15)
4. Java (OpenJDK 25)

The assessment code editor must:
- Provide an authentic IDE editing experience (line numbers, syntax highlighting, bracket matching, indentation).
- Function within Aspire's lightweight Vanilla JavaScript frontend.
- Maintain fast load times on diverse network conditions.
- Work reliably on student devices ranging from high-end desktop workstations to modest laptops, Chromebooks, and tablets.
- Be accessible (WCAG 2.2 AA compliant, keyboard traversable).
- Never block or delay MCQ question rendering.

---

## 2. Head-to-Head Architectural Evaluation

| Evaluation Metric | Monaco Editor (VS Code Web) | CodeMirror 6 | Winner & Rationale |
| :--- | :--- | :--- | :--- |
| **Bundle Footprint** | Extremely heavy (~15MB to ~30MB across AMD workers, CSS, and assets). | Ultra-lightweight (~300KB minified and compressed). | **CodeMirror 6** (98% lighter bandwidth footprint). |
| **Runtime Architecture** | AMD loader (`require.js`) or complex Webpack/Vite bundler configuration. Dedicated Web Workers for language features. | Modern ECMAScript / IIFE modular architecture. Can run self-hosted without bundlers or AMD ceremony. | **CodeMirror 6** (Seamless native integration with Aspire's zero-build Vanilla JS). |
| **Mobile & Touch Support** | Weak on mobile/tablets. Virtual keyboards frequently desynchronize cursor position; touch selection is erratic. | First-class mobile support. Designed from ground up with mobile virtual keyboard and touch events in mind. | **CodeMirror 6** (Crucial for students taking tests on mobile devices or tablets). |
| **Language Support** | Out-of-the-box syntax highlighting for Python, JS, C++, Java. | Modular language packs for Python, JS, C++, Java with Lezer syntax parsers. | **Tie** (Both support Aspire's 4 core execution languages). |
| **Theme & Customization** | VS Code theme engine, but heavy CSS override requirements. | CSS-in-JS style modules. Effortlessly themeable to Aspire's Midnight Black (`#08090B`) and Gold (`#FFC900`) brand palette. | **CodeMirror 6** (Direct styling integration). |
| **Accessibility (WCAG)** | Screen reader support exists, but complex DOM and hidden textarea traps keyboard navigation if Escape binding fails. | WAI-ARIA compliant. Explicit keyboard trap escape (`Esc` key shifts focus outside editor). Screen reader friendly. | **CodeMirror 6** (Superior keyboard accessibility). |
| **Lazy Loading** | Slow initial chunk compilation and worker spawn (often 1.5s - 3s delay on low-spec hardware). | Instant initialization (< 50ms) when switching to coding question. | **CodeMirror 6** (Zero lag during timed examination). |

---

## 3. Final Decision

**Selected Editor: CodeMirror 6**

### Primary Factors:
1. **Zero-Build Vanilla JS Alignment**: Aspire's frontend is delivered without a Node/Webpack/Vite bundling pipeline. Monaco requires an AMD loader and static worker scripts, whereas CodeMirror provides a clean self-contained bundle that integrates directly via `<script>` and attaches to standard DOM elements.
2. **Bandwidth & Performance Budget**: Students frequently take scholarship exams over 4G/mobile connections or rural Wi-Fi. A 300KB payload loads in under 100ms, while Monaco's multi-megabyte payload risks stalling the exam room initialization.
3. **Robust Mobile & Tablet Experience**: CodeMirror 6 handles touch focus, soft keyboard input, and mobile viewport shifts without jitter or text loss.
4. **Offline & Self-Hosted Reliability**: Self-hosting CodeMirror in `frontend/js/vendor/` guarantees 100% operation in air-gapped or restricted campus intranets without external CDN dependencies.

---

## 4. Integration Blueprint

1. **Self-Hosted Vendor Assets**:
   - `frontend/js/vendor/codemirror/codemirror.bundle.js`: Encapsulates CodeMirror core, line numbers, syntax highlighting (Python, JS, C++, Java), and Aspire luxury midnight theme.
   - `frontend/js/vendor/codemirror/codemirror.css`: Baseline styling for the editor container.
2. **Lazy Initialization**:
   - CodeMirror is initialized *only* when the candidate navigates to a question where `type === 'code'`.
   - MCQ questions remain 100% free of editor overhead.
3. **State Synchronization**:
   - Editor changes trigger debounced saves to `codeAnswers[qid]`, `localStorage`, and `AssessmentStorage` (IndexedDB).
   - Survives tab switches, page reloads, and network drops.
   - Includes explicit "Reset to Starter Code" action with confirmation.

