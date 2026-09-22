// ==UserScript==
// @name         Universal Page Flight Recorder v2.11 — Canonical Telemetry
// @namespace    https://example.local/page-flight-recorder
// @version      2.11.0
// @description  Continuous cross-navigation recorder with causal navigation tracing and clean telemetry.
// @match        *://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

(() => {
  'use strict';

  /*
   * OBSERVATION ONLY:
   * This recorder observes normal browser/page activity.
   * It does not bypass CAPTCHAs, authentication, timers, rewarded-ad
   * requirements, or other access controls.
   *
   * IMPORTANT:
   * Every normal document navigation causes this userscript to execute
   * again. Persistent GM storage reconnects the new document to the same
   * recording session.
   */

  const VERSION = '2.12.0';

  const KEYS = {
    STATE: '__PFR21_STATE__',
    EVENTS: '__PFR21_EVENTS__',
    PENDING_CLICK: '__PFR23_PENDING_CLICKS__',
    PANEL: '__PFR24_PANEL__'
  };

  const DEFAULT_STATE = {
    running: true,
    sessionId: '',
    startedAt: '',
    eventCount: 0,
    clickCount: 0,
    mutationCount: 0,
    resourceCount: 0,
    snapshotCount: 0,
    pageCount: 0,
    navigationCount: 0,
    redirectCount: 0,
    lastClickId: 0,
    lastClick: null,
    lastRedirect: null,
    lastClickOutcome: null,
    clickOutcomes: {
      navigated: 0,
      noNavigation: 0,
      samePageDomChange: 0,
      popupNewTab: 0,
      navigationPending: 0
    },
    lastUrl: '',
    navigationChain: [],
    navigationStats: {
      automatic: 0,
      clickCaused: 0
    },
    telemetry: {
      ignoredRecorderMutations: 0
    },
    urls: [],
    domains: [],
    lastEventAt: '',
    panel: {
      x: null, y: null, width: 360, height: null,
      minimized: false, maximized: false, closed: false
    }
  };

  const safe = (fn, fallback = null) => {
    try { return fn(); } catch (_) { return fallback; }
  };

  function loadState() {
    const s = safe(() => GM_getValue(KEYS.STATE, null), null);
    if (!s || typeof s !== 'object') return {...DEFAULT_STATE};
    return {...DEFAULT_STATE, ...s};
  }

  let state = loadState();

  if (!state.sessionId || !state.startedAt) {
    state = {
      ...DEFAULT_STATE,
      sessionId:
        `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
      startedAt: new Date().toISOString()
    };
  }

  // A navigation must NOT stop the recording.
  // A session remains running until the user explicitly presses STOP.
  if (typeof state.running !== 'boolean') state.running = true;

  const sensitive = /password|passwd|token|secret|authorization|cookie|session|api[_-]?key|csrf|xsrf/i;

  // v2.11: one physical DOM Event must produce one recorder click.
  // A duplicate listener can receive the exact same Event object; WeakSet
  // removes that instrumentation duplication without suppressing real clicks.
  const seenClickEvents = new WeakSet();
  const CLICK_DUPLICATE_WINDOW_MS = 80;
  let lastCanonicalClick = null;

  function isDuplicateClickEvent(e, interactive) {
    if (!e || typeof e !== 'object') return false;
    if (seenClickEvents.has(e)) return true;
    seenClickEvents.add(e);

    const now = Date.now();
    const selector = safe(() => selectorFor(interactive), null);
    const x = Number(e.clientX) || 0;
    const y = Number(e.clientY) || 0;

    // A second independently dispatched click is retained. This fallback only
    // protects against duplicate instrumentation that creates a fresh Event.
    if (
      lastCanonicalClick &&
      now - lastCanonicalClick.timeMs <= CLICK_DUPLICATE_WINDOW_MS &&
      lastCanonicalClick.selector === selector &&
      Math.abs(lastCanonicalClick.x - x) <= 1 &&
      Math.abs(lastCanonicalClick.y - y) <= 1 &&
      lastCanonicalClick.button === e.button &&
      lastCanonicalClick.target === interactive
    ) {
      return true;
    }

    lastCanonicalClick = {
      timeMs: now,
      selector,
      x,
      y,
      button: e.button,
      target: interactive
    };
    return false;
  }

  function stripRecorderOwnedDom(root) {
    if (!root) return;
    const selectors = [
      '#__PFR21_HOST__',
      '#__PFR21_PANEL__',
      '#__PFR21_REOPEN__'
    ];
    for (const selector of selectors) {
      safe(() => {
        root.querySelectorAll(selector).forEach(node => node.remove());
      });
    }
  }

  function redact(value, key = '') {
    if (sensitive.test(String(key))) return '[REDACTED]';

    if (typeof value === 'string') {
      if (value.length > 5000) return value.slice(0, 5000) + '…[TRUNCATED]';
    }

    return value;
  }

  function ensureV26State() {
    state.navigationChain = Array.isArray(state.navigationChain) ? state.navigationChain : [];
    state.navigationStats = state.navigationStats || {automatic: 0, clickCaused: 0};
    state.telemetry = state.telemetry || {ignoredRecorderMutations:0, duplicateClicksSuppressed:0};
    state.clickOutcomes = state.clickOutcomes || {
      navigated: 0,
      noNavigation: 0,
      samePageDomChange: 0,
      popupNewTab: 0,
      navigationPending: 0
    };
    state.telemetry = state.telemetry || {ignoredRecorderMutations:0};
  }

  function saveState() {
    safe(() => GM_setValue(KEYS.STATE, state));
  }

  function loadEvents() {
    const x = safe(() => GM_getValue(KEYS.EVENTS, []), []);
    return Array.isArray(x) ? x : [];
  }

  /*
   * Keep event batches in persistent userscript storage.
   * The event stream belongs to the session, not to an individual page.
   */
  let eventBuffer = [];
  let flushTimer = null;

  function flush() {
    if (!eventBuffer.length) return;

    const existing = loadEvents();

    for (const event of eventBuffer) {
      existing.push(event);
    }

    eventBuffer = [];

    /*
     * Prevent unbounded storage growth from destroying the recorder.
     * The limit is deliberately large but finite.
     */
    const MAX_EVENTS = 50000;
    if (existing.length > MAX_EVENTS) {
      existing.splice(0, existing.length - MAX_EVENTS);
    }

    safe(() => GM_setValue(KEYS.EVENTS, existing));
    saveState();
    updatePanel();
    flushTimer = null;
  }

  function scheduleFlush() {
    if (eventBuffer.length >= 15) {
      flush();
      return;
    }

    if (!flushTimer) {
      flushTimer = setTimeout(flush, 350);
    }
  }

  function rememberUrl(url) {
    if (!url) return;

    state.lastUrl = url;

    if (!state.urls.includes(url)) {
      state.urls.push(url);
      if (state.urls.length > 500) state.urls.shift();
    }

    try {
      const domain = new URL(url).hostname;
      if (domain && !state.domains.includes(domain)) {
        state.domains.push(domain);
        if (state.domains.length > 100) state.domains.shift();
      }
    } catch (_) {}
  }

  function record(type, data = {}) {
    if (!state.running) return;

    const event = {
      id: state.eventCount + 1,
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      type,
      url: location.href,
      ...data
    };

    state.eventCount++;
    state.lastEventAt = event.timestamp;
    rememberUrl(location.href);

    if (type === 'click') state.clickCount++;
    if (type === 'mutation') state.mutationCount++;
    if (type === 'resource') state.resourceCount++;
    if (type === 'snapshot') state.snapshotCount++;
    if (type === 'navigation') state.navigationCount++;
    if (type === 'click-redirect') state.redirectCount++;

    eventBuffer.push(event);
    scheduleFlush();
    updatePanel();
  }

  function isRecorderOwnedNode(node) {
    if (!node) return false;
    let el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return false;

    for (let i = 0; el && i < 12; i++) {
      if (el.id === '__PFR21_HOST__' || el.id === '__PFR21_PANEL__' || el.id === '__PFR21_REOPEN__') return true;
      const root = safe(() => el.getRootNode?.(), null);
      const host = root?.host;
      if (host) {
        if (host.id === '__PFR21_HOST__' || host.id === '__PFR21_PANEL__') return true;
        el = host;
      } else {
        el = el.parentElement;
      }
    }
    return false;
  }

  function isRecorderOwnedMutation(m) {
    if (!m) return true;
    if (isRecorderOwnedNode(m.target)) return true;
    const nodes = [...(m.addedNodes || []), ...(m.removedNodes || [])];
    if (!nodes.length) return false;
    return nodes.every(isRecorderOwnedNode);
  }

  function filterMutationNodes(nodes) {
    return [...(nodes || [])].filter(node => !isRecorderOwnedNode(node));
  }


  function elementInfo(el) {
    if (!el || el.nodeType !== 1 || isRecorderOwnedNode(el)) return null;

    const rect = safe(() => el.getBoundingClientRect(), null);
    const style = safe(() => getComputedStyle(el), null);

    return {
      tag: el.tagName,
      id: el.id || null,
      classes:
        typeof el.className === 'string'
          ? el.className.slice(0, 1000)
          : null,
      name: el.getAttribute('name'),
      role: el.getAttribute('role'),
      type: el.getAttribute('type'),
      ariaLabel: el.getAttribute('aria-label'),
      href: redact(el.getAttribute('href') || '', 'href'),
      text: safe(
        () => (el.innerText || el.textContent || '').trim().slice(0, 1200),
        ''
      ),
      selector: selectorFor(el),
      html: safe(() => el.outerHTML.slice(0, 6000), ''),
      visible: !!(
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        style &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      ),
      disabled:
        !!el.disabled ||
        el.getAttribute('aria-disabled') === 'true',
      bounds: rect
        ? {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          }
        : null,
      computed: style
        ? {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            position: style.position,
            zIndex: style.zIndex,
            pointerEvents: style.pointerEvents
          }
        : null
    };
  }

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return null;

    if (el.id) {
      try { return `#${CSS.escape(el.id)}`; }
      catch (_) { return `#${el.id}`; }
    }

    const parts = [];
    let current = el;

    for (let i = 0; current && current.nodeType === 1 && i < 7; i++) {
      let part = current.tagName.toLowerCase();

      if (current.classList && current.classList.length) {
        const classes = [...current.classList]
          .slice(0, 3)
          .map(x => {
            try { return CSS.escape(x); }
            catch (_) { return x.replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
          });

        if (classes.length) part += '.' + classes.join('.');
      }

      const parent = current.parentElement;

      if (parent) {
        const sameTag = [...parent.children]
          .filter(x => x.tagName === current.tagName);

        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
        }
      }

      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(' > ');
  }

  function hitStack(x, y) {
    return safe(
      () =>
        document
          .elementsFromPoint(x, y)
          .slice(0, 20)
          .map(elementInfo)
          .filter(Boolean),
      []
    );
  }

  function makeSnapshot(label) {
    return {
      label,
      timestamp: new Date().toISOString(),
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      visibility: document.visibilityState,
      html: safe(() => {
        const clone = document.documentElement?.cloneNode(true);
        if (!clone) return null;
        stripRecorderOwnedDom(clone);
        return clone.outerHTML.slice(0, 75000);
      }, null),
      bodyText: safe(
        () => document.body?.innerText?.slice(0, 15000),
        null
      )
    };
  }

  const CLICK_OUTCOME_WINDOW_MS = 5000;
  const PENDING_CLICK_MAX_AGE_MS = 30000;

  function pendingClicks(values) {
    if (arguments.length) {
      const next = Array.isArray(values) ? values : [];
      if (next.length) safe(() => GM_setValue(KEYS.PENDING_CLICK, next));
      else safe(() => GM_deleteValue(KEYS.PENDING_CLICK));
      return next;
    }
    const raw = safe(() => GM_getValue(KEYS.PENDING_CLICK, []), []);
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object' && raw.clickId) return [raw];
    return [];
  }

  function pendingClickById(clickId) {
    return pendingClicks().find(p => Number(p.clickId) === Number(clickId)) || null;
  }

  function upsertPendingClick(p) {
    if (!p) return;
    const list = pendingClicks().filter(x => Number(x.clickId) !== Number(p.clickId));
    list.push(p);
    pendingClicks(list);
  }

  function removePendingClick(clickId) {
    pendingClicks(pendingClicks().filter(p => Number(p.clickId) !== Number(clickId)));
  }

  function clearExpiredPendingClick(maxAgeMs = PENDING_CLICK_MAX_AGE_MS) {
    const now = Date.now();
    const list = pendingClicks();
    const expired = list.filter(p => {
      const age = now - Number(p.timeMs || 0);
      return age > maxAgeMs || age < 0;
    });
    if (expired.length) {
      for (const p of expired) {
        if (!p.outcomeResolved) {
          finishClickOutcome(p, p.samePageDomChanged || p.historyChanged ? 'same-page-dom-change' : 'no-navigation', {
            method: p.historyChanged ? 'same-page-history' : (p.samePageDomChanged ? 'same-page-dom' : null)
          });
        }
      }
      pendingClicks(pendingClicks().filter(p => !expired.some(x => x.clickId === p.clickId)));
    }
  }

  function selectNavigationPending(from, to) {
    clearExpiredPendingClick();
    const candidates = pendingClicks().filter(p => isPendingClickCorrelatable(p, from, to));
    if (!candidates.length) return null;

    // Prefer an exact expected href, then the newest click. This prevents a
    // rapid second click from overwriting the first click's lifecycle.
    const exact = candidates.filter(p => p.expectedHref === to);
    const pool = exact.length ? exact : candidates;
    return pool.sort((a,b) => Number(b.timeMs || 0) - Number(a.timeMs || 0))[0];
  }

  function isPendingClickCorrelatable(p, from, to) {
    if (!p || !from || !to || from === to) return false;
    const age = Date.now() - Number(p.timeMs || 0);
    if (age < 0 || age > 30000) return false;
    if (!p.from || p.from !== from) return false;
    if (p.outcomeResolved) return false;

    // A concrete href is strong evidence.  A null href is still valid for
    // script-driven navigation, but the navigation must originate from the
    // same document that received the click.
    if (p.expectedHref && p.expectedHref !== to) {
      try {
        const a = new URL(p.expectedHref);
        const b = new URL(to);
        if (a.origin !== b.origin || a.pathname !== b.pathname || a.search !== b.search) {
          return false;
        }
      } catch (_) {
        return false;
      }
    }
    return true;
  }

  function bumpOutcomeCounter(classification) {
    if (!state.clickOutcomes) {
      state.clickOutcomes = {
        navigated: 0,
        noNavigation: 0,
        samePageDomChange: 0,
        popupNewTab: 0,
        navigationPending: 0
      };
    }

    const map = {
      'navigated': 'navigated',
      'no-navigation': 'noNavigation',
      'same-page-dom-change': 'samePageDomChange',
      'popup-new-tab': 'popupNewTab',
      'navigation-pending': 'navigationPending'
    };

    const key = map[classification];
    if (key) state.clickOutcomes[key] = Number(state.clickOutcomes[key] || 0) + 1;
  }

  function finishClickOutcome(p, classification, extra = {}) {
    if (!p || !classification) return;

    if (!p.outcomeResolved) {
      p.outcomeResolved = true;
      if (state.clickOutcomes) {
        state.clickOutcomes.navigationPending = Math.max(
          0,
          Number(state.clickOutcomes.navigationPending || 0) - 1
        );
      }
    }

    const delayMs = Math.max(0, Date.now() - p.timeMs);
    const outcome = {
      clickId: p.clickId,
      from: p.from,
      to: extra.to || null,
      delayMs,
      classification,
      method: extra.method || null,
      navigationType: extra.navigationType || null,
      expectedHref: p.expectedHref || null,
      clicked: p.clicked || null,
      signals: {
        samePageDomChanged: !!p.samePageDomChanged,
        historyChanged: !!p.historyChanged,
        popupOpened: !!p.popupOpened
      }
    };

    state.lastClickOutcome = outcome;
    bumpOutcomeCounter(classification);
    record('click-outcome', outcome);
    saveState();
  }

  function addNavigationChainEdge(edge) {
    state.navigationChain = Array.isArray(state.navigationChain)
      ? state.navigationChain
      : [];

    state.navigationChain.push({
      timestamp: new Date().toISOString(),
      ...edge
    });

    if (state.navigationChain.length > 300) {
      state.navigationChain = state.navigationChain.slice(-300);
    }

    saveState();
  }

  function recordAutomaticNavigation(from, to, method) {
    if (!to || from === to) return;

    const edge = {
      type: 'automatic-navigation',
      from: from || null,
      to,
      method: method || 'document-navigation',
      cause: 'not-correlated-to-click'
    };

    addNavigationChainEdge(edge);
    state.navigationStats = state.navigationStats || {automatic: 0, clickCaused: 0};
    state.navigationStats.automatic++;
    record('automatic-navigation', edge);
  }

  function recordClickNavigationEdge(trace) {
    state.navigationStats = state.navigationStats || {automatic: 0, clickCaused: 0};
    state.navigationStats.clickCaused++;
    addNavigationChainEdge({
      type: 'click-navigation',
      clickId: trace.clickId,
      from: trace.from,
      to: trace.to,
      method: trace.method,
      delayMs: trace.delayMs,
      classification: 'navigated'
    });
  }

  function classifyNavigation(to, method, previousUrl = state.lastUrl || null) {
    if (!to || !previousUrl || to === previousUrl) return;

    const currentPending = selectNavigationPending(previousUrl, to);

    if (currentPending) {
      const classification = currentPending.target === '_blank' ? 'popup-new-tab' : 'navigated';
      const trace = {
        clickId: currentPending.clickId,
        from: currentPending.from,
        to,
        delayMs: Math.max(0, Date.now() - currentPending.timeMs),
        method: method || 'document-navigation',
        navigationType: method || 'document-navigation',
        clicked: currentPending.clicked,
        expectedHref: currentPending.expectedHref || null
      };

      state.lastRedirect = trace;
      record('click-redirect', trace);
      recordClickNavigationEdge({...trace, classification});
      finishClickOutcome(currentPending, classification, {
        to,
        method: trace.method,
        navigationType: trace.navigationType
      });
      removePendingClick(currentPending.clickId);
      return;
    }

    recordAutomaticNavigation(previousUrl, to, method || 'document-navigation');
  }

  function correlateRedirect(to, method) {
    const from = state.lastUrl || null;
    if (!to || !from || to === from) return;
    classifyNavigation(to, method, from);
  }

  function correlateNewDocument(previousUrl = null) {
    const from = previousUrl || state.lastUrl || null;
    if (!from || from === location.href) return;
    classifyNavigation(location.href, 'document-navigation', from);
  }

  function noteSamePageSignal(kind) {
    clearExpiredPendingClick();
    const list = pendingClicks();
    if (!list.length) return;

    // A same-page DOM/history signal is attributed to the newest live click
    // in this document. Older rapid clicks retain independent lifecycles.
    const candidates = list
      .filter(p => Date.now() - Number(p.timeMs || 0) >= 0 && Date.now() - Number(p.timeMs || 0) <= CLICK_OUTCOME_WINDOW_MS)
      .sort((a,b) => Number(b.timeMs || 0) - Number(a.timeMs || 0));
    const p = candidates[0];
    if (!p) return;

    if (kind === 'dom') p.samePageDomChanged = true;
    if (kind === 'history') p.historyChanged = true;
    upsertPendingClick(p);
  }

  function scheduleClickOutcomeResolution(clickId) {
    setTimeout(() => {
      const p = pendingClickById(clickId);
      if (!p || p.outcomeResolved) return;

      const age = Date.now() - p.timeMs;
      if (age < CLICK_OUTCOME_WINDOW_MS) return;

      if (p.popupOpened) {
        finishClickOutcome(p, 'popup-new-tab', {method:'window.open', navigationType:'popup'});
      } else if (p.samePageDomChanged || p.historyChanged) {
        finishClickOutcome(p, 'same-page-dom-change', {method:p.historyChanged ? 'same-page-history' : 'same-page-dom'});
      } else {
        finishClickOutcome(p, 'no-navigation', {method:null, navigationType:null});
      }
      removePendingClick(clickId);
    }, CLICK_OUTCOME_WINDOW_MS + 50);
  }



  function installPopupHook() {
    const originalOpen = window.open;

    if (!originalOpen || originalOpen.__pfr25Wrapped) return;

    const wrappedOpen = function (...args) {
      const result = originalOpen.apply(this, args);
      const p = pendingClickById(state.lastClickId);

      if (p) {
        const age = Date.now() - p.timeMs;

        if (age >= 0 && age <= CLICK_OUTCOME_WINDOW_MS) {
          p.popupOpened = true;
          p.popupUrl = args[0] || null;
          safe(() => GM_setValue(KEYS.PENDING_CLICK, p));

          record('popup-open', {
            clickId: p.clickId,
            from: p.from,
            targetUrl: args[0] || null,
            target: args[1] || null,
            features: args[2] || null
          });
        }
      }

      return result;
    };

    wrappedOpen.__pfr25Wrapped = true;

    try {
      window.open = wrappedOpen;
    } catch (_) {}
  }

  function installNavigationHooks() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];

      if (!original || original.__pfr21Wrapped) continue;

      const wrapped = function (...args) {
        const before = location.href;
        const result = original.apply(this, args);

        record('navigation', {method,before,after:location.href,stateChanged:before !== location.href});
        state.lastUrl = location.href;
        if (before !== location.href) {
          correlateRedirect(location.href, method);
        } else {
          noteSamePageSignal('history');
        }
        return result;
      };

      wrapped.__pfr21Wrapped = true;

      try { history[method] = wrapped; }
      catch (_) {}
    }

    addEventListener(
      'popstate',
      () => {
        record('navigation',{method:'popstate',after:location.href});
        correlateRedirect(location.href,'popstate');
        noteSamePageSignal('history');
      },
      true
    );

    addEventListener(
      'hashchange',
      e => {
        record('navigation',{method:'hashchange',oldURL:e.oldURL,newURL:e.newURL});
        correlateRedirect(e.newURL,'hashchange');
        noteSamePageSignal('history');
      },
      true
    );

    /*
     * pagehide/beforeunload are diagnostics only.
     * They NEVER set running=false.
     */
    addEventListener(
      'pagehide',
      e =>
        record('pagehide', {
          persisted: !!e.persisted
        }),
      true
    );

    addEventListener(
      'beforeunload',
      () => {
        record('beforeunload');
        flush();
      },
      true
    );
  }

  function installClickHooks() {
    addEventListener(
      'click',
      e => {
        const target = e.target;
        if (isRecorderOwnedNode(target)) return;

        const interactive = safe(() => target?.closest?.('a[href],button,input,[role="button"],[role="link"],[onclick]'), null) || target;
        if (isDuplicateClickEvent(e, interactive)) {
          state.telemetry = state.telemetry || {ignoredRecorderMutations:0};
          state.telemetry.duplicateClicksSuppressed =
            Number(state.telemetry.duplicateClicksSuppressed || 0) + 1;
          saveState();
          return;
        }
        const info = elementInfo(interactive);
        const clickId = ++state.lastClickId;
        const rawHref = safe(() => interactive?.getAttribute?.('href'), null);
        const expectedHref = rawHref ? safe(() => new URL(rawHref, location.href).href, rawHref) : null;
        const linkTarget = safe(() => interactive?.getAttribute?.('target'), null);
        state.lastClick = {clickId, from:location.href, text:info?.text || '', selector:info?.selector || null, expectedHref};
        upsertPendingClick({
          clickId,
          timeMs: Date.now(),
          from: location.href,
          clicked: info,
          expectedHref,
          target: linkTarget,
          samePageDomChanged: false,
          historyChanged: false,
          popupOpened: false
        });

        state.clickOutcomes = state.clickOutcomes || {
          navigated: 0,
          noNavigation: 0,
          samePageDomChange: 0,
          popupNewTab: 0,
          navigationPending: 0
        };

        state.clickOutcomes.navigationPending++;
        record('click', {
          clickId,
          x: e.clientX,
          y: e.clientY,
          button: e.button,
          target: elementInfo(target),
          interactive: info,
          expectedHref,
          linkTarget,
          hitStack: hitStack(e.clientX, e.clientY)
        });

        record('click-pending', {
          clickId,
          classification: 'navigation-pending',
          from: location.href,
          expectedHref
        });

        scheduleClickOutcomeResolution(clickId);
      },
      true
    );

    addEventListener(
      'pointerdown',
      e => {
        if (isRecorderOwnedNode(e.target)) return;
        record('pointerdown', {
          x: e.clientX,
          y: e.clientY,
          pointerType: e.pointerType,
          target: elementInfo(e.target)
        });
      },
      true
    );

    addEventListener(
      'pointerup',
      e => {
        if (isRecorderOwnedNode(e.target)) return;
        record('pointerup', {
          x: e.clientX,
          y: e.clientY,
          pointerType: e.pointerType,
          target: elementInfo(e.target)
        });
      },
      true
    );
  }

  function installInputHooks() {
    addEventListener(
      'input',
      e => {
        if (isRecorderOwnedNode(e.target)) return;
        record('input', {
          target: elementInfo(e.target),
          value: '[REDACTED]'
        });
      },
      true
    );

    addEventListener(
      'change',
      e => {
        if (isRecorderOwnedNode(e.target)) return;
        record('change', {
          target: elementInfo(e.target),
          value: '[REDACTED]'
        });
      },
      true
    );

    addEventListener(
      'keydown',
      e => {
        if (isRecorderOwnedNode(e.target)) return;
        record('keydown', {
          key: e.key,
          code: e.code,
          ctrl: e.ctrlKey,
          alt: e.altKey,
          shift: e.shiftKey,
          meta: e.metaKey,
          target: elementInfo(e.target)
        });
      },
      true
    );
  }

  function installMutationObserver() {
    const start = () => {
      if (!document.documentElement) return;

      const observer = new MutationObserver(mutations => {
        for (const m of mutations.slice(0, 150)) {
          if (isRecorderOwnedMutation(m)) {
            state.telemetry = state.telemetry || {ignoredRecorderMutations:0};
            state.telemetry.ignoredRecorderMutations++;
            continue;
          }

          const addedNodes = filterMutationNodes(m.addedNodes);
          const removedNodes = filterMutationNodes(m.removedNodes);
          const targetOwned = isRecorderOwnedNode(m.target);

          // Never serialize recorder-owned nodes, even when a browser mutation
          // batches recorder UI changes together with page mutations.
          if (m.type === 'childList' && addedNodes.length === 0 && removedNodes.length === 0) continue;
          if (targetOwned) {
            state.telemetry = state.telemetry || {ignoredRecorderMutations:0};
            state.telemetry.ignoredRecorderMutations++;
            continue;
          }

          noteSamePageSignal('dom');

          record('mutation', {
            mutationType: m.type,
            target: elementInfo(m.target),
            attributeName: m.attributeName || null,
            oldValue: redact(m.oldValue, m.attributeName || ''),
            added: addedNodes.slice(0, 10).map(node =>
              node.nodeType === 1 ? elementInfo(node) : {nodeType: node.nodeType, text: String(node.textContent || '').slice(0, 500)}
            ),
            removed: removedNodes.slice(0, 10).map(node =>
              node.nodeType === 1 ? elementInfo(node) : {nodeType: node.nodeType, text: String(node.textContent || '').slice(0, 500)}
            )
          });
        }
      });

      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeOldValue: true,
        characterData: true,
        characterDataOldValue: true
      });

      record('observer-installed');
    };

    if (document.documentElement) start();
    else addEventListener('DOMContentLoaded', start, {once: true});
  }

  function installResourceObserver() {
    const seen = new Set();

    const scan = () => {
      if (!state.running) return;

      const entries = safe(
        () => performance.getEntriesByType('resource'),
        []
      );

      for (const r of entries) {
        const key = `${r.name}|${r.startTime}|${r.duration}`;

        if (seen.has(key)) continue;
        seen.add(key);

        record('resource', {
          name: redact(r.name, 'url'),
          initiatorType: r.initiatorType,
          startTime: r.startTime,
          duration: r.duration,
          transferSize: r.transferSize,
          encodedBodySize: r.encodedBodySize,
          decodedBodySize: r.decodedBodySize
        });
      }
    };

    scan();
    setInterval(scan, 1000);
  }

  function installErrorHooks() {
    addEventListener(
      'error',
      e =>
        record('javascript-error', {
          message: e.message || null,
          filename: e.filename || null,
          line: e.lineno || null,
          column: e.colno || null,
          stack: e.error?.stack || null
        }),
      true
    );

    addEventListener(
      'unhandledrejection',
      e =>
        record('unhandledrejection', {
          reason: String(e.reason || '').slice(0, 4000)
        }),
      true
    );
  }

  /*
   * Timer instrumentation is intentionally disabled.
   * The recorder itself uses timers for batching and sampling. Wrapping
   * setTimeout/setInterval would make the recorder observe its own timers
   * and recursively call record(), which can stop the panel from appearing
   * on redirect-heavy sites.
   */

  function installStateSampler() {
    setInterval(() => {
      if (!state.running) return;

      record('state-sample', {
        title: document.title,
        readyState: document.readyState,
        visibility: document.visibilityState,
        url: location.href,
        activeElement: elementInfo(document.activeElement)
      });
    }, 2000);
  }

  function installDocumentEvents() {
    addEventListener(
      'DOMContentLoaded',
      () => {
        state.pageCount++;
        rememberUrl(location.href);

        record('page-loaded', {
          title: document.title,
          pageNumber: state.pageCount
        });

        record('snapshot', makeSnapshot('DOMContentLoaded'));

        saveState();
        flush();
        updatePanel();
      },
      {once: true}
    );

    addEventListener(
      'load',
      () => {
        record('window-load', {
          title: document.title
        });

        saveState();
        flush();
      },
      {once: true}
    );
  }

  /*
   * Persistent floating panel.
   *
   * It is recreated on every document because the DOM itself is replaced
   * by a normal navigation. The session data remains persistent.
   */
  function loadPanelState() {
    const p = safe(() => GM_getValue(KEYS.PANEL, null), null);
    const base = DEFAULT_STATE.panel;
    if (!p || typeof p !== 'object') return {...base};
    return {
      ...base,
      ...p,
      width: Number.isFinite(Number(p.width)) ? Number(p.width) : base.width,
      height: p.height == null ? base.height : Number(p.height)
    };
  }

  function savePanelState(panelState) {
    safe(() => GM_setValue(KEYS.PANEL, panelState));
  }

  let panelState = loadPanelState();

  function clampPanelPosition(x, y, width, height) {
    const vw = Math.max(320, window.innerWidth || 320);
    const vh = Math.max(220, window.innerHeight || 220);
    const w = Math.min(Math.max(260, width || 360), Math.max(260, vw - 12));
    const h = Math.min(Math.max(54, height || 220), Math.max(54, vh - 12));
    return {
      x: Math.min(Math.max(6, Number(x) || 6), Math.max(6, vw - w - 6)),
      y: Math.min(Math.max(6, Number(y) || 6), Math.max(6, vh - h - 6))
    };
  }

  function applyPanelGeometry(panel) {
    if (!panel) return;
    const vw = Math.max(320, window.innerWidth || 320);
    const vh = Math.max(220, window.innerHeight || 220);

    if (panelState.maximized) {
      panel.style.left = '6px';
      panel.style.top = '6px';
      panel.style.right = 'auto';
      panel.style.width = `${Math.max(300, vw - 12)}px`;
      panel.style.height = `${Math.max(160, vh - 12)}px`;
      panel.style.maxHeight = 'none';
      return;
    }

    panel.style.right = 'auto';
    panel.style.left = `${panelState.x == null ? Math.max(6, vw - 372) : panelState.x}px`;
    panel.style.top = `${panelState.y == null ? 12 : panelState.y}px`;
    panel.style.width = `${Math.min(Math.max(260, panelState.width || 360), Math.max(260, vw - 12))}px`;
    panel.style.height = panelState.minimized ? 'auto' : (panelState.height ? `${panelState.height}px` : 'auto');
    panel.style.maxHeight = panelState.minimized ? 'none' : `${Math.max(160, vh - 12)}px`;
  }

  function setPanelClosed(closed) {
    panelState.closed = !!closed;
    savePanelState(panelState);
    const host = document.getElementById('__PFR21_HOST__');
    const root = host?.shadowRoot;
    const panel = root?.getElementById('__PFR21_PANEL__');
    const reopen = root?.getElementById('__PFR21_REOPEN__');
    if (panel) panel.style.display = panelState.closed ? 'none' : 'block';
    if (reopen) reopen.style.display = panelState.closed ? 'flex' : 'none';
  }

  function toggleMinimized() {
    panelState.minimized = !panelState.minimized;
    panelState.closed = false;
    savePanelState(panelState);
    const host = document.getElementById('__PFR21_HOST__');
    const root = host?.shadowRoot;
    const panel = root?.getElementById('__PFR21_PANEL__');
    const body = root?.getElementById('__PFR24_BODY__');
    const button = root?.getElementById('__PFR24_MIN__');
    if (body) body.style.display = panelState.minimized ? 'none' : 'block';
    if (button) button.textContent = panelState.minimized ? '▢' : '—';
    applyPanelGeometry(panel);
  }

  function toggleMaximized() {
    panelState.maximized = !panelState.maximized;
    panelState.closed = false;
    savePanelState(panelState);
    const host = document.getElementById('__PFR21_HOST__');
    const root = host?.shadowRoot;
    const panel = root?.getElementById('__PFR21_PANEL__');
    const button = root?.getElementById('__PFR24_MAX__');
    if (button) button.textContent = panelState.maximized ? '❐' : '□';
    applyPanelGeometry(panel);
  }

  function installPanelDrag(panel, header) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    header.addEventListener('pointerdown', e => {
      if (e.button !== 0 || panelState.maximized) return;
      if (e.target?.closest?.('button')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = panel.offsetLeft;
      startTop = panel.offsetTop;
      header.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    header.addEventListener('pointermove', e => {
      if (!dragging) return;
      const next = clampPanelPosition(
        startLeft + (e.clientX - startX),
        startTop + (e.clientY - startY),
        panel.offsetWidth,
        panel.offsetHeight
      );
      panel.style.left = `${next.x}px`;
      panel.style.top = `${next.y}px`;
    });

    header.addEventListener('pointerup', e => {
      if (!dragging) return;
      dragging = false;
      header.releasePointerCapture?.(e.pointerId);
      panelState.x = panel.offsetLeft;
      panelState.y = panel.offsetTop;
      savePanelState(panelState);
    });

    header.addEventListener('pointercancel', () => { dragging = false; });
  }

  function createPanel() {
    if (!state.running) return;

    if (document.getElementById('__PFR21_PANEL__')) return;

    const host = document.documentElement || document.body;
    if (!host) return;

    const panelHost = document.createElement('div');
    panelHost.id = '__PFR21_HOST__';
    panelHost.style.cssText =
      'all:initial !important;position:fixed !important;top:0 !important;' +
      'left:0 !important;width:100% !important;height:100% !important;' +
      'pointer-events:none !important;z-index:2147483647 !important;';

    const shadow = panelHost.attachShadow
      ? panelHost.attachShadow({mode:'open'})
      : panelHost;

    const style = document.createElement('style');
    style.textContent = `
      #__PFR21_PANEL__ {
        position:fixed;z-index:2147483647;background:#111;color:#fff;
        border:1px solid #555;border-radius:10px;padding:10px;
        box-sizing:border-box;font:12px/1.35 Arial,sans-serif;
        box-shadow:0 5px 25px rgba(0,0,0,.45);pointer-events:auto;
        min-width:260px;min-height:54px;resize:both;overflow:hidden;
      }
      #__PFR24_HEADER {display:flex;align-items:center;gap:5px;cursor:move;user-select:none;touch-action:none;}
      #__PFR24_TITLE {font-weight:700;font-size:14px;flex:1;}
      #__PFR24_CONTROLS {display:flex;gap:3px;}
      #__PFR24_CONTROLS button {width:25px;height:23px;padding:0;border-radius:5px;}
      #__PFR24_BODY {overflow:auto;max-height:calc(100vh - 70px);}
      button {font:inherit;color:#111;background:#fff;border:1px solid #aaa;border-radius:5px;padding:6px 9px;cursor:pointer;}
      button:disabled {opacity:.5;cursor:not-allowed;}
      #__PFR21_REOPEN__ {position:fixed;right:10px;top:10px;width:32px;height:32px;border-radius:8px;background:#111;color:#fff;border:1px solid #666;display:none;align-items:center;justify-content:center;cursor:pointer;font-weight:700;pointer-events:auto;box-shadow:0 3px 12px rgba(0,0,0,.45);}
    `;

    const panel = document.createElement('div');
    panel.id = '__PFR21_PANEL__';

    panel.innerHTML = `
      <div id="__PFR24_HEADER">
        <div id="__PFR24_TITLE">Flight Recorder <span style="opacity:.65">v${VERSION}</span></div>
        <div id="__PFR24_CONTROLS">
          <button id="__PFR24_MIN__" title="Minimize">—</button>
          <button id="__PFR24_MAX__" title="Maximize">□</button>
          <button id="__PFR24_CLOSE__" title="Close panel">×</button>
        </div>
      </div>

      <div id="__PFR24_BODY">
        <div id="__PFR21_STATUS__" style="color:#5cff75;font-weight:700;margin:8px 0">
          ● RECORDING
        </div>

        <div id="__PFR21_STATS__" style="white-space:pre-wrap;color:#ddd"></div>

        <div id="__PFR21_URL__" style="margin-top:8px;padding:6px;background:#1b1b1b;border-radius:5px;word-break:break-all;max-height:90px;overflow:auto;color:#aaa"></div>

        <div style="display:flex;gap:6px;margin-top:9px">
          <button id="__PFR21_DOWNLOAD__" style="flex:1;padding:6px;cursor:pointer">Download JSON</button>
          <button id="__PFR25_CHAIN__" style="padding:6px 10px;cursor:pointer">CHAIN</button>
          <button id="__PFR21_STOP__" style="padding:6px 10px;cursor:pointer">STOP</button>
        </div>
      </div>
    `;

    const reopen = document.createElement('button');
    reopen.id = '__PFR21_REOPEN__';
    reopen.textContent = 'FR';
    reopen.title = 'Open Flight Recorder';

    shadow.appendChild(style);
    shadow.appendChild(panel);
    shadow.appendChild(reopen);
    host.appendChild(panelHost);

    installPanelDrag(panel, panel.querySelector('#__PFR24_HEADER'));

    panel.addEventListener('pointerup', () => {
      // Capture user-resized dimensions without interfering with drag behavior.
      if (!panelState.maximized && !panelState.minimized) {
        panelState.width = panel.offsetWidth;
        panelState.height = panel.offsetHeight;
        panelState.x = panel.offsetLeft;
        panelState.y = panel.offsetTop;
        savePanelState(panelState);
      }
    }, true);

    panel.querySelector('#__PFR24_MIN__').addEventListener('click', toggleMinimized);
    panel.querySelector('#__PFR24_MAX__').addEventListener('click', toggleMaximized);
    panel.querySelector('#__PFR24_CLOSE__').addEventListener('click', () => setPanelClosed(true));
    reopen.addEventListener('click', () => setPanelClosed(false));

    panel.querySelector('#__PFR21_DOWNLOAD__').addEventListener(
      'click',
      () => exportRecording(false)
    );

    panel.querySelector('#__PFR25_CHAIN__').addEventListener(
      'click',
      () => exportChainText()
    );

    panel.querySelector('#__PFR21_STOP__').addEventListener(
      'click',
      () => exportRecording(true)
    );

    const body = panel.querySelector('#__PFR24_BODY__');
    const minButton = panel.querySelector('#__PFR24_MIN__');
    const maxButton = panel.querySelector('#__PFR24_MAX__');
    if (body) body.style.display = panelState.minimized ? 'none' : 'block';
    if (minButton) minButton.textContent = panelState.minimized ? '▢' : '—';
    if (maxButton) maxButton.textContent = panelState.maximized ? '❐' : '□';
    applyPanelGeometry(panel);
    setPanelClosed(panelState.closed);
    updatePanel();
  }

  function buildChain(limit = 100) {
    const events = loadEvents();
    const chain = [];
    const seen = new Set();

    function push(item) {
      const key = [
        item.type,
        item.clickId || '',
        item.from || '',
        item.to || '',
        item.classification || '',
        item.delayMs == null ? '' : item.delayMs
      ].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      chain.push(item);
    }

    for (const e of events) {
      // Canonical rule: a click that caused navigation appears ONLY as
      // click-navigation. A click that stayed on the page appears as its
      // final click-outcome. The intermediate click-redirect telemetry is
      // intentionally not exported as a second chain edge.
      if (e.type === 'click-redirect') {
        push({
          type: 'click-navigation',
          clickId: e.clickId,
          from: e.from,
          to: e.to,
          text: e.clicked?.text || '',
          selector: e.clicked?.selector || null,
          delayMs: e.delayMs,
          classification: 'navigated',
          method: e.method || e.navigationType || null
        });
      } else if (e.type === 'automatic-navigation') {
        push({
          type: 'automatic-navigation',
          from: e.from,
          to: e.to,
          delayMs: null,
          classification: 'automatic-navigation',
          method: e.method || null
        });
      } else if (e.type === 'click-outcome' && e.classification !== 'navigated' && e.classification !== 'popup-new-tab') {
        push({
          type: 'click-outcome',
          clickId: e.clickId,
          from: e.from,
          to: e.to,
          text: e.clicked?.text || '',
          selector: e.clicked?.selector || null,
          delayMs: e.delayMs,
          classification: e.classification,
          method: e.method || null
        });
      }
    }

    return chain.slice(-limit);
  }


  function exportChainText() {
    const chain = buildChain(100);
    const lines = [
      'Universal Page Flight Recorder v2.12 — Canonical Click Chain',
      `Session: ${state.sessionId}`,
      ''
    ];

    for (const item of chain) {
      const label = item.text
        ? item.text.replace(/\\s+/g, ' ').trim().slice(0, 80)
        : item.selector || `click #${item.clickId}`;

      if (item.type === 'click-navigation') {
        lines.push(
          `CLICK #${item.clickId} [${label}]`,
          `  ${item.from}`,
          `  -> ${item.to}`,
          `  ${item.delayMs}ms | CLICK-CAUSED NAVIGATION | ${item.method || 'navigation'}`
        );
      } else if (item.type === 'automatic-navigation') {
        lines.push(
          `AUTOMATIC NAVIGATION`,
          `  ${item.from}`,
          `  -> ${item.to}`,
          `  ${item.method || 'navigation'}`
        );
      } else {
        lines.push(
          `CLICK #${item.clickId} [${label}]`,
          `  ${item.from}`,
          `  -> ${item.to || '(same page)'}`,
          `  ${item.delayMs}ms | ${item.classification}`
        );
      }

      lines.push('');
    }

    const blob = new Blob([lines.join('\n')], {type: 'text/plain;charset=utf-8'});
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `page-flight-${state.sessionId}-chain.txt`;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  }

  function updatePanel() {
    const panelHost = document.getElementById('__PFR21_HOST__');
    const root = panelHost?.shadowRoot;
    const panel = root?.getElementById('__PFR21_PANEL__');
    if (!panel) return;

    const status = panel.querySelector('#__PFR21_STATUS__');
    const stats = panel.querySelector('#__PFR21_STATS__');
    const url = panel.querySelector('#__PFR21_URL__');

    if (status) {
      status.textContent = state.running
        ? '● RECORDING'
        : '■ STOPPED';

      status.style.color = state.running
        ? '#5cff75'
        : '#ff6b6b';
    }

    if (stats) {
      stats.textContent =
`Pages:       ${state.pageCount}
Events:      ${state.eventCount}
Clicks:      ${state.clickCount}
Redirects:   ${state.redirectCount}
Mutations:   ${state.mutationCount}
Resources:   ${state.resourceCount}
Snapshots:   ${state.snapshotCount}
Navigations: ${state.navigationCount}
Ignored recorder mutations: ${state.telemetry?.ignoredRecorderMutations || 0}
Outcomes:
  Navigated:     ${state.clickOutcomes?.navigated || 0}
  No navigation: ${state.clickOutcomes?.noNavigation || 0}
  Same-page:     ${state.clickOutcomes?.samePageDomChange || 0}
  Popup/new tab: ${state.clickOutcomes?.popupNewTab || 0}
  Pending:       ${state.clickOutcomes?.navigationPending || 0}`;
    }

    if (url) {
      url.textContent = (state.lastUrl || location.href) + (state.lastRedirect ? `\n\nLAST REDIRECT #${state.lastRedirect.clickId}: ${state.lastRedirect.from} → ${state.lastRedirect.to}` : '');
    }
  }

  function resolvePendingAtExport() {
    clearExpiredPendingClick(PENDING_CLICK_MAX_AGE_MS);
    const list = pendingClicks();
    if (!list.length) return;

    for (const p of list) {
      if (p.popupOpened) {
        finishClickOutcome(p, 'popup-new-tab', {method:'window.open', navigationType:'popup'});
      } else if (p.samePageDomChanged || p.historyChanged) {
        finishClickOutcome(p, 'same-page-dom-change', {method:p.historyChanged ? 'same-page-history' : 'same-page-dom'});
      } else {
        finishClickOutcome(p, 'no-navigation', {method:null, navigationType:null});
      }
    }
    pendingClicks([]);
  }

  function exportRecording(stopAfter) {
    resolvePendingAtExport();
    flush();

    /*
     * Flush is normally synchronous with GM_setValue, but give it one
     * browser turn so the latest batch is persisted before reading it.
     */
    setTimeout(() => {
      const allEvents = loadEvents();

      const exportObject = {
        recorder: {
          name: 'Universal Page Flight Recorder',
          version: VERSION,
          features: ['causal-navigation-v2.12','correlated-navigation','canonical-click-events','recorder-isolation','clean-recorder-telemetry']
        },

        session: {
          id: state.sessionId,
          startedAt: state.startedAt,
          exportedAt: new Date().toISOString(),
          stopped: !!stopAfter
        },

        summary: {
          pages: state.pageCount,
          events: state.eventCount,
          clicks: state.clickCount,
          mutations: state.mutationCount,
          resources: state.resourceCount,
          snapshots: state.snapshotCount,
          navigations: state.navigationCount,
          redirects: state.redirectCount,
          uniqueUrls: state.urls.length,
          uniqueDomains: state.domains.length,
          clickOutcomes: state.clickOutcomes,
          navigationStats: state.navigationStats,
          telemetry: state.telemetry,
        },

        clickChain: buildChain(200),
        navigationChain: state.navigationChain || [],
        urls: state.urls,
        domains: state.domains,
        events: allEvents
      };

      const blob = new Blob(
        [JSON.stringify(exportObject, null, 2)],
        {type: 'application/json'}
      );

      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');

      a.href = objectUrl;
      a.download =
        `page-flight-${state.sessionId}-${stopAfter ? 'final' : 'backup'}.json`;

      document.documentElement.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);

      if (stopAfter) {
        state.running = false;
        saveState();

        const panelHost = document.getElementById('__PFR21_HOST__');
        const root = panelHost?.shadowRoot;

        const status = root?.getElementById('__PFR21_STATUS__');

        if (status) {
          status.textContent = '■ STOPPED — FINAL EXPORT';
          status.style.color = '#ff6b6b';
        }

        const stopButton = root?.getElementById('__PFR21_STOP__');

        if (stopButton) stopButton.disabled = true;
      }
    }, 100);
  }

  /*
   * Boot.
   */
  const previousDocumentUrl = state.lastUrl || null;
  correlateNewDocument(previousDocumentUrl);
  rememberUrl(location.href);

  record('document-start', {
    title: document.title,
    readyState: document.readyState,
    pageUrl: location.href,
    sessionContinued: state.pageCount > 0
  });

  ensureV26State();
  installNavigationHooks();
  installPopupHook();
  installClickHooks();
  installInputHooks();
  installMutationObserver();
  installResourceObserver();
  installErrorHooks();
  installStateSampler();
  installDocumentEvents();

  /*
   * The panel must appear as soon as there is a usable DOM, and then be
   * recreated by the userscript after every normal navigation.
   */
  const bootPanel = () => {
    createPanel();
    updatePanel();
  };

  if (document.body) {
    bootPanel();
  } else {
    addEventListener('DOMContentLoaded', bootPanel, {once: true});
  }

  /*
   * Persist the session immediately so the next page knows this is the
   * same recording.
   */
  saveState();
})();
