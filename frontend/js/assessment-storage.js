/**
 * Assessment Session Storage Abstraction (Day 12)
 * Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS
 *
 * Provides durable local persistence for MCQ answers, draft code, navigation,
 * and pending synchronization changes using IndexedDB (via idb-keyval) with
 * transparent localStorage fallback.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AssessmentStorage = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let currentToken = null;
  let currentState = null;
  let clientSessionId = null;
  const memoryStore = new Map();

  function getLocalItem(key) {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
    return memoryStore.get(key) || null;
  }

  function setLocalItem(key, val) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, val);
    } else {
      memoryStore.set(key, val);
    }
  }

  function removeLocalItem(key) {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    } else {
      memoryStore.delete(key);
    }
  }

  function getSessionItem(key) {
    if (typeof sessionStorage !== 'undefined') {
      return sessionStorage.getItem(key);
    }
    return memoryStore.get(key) || null;
  }

  function setSessionItem(key, val) {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, val);
    } else {
      memoryStore.set(key, val);
    }
  }

  function randId(prefix = 'ch') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }

  function getStorageKey(token) {
    return `aspire_assessment_${token}`;
  }

  function getSessionIdKey() {
    return 'aspire_client_session_id';
  }

  function resolveSessionId() {
    if (clientSessionId) return clientSessionId;
    try {
      let stored = getSessionItem(getSessionIdKey());
      if (!stored) {
        stored = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 12)}`;
        setSessionItem(getSessionIdKey(), stored);
      }
      clientSessionId = stored;
    } catch {
      clientSessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 12)}`;
    }
    return clientSessionId;
  }

  function createInitialState(token) {
    return {
      token,
      clientSessionId: resolveSessionId(),
      localRevision: 0,
      serverRevision: 0,
      currentQuestionId: null,
      currentSectionId: null,
      answers: {},
      draftCode: {},
      pendingChanges: [],
      lastSyncedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async function rawRead(key) {
    // 1. Try idbKeyval if available
    if (typeof idbKeyval !== 'undefined' && idbKeyval.get) {
      try {
        const val = await idbKeyval.get(key);
        if (val) return val;
      } catch (e) {
        console.warn('[AssessmentStorage] IndexedDB read failed, falling back to localStorage', e);
      }
    }
    // 2. Try localStorage / memoryStore fallback
    try {
      const raw = getLocalItem(key);
      if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      console.warn('[AssessmentStorage] storage read failed', e);
    }
    return null;
  }

  async function rawWrite(key, data) {
    // 1. Write to localStorage / memoryStore
    try {
      setLocalItem(key, JSON.stringify(data));
    } catch (e) {
      console.warn('[AssessmentStorage] storage write failed', e);
    }

    // 2. Write to idbKeyval if available
    if (typeof idbKeyval !== 'undefined' && idbKeyval.set) {
      try {
        await idbKeyval.set(key, data);
      } catch (e) {
        console.warn('[AssessmentStorage] IndexedDB write failed', e);
      }
    }
  }

  async function rawDelete(key) {
    try {
      removeLocalItem(key);
    } catch {}
    if (typeof idbKeyval !== 'undefined' && idbKeyval.del) {
      try {
        await idbKeyval.del(key);
      } catch {}
    }
  }

  const AssessmentStorage = {
    /**
     * Initialize storage for a specific assessment attempt token.
     */
    async init(token) {
      if (!token) throw new Error('Attempt token is required to initialize AssessmentStorage');
      currentToken = token;
      resolveSessionId();

      const key = getStorageKey(token);
      let existing = await rawRead(key);

      if (!existing) {
        existing = createInitialState(token);
        await rawWrite(key, existing);
      } else {
        // Ensure required fields exist in deserialized object
        existing.token = token;
        existing.clientSessionId = existing.clientSessionId || resolveSessionId();
        existing.answers = existing.answers || {};
        existing.draftCode = existing.draftCode || {};
        existing.pendingChanges = Array.isArray(existing.pendingChanges) ? existing.pendingChanges : [];
        existing.localRevision = Number(existing.localRevision) || 0;
        existing.serverRevision = Number(existing.serverRevision) || 0;
      }

      currentState = existing;
      return currentState;
    },

    /**
     * Get current in-memory / persisted assessment state.
     */
    async getAssessmentState() {
      if (currentState) return currentState;
      if (currentToken) {
        currentState = await rawRead(getStorageKey(currentToken));
        if (currentState) return currentState;
        return await this.init(currentToken);
      }
      return null;
    },

    /**
     * Save an entire assessment state.
     */
    async saveAssessmentState(state) {
      if (!state || !state.token) throw new Error('Valid state with token is required');
      state.updatedAt = new Date().toISOString();
      currentState = state;
      await rawWrite(getStorageKey(state.token), state);
      return currentState;
    },

    /**
     * Save an MCQ answer selection and queue a pending sync change.
     */
    async saveMCQAnswer(questionId, answer) {
      const state = await this.getAssessmentState();
      if (!state) throw new Error('AssessmentStorage must be initialized before saving answers');

      const qid = Number(questionId);
      const parsedAns = answer !== null && answer !== undefined && answer !== '' ? Number(answer) : null;

      if (parsedAns !== null) {
        state.answers[qid] = parsedAns;
      } else {
        delete state.answers[qid];
      }

      state.localRevision = (state.localRevision || 0) + 1;

      const change = {
        changeId: randId('mcq'),
        type: 'MCQ_ANSWER',
        questionId: qid,
        answer: parsedAns,
        revision: state.localRevision,
        timestamp: new Date().toISOString()
      };

      state.pendingChanges.push(change);
      await this.saveAssessmentState(state);
      return change;
    },

    /**
     * Save draft code for a coding question and queue a pending sync change.
     * Note: This strictly saves the editor buffer without triggering any BullMQ execution.
     */
    async saveDraftCode(questionId, language, code) {
      const state = await this.getAssessmentState();
      if (!state) throw new Error('AssessmentStorage must be initialized before saving draft code');

      const qid = Number(questionId);
      const lang = String(language || 'python').trim().toLowerCase();
      const src = String(code || '');

      state.draftCode[qid] = {
        code: src,
        language: lang,
        updatedAt: new Date().toISOString()
      };

      state.localRevision = (state.localRevision || 0) + 1;

      const change = {
        changeId: randId('code'),
        type: 'CODE_DRAFT',
        questionId: qid,
        language: lang,
        code: src,
        revision: state.localRevision,
        timestamp: new Date().toISOString()
      };

      state.pendingChanges.push(change);
      await this.saveAssessmentState(state);
      return change;
    },

    /**
     * Save current question and section navigation state.
     */
    async saveCurrentQuestion(questionId, sectionId = null) {
      const state = await this.getAssessmentState();
      if (!state) throw new Error('AssessmentStorage must be initialized before saving question');

      const qid = questionId !== null && questionId !== undefined ? Number(questionId) : null;
      const secId = sectionId !== null && sectionId !== undefined ? Number(sectionId) : null;

      state.currentQuestionId = qid;
      state.currentSectionId = secId;
      state.localRevision = (state.localRevision || 0) + 1;

      const change = {
        changeId: randId('nav'),
        type: 'NAVIGATION',
        questionId: qid,
        sectionId: secId,
        revision: state.localRevision,
        timestamp: new Date().toISOString()
      };

      state.pendingChanges.push(change);
      await this.saveAssessmentState(state);
      return change;
    },

    /**
     * Retrieve all pending unsynchronized changes.
     */
    async getPendingChanges() {
      const state = await this.getAssessmentState();
      return state && Array.isArray(state.pendingChanges) ? [...state.pendingChanges] : [];
    },

    /**
     * Mark confirmed changes as synced, update server revision.
     */
    async markChangesSynced(acknowledgedIds, serverRevision) {
      const state = await this.getAssessmentState();
      if (!state) return;

      const ackSet = new Set(acknowledgedIds);
      state.pendingChanges = (state.pendingChanges || []).filter(c => !ackSet.has(c.changeId));

      if (typeof serverRevision === 'number') {
        state.serverRevision = Math.max(state.serverRevision || 0, serverRevision);
      }
      state.lastSyncedAt = new Date().toISOString();

      await this.saveAssessmentState(state);
    },

    /**
     * Clear all assessment recovery state upon final exam submission.
     */
    async clearAssessmentState() {
      if (!currentToken) return;
      const key = getStorageKey(currentToken);
      await rawDelete(key);
      currentState = null;
    },

    /**
     * Get active client session ID.
     */
    getClientSessionId() {
      return resolveSessionId();
    }
  };

  return AssessmentStorage;
}));
