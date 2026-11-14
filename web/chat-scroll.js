// Keep reading intent independent of layout changes and delayed image sizing.
window.ChatScroll = (() => {
  const states = new WeakMap();
  function attach(log, latest) {
    if (states.has(log)) return states.get(log);
    const shell = document.createElement('div'); shell.className = 'chat-scroll-shell';
    log.before(shell); shell.append(log);
    const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'chat-jump'; jump.hidden = true;
    jump.setAttribute('aria-live', 'polite'); shell.append(jump);
    const s = { following: true, page: undefined, tail: null, pending: false, rows: [], anchor: null, request: 0 };
    let interacting = false, expiry = 0, pointer = false, touchY = null, frame = 0;
    const nearBottom = () => log.scrollHeight - log.clientHeight - log.scrollTop <= 48;
    function label() { jump.hidden = s.following && !s.page; jump.textContent = s.pending ? '新消息 ↓' : s.page ? '最新 ↓' : '到底部 ↓'; jump.setAttribute('aria-label',s.pending?'有新消息，回到底部':'回到最新消息'); }
    function anchor() {
      const top = log.getBoundingClientRect().top;
      const row = [...log.querySelectorAll('[data-message-id]')].find(n => n.getBoundingClientRect().bottom > top + 1);
      return row ? { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top, top: log.scrollTop } : { top: log.scrollTop };
    }
    function settle() {
      if (!log.isConnected) { observer.disconnect(); return; }
      if (s.following && !s.page && !interacting) log.scrollTop = log.scrollHeight;
      else if (!interacting && s.anchor) {
        const row = [...log.querySelectorAll('[data-message-id]')].find(n => n.dataset.messageId === s.anchor.id);
        log.scrollTop = row ? log.scrollTop + row.getBoundingClientRect().top - log.getBoundingClientRect().top - s.anchor.offset : s.anchor.top;
      }
      label();
    }
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(settle); });
    function end() { interacting = false; if (!s.page && nearBottom()) { s.following = true; s.pending = false; } s.anchor = anchor(); label(); }
    function input(away = false) { interacting = true; clearTimeout(expiry); expiry = setTimeout(() => { if (!pointer) end(); }, 1200); if (away) s.following = false; }
    log.addEventListener('wheel', e => input(e.deltaY < 0), { passive: true });
    log.addEventListener('pointerdown', () => { pointer = true; input(); document.addEventListener('pointerup', () => { pointer = false; input(); }, { once: true }); });
    log.addEventListener('pointerup', () => { pointer = false; input(); });
    log.addEventListener('pointercancel', () => { pointer = false; input(); });
    log.addEventListener('touchstart', e => { touchY = e.touches[0]?.clientY; input(); }, { passive: true });
    log.addEventListener('touchmove', e => { const y = e.touches[0]?.clientY; input(y > touchY); touchY = y; }, { passive: true });
    log.addEventListener('keydown', e => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) input(['ArrowUp', 'PageUp', 'Home'].includes(e.key)); });
    log.addEventListener('scroll', () => {
      if (!interacting) return;
      s.following = !s.page && nearBottom(); if (s.following) s.pending = false;
      s.anchor = anchor(); label(); input();
    }, { passive: true });
    log.addEventListener('scrollend', () => { if (interacting && !pointer) end(); });
    log.tabIndex = 0; log.setAttribute('aria-label', '聊天消息');
    s.follow = () => { interacting = false; pointer = false; clearTimeout(expiry); s.following = true; s.pending = false; s.anchor = null; };
    jump.onclick = async () => { jump.disabled = true; try { s.follow(); await latest(); } finally { jump.disabled = false; } };
    s.render = (rows, page, render) => {
      page ||= null;
      const changedPage = s.page !== page, tail = rows.at(-1)?.id || null;
      if (changedPage) { s.rows = []; s.following = !page; s.pending = false; s.anchor = null; interacting = false; }
      else if (!s.following) { s.anchor = anchor(); if (!page && s.tail && tail && tail !== s.tail) s.pending = true; }
      // A polling window must not evict the message the reader is looking at.
      if (!page && !s.following) {
        const merged = new Map(s.rows.map(m => [m.id, m])); for (const row of rows) merged.set(row.id, row);
        s.rows = [...merged.values()].slice(0, 300);
      } else s.rows = rows;
      s.page = page; s.tail = tail;
      observer.disconnect(); render(s.rows); observer.observe(log);
      for (const child of log.children) observer.observe(child);
      if (changedPage && page) log.scrollTop = 0;
      settle(); cancelAnimationFrame(frame); frame = requestAnimationFrame(settle);
    };
    states.set(log, s); return s;
  }
  return { attach };
})();
