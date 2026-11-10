/**
 * ASPIRE BY ADYAPAN — IMMERSIVE LUXURY LANDING PAGE
 * Motion Design, Interactive Navigation, Parallax & Carousel
 * Standards: Vanilla JS, Zero External Libraries, Full A11y & Motion Compliance
 */

(() => {
  'use strict';

  // --------------------------------------------------------------------------
  // Motion Preference & Pointer Detection
  // --------------------------------------------------------------------------
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;

  // --------------------------------------------------------------------------
  // 1. Initial Page Load Choreography
  // --------------------------------------------------------------------------
  function initPageLoadChoreography() {
    // Reveal choreographed hero sequence
    requestAnimationFrame(() => {
      document.body.classList.remove('page-loading');
      document.body.classList.add('page-loaded');
    });
  }

  // --------------------------------------------------------------------------
  // 2. Persistent Header Scroll State
  // --------------------------------------------------------------------------
  function initHeaderScroll() {
    const header = document.querySelector('.site-header');
    if (!header) return;

    let ticking = false;

    function onScroll() {
      if (!ticking) {
        requestAnimationFrame(() => {
          if (window.scrollY > 40) {
            header.classList.add('scrolled');
          } else {
            header.classList.remove('scrolled');
          }
          ticking = false;
        });
        ticking = true;
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll(); // Initial check
  }

  // --------------------------------------------------------------------------
  // 3. Navigation Spy & Smooth Anchors
  // --------------------------------------------------------------------------
  function initNavigation() {
    const navAnchors = document.querySelectorAll('.desktop-navigation .nav-anchor');
    const sections = document.querySelectorAll('section[id], footer[id]');
    const header = document.querySelector('.site-header');

    // Smooth Anchor Scrolling with Header Offset Compensation
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener('click', (e) => {
        const targetId = anchor.getAttribute('href');
        if (targetId === '#' || targetId === '#top') {
          e.preventDefault();
          window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
          return;
        }

        const targetEl = document.querySelector(targetId);
        if (targetEl) {
          e.preventDefault();
          const headerHeight = header ? header.offsetHeight : 80;
          const targetY = targetEl.getBoundingClientRect().top + window.pageYOffset - headerHeight;
          window.scrollTo({
            top: targetY,
            behavior: reduceMotion ? 'auto' : 'smooth'
          });
        }
      });
    });

    // Active Section Intersection Observer
    if ('IntersectionObserver' in window && sections.length > 0) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const currentId = '#' + entry.target.id;
            navAnchors.forEach((link) => {
              if (link.getAttribute('href') === currentId) {
                link.classList.add('active');
              } else {
                link.classList.remove('active');
              }
            });
          }
        });
      }, {
        rootMargin: '-30% 0px -60% 0px',
        threshold: 0
      });

      sections.forEach((sec) => observer.observe(sec));
    }
  }

  // --------------------------------------------------------------------------
  // 4. Mobile Navigation Drawer & Focus Trap
  // --------------------------------------------------------------------------
  function initMobileDrawer() {
    const toggleBtn = document.querySelector('.menu-toggle-btn');
    const drawer = document.querySelector('#mobile-nav-drawer');
    const backdrop = document.querySelector('#mobile-drawer-backdrop');
    const closeBtn = document.querySelector('.mobile-close-btn');
    const mobileLinks = document.querySelectorAll('.mobile-nav-link, .mobile-drawer-footer a');

    if (!toggleBtn || !drawer || !backdrop) return;

    function openDrawer() {
      drawer.classList.add('is-open');
      backdrop.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
      toggleBtn.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
      if (closeBtn) closeBtn.focus();
    }

    function closeDrawer() {
      drawer.classList.remove('is-open');
      backdrop.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      toggleBtn.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      toggleBtn.focus();
    }

    toggleBtn.addEventListener('click', () => {
      const isOpen = drawer.classList.contains('is-open');
      if (isOpen) closeDrawer();
      else openDrawer();
    });

    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    backdrop.addEventListener('click', closeDrawer);

    mobileLinks.forEach((link) => {
      link.addEventListener('click', closeDrawer);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawer.classList.contains('is-open')) {
        closeDrawer();
      }
    });
  }

  // --------------------------------------------------------------------------
  // 5. Desktop Fine-Pointer Parallax on Hero Sculpture
  // --------------------------------------------------------------------------
  function initHeroParallax() {
    if (reduceMotion || !finePointer) return;

    const heroSection = document.querySelector('.hero-section');
    const sculpture = document.querySelector('#sculptureFigure');
    const halo = document.querySelector('#goldenHalo');
    const constellation = document.querySelector('#heroConstellation');

    if (!heroSection || !sculpture) return;

    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let rafId = null;

    function renderParallax() {
      // Smooth interpolation (lerp)
      currentX += (targetX - currentX) * 0.08;
      currentY += (targetY - currentY) * 0.08;

      // Sculpture depth
      sculpture.style.transform = `translate3d(${currentX * 14}px, ${currentY * 10}px, 0)`;

      // Halo counter-movement for genuine 3D perspective
      if (halo) {
        halo.style.transform = `translate(calc(-50% + ${-currentX * 8}px), calc(-50% + ${-currentY * 6}px))`;
      }

      // Constellation subtle float
      if (constellation) {
        constellation.style.transform = `translate3d(${currentX * 6}px, ${currentY * 4}px, 0)`;
      }

      rafId = requestAnimationFrame(renderParallax);
    }

    heroSection.addEventListener('pointermove', (e) => {
      const rect = heroSection.getBoundingClientRect();
      targetX = (e.clientX - rect.left) / rect.width - 0.5;
      targetY = (e.clientY - rect.top) / rect.height - 0.5;

      if (!rafId) {
        rafId = requestAnimationFrame(renderParallax);
      }
    });

    heroSection.addEventListener('pointerleave', () => {
      targetX = 0;
      targetY = 0;
    });
  }

  // --------------------------------------------------------------------------
  // 6. Scholarship Highlight Carousel
  // --------------------------------------------------------------------------
  function initScholarshipCarousel() {
    const card = document.querySelector('.scholarship-highlight-card');
    const slides = document.querySelectorAll('.carousel-slide');
    const prevBtn = document.querySelector('#carouselPrevBtn');
    const nextBtn = document.querySelector('#carouselNextBtn');
    const counterDisplay = document.querySelector('#carouselCurrentSlide');

    if (!card || slides.length === 0) return;

    let currentIndex = 0;
    const totalSlides = slides.length;

    function updateSlide(index) {
      if (index < 0) index = totalSlides - 1;
      else if (index >= totalSlides) index = 0;

      currentIndex = index;

      slides.forEach((slide, i) => {
        if (i === currentIndex) {
          slide.classList.add('is-active');
          slide.setAttribute('aria-hidden', 'false');
        } else {
          slide.classList.remove('is-active');
          slide.setAttribute('aria-hidden', 'true');
        }
      });

      if (counterDisplay) {
        counterDisplay.textContent = String(currentIndex + 1).padStart(2, '0');
      }
    }

    if (prevBtn) {
      prevBtn.addEventListener('click', () => updateSlide(currentIndex - 1));
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => updateSlide(currentIndex + 1));
    }

    // Keyboard Arrow navigation when focused
    card.setAttribute('tabindex', '0');
    card.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        updateSlide(currentIndex - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        updateSlide(currentIndex + 1);
      }
    });

    // Touch swipe gesture support
    let touchStartX = 0;
    let touchEndX = 0;

    card.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    card.addEventListener('touchend', (e) => {
      touchEndX = e.changedTouches[0].screenX;
      const diff = touchEndX - touchStartX;
      if (Math.abs(diff) > 40) {
        if (diff < 0) updateSlide(currentIndex + 1); // Swipe left -> next
        else updateSlide(currentIndex - 1); // Swipe right -> prev
      }
    }, { passive: true });
  }

  // --------------------------------------------------------------------------
  // 7. Scroll-Triggered Reveal Animations
  // --------------------------------------------------------------------------
  function initScrollReveals() {
    const revealTargets = document.querySelectorAll('.reveal-on-scroll');
    if (revealTargets.length === 0) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      revealTargets.forEach((el) => el.classList.add('is-revealed'));
      return;
    }

    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const delay = entry.target.dataset.delay || 0;
          if (delay) {
            setTimeout(() => {
              entry.target.classList.add('is-revealed');
            }, Number(delay));
          } else {
            entry.target.classList.add('is-revealed');
          }
          obs.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.12,
      rootMargin: '0px 0px -40px 0px'
    });

    revealTargets.forEach((el) => observer.observe(el));
  }

  // --------------------------------------------------------------------------
  // 8. Animated Counter for Scholarship Tiers
  // --------------------------------------------------------------------------
  function initTierCounters() {
    const tierTable = document.querySelector('#scholarships-tiers');
    const numbers = document.querySelectorAll('.tier-number');
    if (!tierTable || numbers.length === 0) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      numbers.forEach((el) => {
        el.textContent = el.dataset.target || el.textContent;
      });
      return;
    }

    let animated = false;

    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !animated) {
        animated = true;
        observer.disconnect();

        numbers.forEach((el) => {
          const target = parseInt(el.dataset.target, 10);
          if (isNaN(target)) return;

          const duration = 1200;
          const startTime = performance.now();

          function step(now) {
            const progress = Math.min((now - startTime) / duration, 1);
            // Ease-out cubic calculation
            const easeOut = 1 - Math.pow(1 - progress, 3);
            const currentVal = Math.round(target * easeOut);
            el.textContent = currentVal;

            if (progress < 1) {
              requestAnimationFrame(step);
            } else {
              el.textContent = target;
            }
          }

          requestAnimationFrame(step);
        });
      }
    }, { threshold: 0.25 });

    observer.observe(tierTable);
  }

  // --------------------------------------------------------------------------
  // 9. Process Connecting Line Fill Animation & Exact Alignment
  // --------------------------------------------------------------------------
  function initProcessLine() {
    const section = document.querySelector('#experience');
    const line = document.querySelector('.process-connecting-line');
    const lineProgress = document.querySelector('#processLineProgress');
    const regTitle = document.querySelector('.process-step-item:first-child .step-name');
    const celTitle = document.querySelector('.process-step-item.step-celebrate .step-name');
    const wrapper = document.querySelector('.process-track-wrapper');

    function alignLine() {
      if (!line || !regTitle || !celTitle || !wrapper) return;
      if (window.innerWidth >= 992) {
        const wrapRect = wrapper.getBoundingClientRect();
        const regRect = regTitle.getBoundingClientRect();
        const celRect = celTitle.getBoundingClientRect();
        const leftOffset = Math.max(0, regRect.left - wrapRect.left);
        const totalWidth = Math.max(0, celRect.right - regRect.left);
        line.style.left = `${leftOffset}px`;
        line.style.width = `${totalWidth}px`;
        line.style.right = 'auto';

        // Vertically center line precisely halfway between description text and icon circles
        const descEl = document.querySelector('.step-desc');
        const circleEl = document.querySelector('.step-icon-circle');
        if (descEl && circleEl) {
          const descRect = descEl.getBoundingClientRect();
          const circleRect = circleEl.getBoundingClientRect();
          const midY = (descRect.bottom + circleRect.top) / 2 - wrapRect.top - 1;
          line.style.top = `${midY}px`;
        }
      } else {
        line.style.left = '';
        line.style.width = '';
        line.style.right = '';
        line.style.top = '';
      }
    }

    alignLine();
    window.addEventListener('resize', alignLine, { passive: true });

    if (!section || !lineProgress) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      lineProgress.style.width = '100%';
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        alignLine();
        lineProgress.style.width = '100%';
        observer.disconnect();
      }
    }, { threshold: 0.3 });

    observer.observe(section);
  }

  // --------------------------------------------------------------------------
  // 10. Interactive Accessible FAQ Accordion
  // --------------------------------------------------------------------------
  function initFaqAccordion() {
    const faqQuestions = document.querySelectorAll('.faq-question');

    faqQuestions.forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.faq-item');
        const answer = item ? item.querySelector('.faq-answer') : null;
        if (!item || !answer) return;

        const isExpanded = btn.getAttribute('aria-expanded') === 'true';

        // Toggle state
        btn.setAttribute('aria-expanded', String(!isExpanded));
        item.classList.toggle('is-open', !isExpanded);
        answer.hidden = isExpanded;
      });
    });
  }

  // --------------------------------------------------------------------------
  // 11. Subtle Magnetic Hover on Gold CTA Buttons (Desktop)
  // --------------------------------------------------------------------------
  function initMagneticButtons() {
    if (reduceMotion || !finePointer) return;

    const magneticButtons = document.querySelectorAll('.btn-gold-pill');

    magneticButtons.forEach((btn) => {
      btn.addEventListener('pointermove', (e) => {
        const rect = btn.getBoundingClientRect();
        const x = e.clientX - rect.left - rect.width / 2;
        const y = e.clientY - rect.top - rect.height / 2;
        btn.style.transform = `translate(${x * 0.12}px, ${y * 0.12}px)`;
      });

      btn.addEventListener('pointerleave', () => {
        btn.style.transform = '';
      });
    });
  }

  // --------------------------------------------------------------------------
  // Initialize Everything on DOM Ready
  // --------------------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initPageLoadChoreography();
      initHeaderScroll();
      initNavigation();
      initMobileDrawer();
      initHeroParallax();
      initScholarshipCarousel();
      initScrollReveals();
      initTierCounters();
      initProcessLine();
      initFaqAccordion();
      initMagneticButtons();
    });
  } else {
    initPageLoadChoreography();
    initHeaderScroll();
    initNavigation();
    initMobileDrawer();
    initHeroParallax();
    initScholarshipCarousel();
    initScrollReveals();
    initTierCounters();
    initProcessLine();
    initFaqAccordion();
    initMagneticButtons();
  }
})();

