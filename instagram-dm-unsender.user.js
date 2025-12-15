// ==UserScript==
// @name SSSSSSSSSSSSSSS
// @icon https://www.instagram.com/favicon.ico
// @match https://*.instagram.com/*
// @run-at document-idle
// ==/UserScript==
(function () {
  'use strict';
  // Configuration
  const TIMEOUT_MS = 10000; // Max time to wait for any UI step (icon/menu/dialog/removal)
  const MIN_ACTION_DELAY_MS = 100; // Minimum delay between each UI action
  // Selectors
  const conversationSelector = 'div[aria-label^="Messages in conversation with"]';
  const messageRowSelector = 'div[role="row"]:has(div[role="gridcell"])';
  const likeBubbleSelector = 'div[role="button"][aria-label="Double tap to like"]';
  const moreSvgSelector = 'svg[aria-label^="More options"]'; // Generalized for both sent and received
  let lastUrl = window.location.href;
  let isActive = false;
  let abortController = null;
  let removeInteractionBlockers = null;
  let scrollState = null;
  let cleanupFns = [];
  let totalProcessed = 0;
  const last = (arr) => arr[arr.length - 1];
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const actionPause = () => sleep(MIN_ACTION_DELAY_MS);
  const withAbort = (promise, signal, label = 'operation') =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error(`Aborted: ${label}`));
      const onAbort = () => reject(new Error(`Aborted: ${label}`));
      signal?.addEventListener('abort', onAbort, { once: true });
      promise.then(
        v => { signal?.removeEventListener('abort', onAbort); resolve(v); },
        e => { signal?.removeEventListener('abort', onAbort); reject(e); }
      );
    });
  const withTimeoutAbort = (promise, ms, signal, label) =>
    Promise.race([
      withAbort(promise, signal, label),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout waiting for ${label}`)), ms))
    ]);
  function waitForSelector(selector, { root = document, signal, label = selector } = {}) {
    const found = root.querySelector(selector);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error(`Aborted: ${label}`));
      const obs = new MutationObserver(() => {
        const el = root.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(root, { childList: true, subtree: true });
      const onAbort = () => { obs.disconnect(); reject(new Error(`Aborted: ${label}`)); };
      signal?.addEventListener('abort', onAbort, { once: true });
      cleanupFns.push(() => { try { obs.disconnect(); } catch {} signal?.removeEventListener?.('abort', onAbort); });
    });
  }
  function waitForMatch({ root = document, match, signal, label = 'match' } = {}) {
    const scan = (node) => {
      if (node instanceof Element && match(node)) return node;
      if (!(node instanceof Element) || !node.querySelectorAll) return null;
      for (const el of node.querySelectorAll('*')) if (match(el)) return el;
      return null;
    };
    const now = scan(root);
    if (now) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error(`Aborted: ${label}`));
      const obs = new MutationObserver((muts) => {
        for (const mut of muts) {
          for (const n of mut.addedNodes) {
            const hit = scan(n);
            if (hit) { obs.disconnect(); resolve(hit); return; }
          }
        }
      });
      obs.observe(root, { childList: true, subtree: true });
      const onAbort = () => { obs.disconnect(); reject(new Error(`Aborted: ${label}`)); };
      signal?.addEventListener('abort', onAbort, { once: true });
      cleanupFns.push(() => { try { obs.disconnect(); } catch {} signal?.removeEventListener?.('abort', onAbort); });
    });
  }
  function waitForRemoval(node, { root = document, signal, label = 'removal' } = {}) {
    if (!node || !node.isConnected) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error(`Aborted: ${label}`));
      const obs = new MutationObserver(() => {
        if (!node.isConnected) { obs.disconnect(); resolve(true); }
      });
      obs.observe(root, { childList: true, subtree: true });
      const onAbort = () => { obs.disconnect(); reject(new Error(`Aborted: ${label}`)); };
      signal?.addEventListener('abort', onAbort, { once: true });
      cleanupFns.push(() => { try { obs.disconnect(); } catch {} signal?.removeEventListener?.('abort', onAbort); });
    });
  }
  const getConversationRoot = () =>
    document.querySelector(conversationSelector) || document.body;
  const getRows = () =>
    Array.from(document.querySelectorAll(messageRowSelector))
      .filter(el => el.offsetParent !== null);
  function getScrollableAncestor(el, max = 10) {
    let cur = el;
    for (let i = 0; i < max && cur; i++) {
      cur = cur.parentElement;
      if (!cur) break;
      const cs = getComputedStyle(cur);
      const oy = cs.overflowY;
      const scrollable = (oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight + 1;
      if (scrollable) return cur;
    }
    const root = getConversationRoot();
    const cs = root ? getComputedStyle(root) : null;
    if (root && cs && (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && root.scrollHeight > root.clientHeight + 1) {
      return root;
    }
    return document.scrollingElement || document.documentElement;
  }
  function viewProfileState() {
    const root = getConversationRoot();
    const link = Array.from(root.querySelectorAll('a')).find(a => (a.textContent || '').trim() === 'View profile');
    if (!link) return { found: false, visible: false };
    const rect = link.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const visible = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    return { found: true, visible, el: link };
  }
  function scrollRowIntoView(scroller, row, block = 'top', pad = 12) {
    const sRect = scroller.getBoundingClientRect();
    const rRect = row.getBoundingClientRect();
    let delta;
    if (block === 'top') {
      delta = (rRect.top - sRect.top) - pad;
    } else {
      delta = (rRect.bottom - sRect.bottom) + pad;
    }
    const before = scroller.scrollTop;
    scroller.scrollTop += delta;
    return scroller.scrollTop !== before;
  }
  const freezeScroll = () => {
    const body = document.body;
    const html = document.documentElement;
    const y = window.scrollY || html.scrollTop || body.scrollTop || 0;
    const x = window.scrollX || html.scrollLeft || body.scrollLeft || 0;
    scrollState = { x, y, styles: {
      position: body.style.position,
      width: body.style.width,
      overflow: body.style.overflow,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right
    }};
    body.style.position = 'fixed';
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    body.style.top = `-${y}px`;
    body.style.left = `-${x}px`;
    body.style.right = '0';
  };
  const unfreezeScroll = () => {
    const body = document.body;
    if (!scrollState) return;
    const { x, y, styles } = scrollState;
    body.style.position = styles.position;
    body.style.width = styles.width;
    body.style.overflow = styles.overflow;
    body.style.top = styles.top;
    body.style.left = styles.left;
    body.style.right = styles.right;
    scrollState = null;
    window.scrollTo(x, y);
  };
  const addInteractionBlockers = () => {
    const BLOCKED_EVENTS = [
      'click','dblclick','auxclick','contextmenu',
      'mousedown','mouseup','pointerdown','pointerup','pointermove',
      'touchstart','touchmove','touchend','wheel',
      'dragstart','selectstart','keydown','keyup'
    ];
    const handler = (e) => {
      if (!e.isTrusted) return;
      const target = e.target;
      const insidePanel = target && typeof target.closest === 'function'
        ? target.closest('#processControlPanel')
        : null;
      if (insidePanel) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return false;
    };
    const registrations = [];
    for (const evt of BLOCKED_EVENTS) {
      const opts = { capture: true, passive: false };
      window.addEventListener(evt, handler, opts);
      document.addEventListener(evt, handler, opts);
      registrations.push({ evt, handler, opts });
    }
    return () => {
      for (const { evt, handler, opts } of registrations) {
        window.removeEventListener(evt, handler, opts);
        document.removeEventListener(evt, handler, opts);
      }
    };
  };
  const setStatus = (text) => {
    const el = document.getElementById('processStatusBar');
    if (el) el.textContent = text;
  };
  const startProcess = (type) => {
    if (isActive) return;
    isActive = true;
    totalProcessed = 0;
    abortController = new AbortController();
    console.log(`[DM Processor] Starting ${type} run.`);
    const unsendBtn = document.getElementById('unsendBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    if (unsendBtn) unsendBtn.style.display = 'none';
    if (deleteBtn) deleteBtn.style.display = 'none';
    const overlay = document.createElement('div');
    overlay.id = 'processOverlay';
    overlay.style.cssText = [
      'position: fixed',
      'top: 0','left: 0','width: 100vw','height: 100vh',
      'background-color: rgba(0, 0, 0, 0.2)',
      'z-index: 2147483646',
      'pointer-events: auto',
      'cursor: not-allowed'
    ].join(';');
    const stopEvent = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    ['pointerdown','pointerup','pointermove','mousedown','mouseup','click','contextmenu','touchstart','touchmove','touchend','wheel','dragstart']
      .forEach(evt => overlay.addEventListener(evt, stopEvent, true));
    document.body.appendChild(overlay);
    const controlPanel = document.createElement('div');
    controlPanel.id = 'processControlPanel';
    controlPanel.style.cssText = [
      'position: fixed','top: 15px','right: 15px',
      'z-index: 2147483647',
      'display: flex','align-items: center','gap: 8px',
      'background: white','padding: 8px 12px',
      'border-radius: 8px','box-shadow: 0 2px 10px rgba(0,0,0,0.2)'
    ].join(';');
    controlPanel.innerHTML = `
      <div id="processStatusBar" style="color: #8e8e8e; font-size: 12px; font-weight: bold; white-space: nowrap; background-color: #efefef; padding: 4px 8px; border-radius: 6px;">
        Interaction Blocked
      </div>
      <button id="cancelProcessBtn" style="background-color: #dbdbdb; color: black; border: none; border-radius: 8px; padding: 6px 12px; font-weight: bold; cursor: pointer;">Cancel</button>
    `;
    document.body.appendChild(controlPanel);
    document.getElementById('cancelProcessBtn').onclick = stopProcess;
    removeInteractionBlockers = addInteractionBlockers();
    freezeScroll();
    const runFn = type === 'unsend' ? runUnsendAll : runDeleteAll;
    runFn(abortController.signal)
      .then(() => { if (!isActive) return; stopProcess(); })
      .catch((e) => { console.error(`[DM Processor] Error during ${type} run:`, e); stopProcess(); });
  };
  const stopProcess = () => {
    if (!isActive && !document.getElementById('processOverlay')) return;
    console.log('[DM Processor] Stopping.');
    isActive = false;
    try { abortController?.abort(); } catch {}
    abortController = null;
    try { removeInteractionBlockers?.(); } catch {}
    removeInteractionBlockers = null;
    try { cleanupFns.forEach(fn => fn()); } catch {}
    cleanupFns = [];
    unfreezeScroll();
    document.getElementById('processOverlay')?.remove();
    document.getElementById('processControlPanel')?.remove();
    const unsendBtn = document.getElementById('unsendBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    if (unsendBtn) unsendBtn.style.display = 'inline-block';
    if (deleteBtn) deleteBtn.style.display = 'inline-block';
  };
  const injectButtons = (targetNode, insertionPoint) => {
    if (document.getElementById('unsendBtn') && document.getElementById('deleteBtn')) return;
    const unsendBtn = document.createElement('button');
    unsendBtn.textContent = 'Unsend My All';
    unsendBtn.id = 'unsendBtn';
    unsendBtn.style.cssText = 'background-color: #0095f6; color: white; border: none; border-radius: 8px; padding: 6px 12px; font-weight: bold; cursor: pointer; margin-left: auto;';
    unsendBtn.onclick = () => startProcess('unsend');
    targetNode.insertBefore(unsendBtn, insertionPoint);
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete Others All';
    deleteBtn.id = 'deleteBtn';
    deleteBtn.style.cssText = 'background-color: #ef4444; color: white; border: none; border-radius: 8px; padding: 6px 12px; font-weight: bold; cursor: pointer; margin-left: 8px; margin-right: 12px;';
    deleteBtn.onclick = () => startProcess('delete');
    targetNode.insertBefore(deleteBtn, insertionPoint);
  };
  const onUrlChange = () => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      if (isActive) {
        console.warn('[DM Processor] URL changed during run. Stopping.');
        stopProcess();
      }
    }
    const isDmThreadPage = window.location.pathname.startsWith('/direct/t/');
    if (isDmThreadPage) {
      const iconContainer = document.querySelector('svg[aria-label="Conversation information"]')?.closest('div[role="button"]');
      if (iconContainer?.parentElement?.parentElement) {
        const headerBar = iconContainer.parentElement.parentElement;
        if (headerBar.querySelector('a[aria-label^="Open the profile page of"]')) {
          injectButtons(headerBar, iconContainer.parentElement);
        }
      }
    } else {
      document.getElementById('unsendBtn')?.remove();
      document.getElementById('deleteBtn')?.remove();
    }
  };
  async function runUnsendAll(signal) {
    setStatus('Unsending...');
    const conversationDiv = await withTimeoutAbort(
      waitForSelector(conversationSelector, { root: document, signal, label: 'conversation container' }),
      TIMEOUT_MS, signal, 'conversation container'
    );
    const firstRow = getRows()[0];
    if (firstRow) {
      const scrollerAtStart = getScrollableAncestor(firstRow);
      scrollerAtStart.scrollTop = scrollerAtStart.scrollHeight;
    }
    await sleep(800);
    let newMessagesResolver = null;
    const waitForNewMessages = (timeoutMs = 60000) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted: wait new messages'));
      if (newMessagesResolver) {
        const check = () => { if (!newMessagesResolver) resolve(); else setTimeout(check, 50); };
        check(); return;
      }
      let timedOut = false;
      const to = setTimeout(() => {
        timedOut = true;
        newMessagesResolver = null;
        reject(new Error('Timeout waiting for new messages'));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(to);
        newMessagesResolver = null;
        reject(new Error('Aborted: wait new messages'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      newMessagesResolver = () => {
        if (timedOut) return;
        clearTimeout(to);
        signal?.removeEventListener('abort', onAbort);
        newMessagesResolver = null;
        resolve();
      };
    });
    const obsTarget = getConversationRoot();
    const convObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          if (newMessagesResolver) newMessagesResolver();
          return;
        }
      }
    });
    convObserver.observe(obsTarget, { childList: true, subtree: true });
    cleanupFns.push(() => { try { convObserver.disconnect(); } catch {} });
    async function processRow(row, menuItemText, confirmText) {
      if (signal?.aborted) throw new Error('Aborted: process row');
      const scroller = getScrollableAncestor(row);
      try { scrollRowIntoView(scroller, row, 'top', 16); } catch {}
      await actionPause();
      const hoverTarget = row.querySelector(likeBubbleSelector) || row;
      hoverTarget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      await actionPause();
      const moreIcon = row.querySelector(moreSvgSelector) ||
        await withTimeoutAbort(
          waitForSelector(moreSvgSelector, { root: conversationDiv, signal, label: 'more options icon' }),
          TIMEOUT_MS, signal, 'more options icon'
        );
      await actionPause();
      const moreBtn = moreIcon.closest('div[role="button"]') || moreIcon;
      moreBtn.click();
      await actionPause();
      const menuItem = await withTimeoutAbort(
        waitForMatch({
          root: document.body,
          signal,
          label: `${menuItemText} menu item`,
          match: n => n.tagName === 'SPAN' && n.textContent.trim() === menuItemText && !!n.closest('div[role="dialog"]')
        }),
        TIMEOUT_MS, signal, `${menuItemText} menu item`
      );
      (menuItem.closest('div[role="button"]') || menuItem).click();
      await actionPause();
      const confirmBtn = await withTimeoutAbort(
        waitForMatch({
          root: document.body,
          signal,
          label: `${confirmText} confirm button`,
          match: n => n.tagName === 'BUTTON' && n.textContent.trim() === confirmText
        }),
        TIMEOUT_MS, signal, `${confirmText} confirm button`
      );
      confirmBtn.click();
      await actionPause();
      await withTimeoutAbort(
        waitForRemoval(row, { root: conversationDiv, signal, label: 'message row removal' }),
        TIMEOUT_MS, signal, 'message removal'
      );
      await actionPause();
    }
    function messageRows(convRoot, isOwn) {
      const rows = [...convRoot.querySelectorAll(messageRowSelector)]
        .filter(el => el.offsetParent !== null);
      return rows.filter(row => {
        const bubble = row.querySelector(likeBubbleSelector);
        if (!bubble) return false;
        if (row.innerText.includes('Unsupported message')) return false;
        const profileLink = row.querySelector('a[aria-label^="Open the profile page of"]');
        return isOwn ? !profileLink : !!profileLink;
      });
    }
    async function drainLoaded(convDiv, isOwn, menuItemText, confirmText) {
      let count = 0;
      while (!signal?.aborted) {
        const rows = messageRows(convDiv, isOwn);
        const row = last(rows);
        if (!row) break;
        try {
          await processRow(row, menuItemText, confirmText);
          count++;
          totalProcessed++;
          setStatus(`${isOwn ? 'Unsending' : 'Deleting'}... (${totalProcessed})`);
        } catch (e) {
          console.error('[DM Processor] Error processing row:', e);
          if (/No eligible/.test(String(e?.message))) break;
          throw e;
        }
      }
      return count;
    }
    async function stepScrollUp() {
      const state = viewProfileState();
      if (state.found && state.visible) return false;
      let rows = getRows();
      if (!rows.length) {
        try { await waitForNewMessages(60000); } catch { /* retry next loop */ }
        return true;
      }
      const scroller = getScrollableAncestor(rows[0]);
      const sRect = scroller.getBoundingClientRect();
      let firstVis = rows.findIndex(r => {
        const rr = r.getBoundingClientRect();
        return rr.bottom > sRect.top + 1 && rr.top < sRect.bottom - 1;
      });
      if (firstVis === -1) firstVis = rows.length - 1;
      const prevIdx = Math.max(0, firstVis - 1);
      const prevRow = rows[prevIdx];
      let moved = scrollRowIntoView(scroller, prevRow, 'top', 16);
      if (!moved) {
        const before = scroller.scrollTop;
        scroller.scrollBy(0, -Math.max(80, Math.floor(scroller.clientHeight * 0.7)));
        moved = scroller.scrollTop !== before;
      }
      if (!moved && scroller.scrollTop <= 1 && !(state.found && state.visible)) {
        try { await waitForNewMessages(60000); } catch {}
      } else {
        await sleep(250);
      }
      return true;
    }
    while (!signal?.aborted) {
      const removed = await drainLoaded(conversationDiv, true, 'Unsend', 'Unsend');
      if (removed > 0) console.log(`[DM Processor] Unsent ${removed} message(s) this pass (total: ${totalProcessed}).`);
      const profileState = viewProfileState();
      if (profileState.found && profileState.visible && messageRows(conversationDiv, true).length === 0) {
        console.log('[DM Processor] Reached top and no more eligible messages. Done.');
        break;
      }
      const cont = await stepScrollUp();
      if (!cont) break;
    }
    if (signal?.aborted) throw new Error('Aborted: run');
  }
  async function runDeleteAll(signal) {
    setStatus('Deleting...');
    const conversationDiv = await withTimeoutAbort(
      waitForSelector(conversationSelector, { root: document, signal, label: 'conversation container' }),
      TIMEOUT_MS, signal, 'conversation container'
    );
    const firstRow = getRows()[0];
    if (firstRow) {
      const scrollerAtStart = getScrollableAncestor(firstRow);
      scrollerAtStart.scrollTop = scrollerAtStart.scrollHeight;
    }
    await sleep(800);
    let newMessagesResolver = null;
    const waitForNewMessages = (timeoutMs = 60000) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted: wait new messages'));
      if (newMessagesResolver) {
        const check = () => { if (!newMessagesResolver) resolve(); else setTimeout(check, 50); };
        check(); return;
      }
      let timedOut = false;
      const to = setTimeout(() => {
        timedOut = true;
        newMessagesResolver = null;
        reject(new Error('Timeout waiting for new messages'));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(to);
        newMessagesResolver = null;
        reject(new Error('Aborted: wait new messages'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      newMessagesResolver = () => {
        if (timedOut) return;
        clearTimeout(to);
        signal?.removeEventListener('abort', onAbort);
        newMessagesResolver = null;
        resolve();
      };
    });
    const obsTarget = getConversationRoot();
    const convObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          if (newMessagesResolver) newMessagesResolver();
          return;
        }
      }
    });
    convObserver.observe(obsTarget, { childList: true, subtree: true });
    cleanupFns.push(() => { try { convObserver.disconnect(); } catch {} });
    // The processRow and messageRows functions are shared, but with parameters
    // For delete, use isOwn = false, menuItemText = 'Delete', confirmText = 'Delete'
    while (!signal?.aborted) {
      const removed = await drainLoaded(conversationDiv, false, 'Delete', 'Delete');
      if (removed > 0) console.log(`[DM Processor] Deleted ${removed} message(s) this pass (total: ${totalProcessed}).`);
      const profileState = viewProfileState();
      if (profileState.found && profileState.visible && messageRows(conversationDiv, false).length === 0) {
        console.log('[DM Processor] Reached top and no more eligible messages. Done.');
        break;
      }
      const cont = await stepScrollUp();
      if (!cont) break;
    }
    if (signal?.aborted) throw new Error('Aborted: run');
  }
  console.log('Instagram DM Processor active.');
  new MutationObserver(onUrlChange).observe(document.body, { childList: true, subtree: true });
  onUrlChange();
})();
