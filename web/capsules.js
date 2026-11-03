// Personal letters stay sealed on the server; only an explicit read fetches content.
(() => {
  let draft = null, epoch = 0, checking = false, reminded = '';
  const run = fn => () => Promise.resolve().then(fn).catch(e => notify(e.message));
  const fullDate = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'long', timeStyle: 'short' }).format(new Date(value));
  const call = (action, args = {}) => rpc(`capsule.${action}`, args);
  function page(title) { const root = el('section', 'community-page capsule-page'); clear($('#app-content')).append(root); $('#view-title').textContent = title; return root; }
  async function list(before = null) {
    const root = page('时间胶囊'), hero = el('div', 'community-sea'); root.dataset.capsuleList = 'true'; root.dataset.before = before ?? '';
    hero.append(el('span', 'eyebrow', 'STARPOST / DEAR FUTURE ME'), el('h2', '', '把此刻，寄给未来的自己'), el('p', '', '一句期待，三张照片，留给下一次相遇。胶囊仅本人可见，到期后才能打开。'), button('写给未来的我', compose, 'primary'));
    root.append(hero);
    const v = await call('list', { before }); if (!root.isConnected) return;
    root.dataset.unread = String(v.unread); root.append(el('p', 'muted', `${v.sealed} 份封存中 · ${v.unread} 份到期未读 · ${v.total} 份胶囊`));
    for (const c of v.items) {
      const n = el('article', 'post-card');
      n.append(el('span', 'eyebrow', c.ready ? c.openedAt ? '已开启' : '等待你开启' : '封存中'), el('h3', '', `${fullDate(c.opensAt)} 开启`), el('p', 'muted', `${fullDate(c.createdAt)} 写下 · ${c.imageCount} 张图片 · 北京时间`));
      if (c.ready) n.append(button('打开时间胶囊', run(() => read(c.id)), 'primary'));
      n.append(button('删除', run(async () => { if (!confirm('永久删除这份时间胶囊？删除后无法找回。')) return; await call('delete', { capsuleId: c.id }); await list(before); }), 'small-action danger')); root.append(n);
    }
    if (!v.items.length) root.append(el('p', 'empty', '这里还没有信。给未来的自己留下一点今天吧。'));
    if (v.nextBefore) root.append(button('更早封存', run(() => list(v.nextBefore))));
    if (before) root.append(button('回到最新', run(() => list())));
  }
  async function read(id) {
    const root = page('来自过去的自己'); root.append(button('← 返回时间胶囊', run(() => list())));
    const c = await call('read', { capsuleId: id }); if (!root.isConnected) return;
    const n = el('article', 'post-card capsule-letter');
    n.append(el('span', 'eyebrow', '一封穿过时间的信'), el('h2', '', fullDate(c.createdAt)), el('p', 'muted', `约定在 ${fullDate(c.opensAt)} 开启 · 北京时间`), el('p', 'capsule-text', c.text));
    for (const image of c.images) n.append(picture(image)); root.append(n); void check(true);
  }
  function compose() {
    draft ??= { text: '', images: [], unit: 'weeks', value: '1', mode: 'relative', date: '', requestId: crypto.randomUUID() };
    const d = draft, owner = state.account?.humanId, session = epoch, overlay = el('div', 'dialog'), box = el('div', 'dialog-card community-compose capsule-compose');
    let busy = false, processing = false;
    overlay.addEventListener('keydown', e => { if (busy && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    const changed = () => { d.requestId = crypto.randomUUID(); };
    const text = el('textarea'), counter = el('small', 'muted'), previews = el('div', 'capsule-images');
    text.value = d.text; text.maxLength = 1200; text.placeholder = '未来的我，你好…'; text.setAttribute('aria-label', '时间胶囊留言');
    const count = () => { counter.textContent = `${[...text.value].length} / 600 字 · ${d.images.length} / 3 张图片`; };
    text.oninput = () => { d.text = text.value; changed(); count(); };
    box.append(el('h2', '', '写给未来的我'), el('p', 'muted', '封存后不能提前读取或修改；可以删除。图片每张最多 1 MiB，超大静态图片会压缩。'), text, counter);
    const tabs = el('div', 'tabs'), relative = el('div', 'capsule-time'), absolute = field('开启日期与时间（北京时间）', 'datetime-local');
    absolute.input.value = d.date; absolute.input.oninput = () => { d.date = absolute.input.value; changed(); };
    const amount = field('多久以后', 'number'), unit = el('select'); amount.input.min = '1'; amount.input.step = '1'; amount.input.value = d.value; unit.setAttribute('aria-label', '时长单位');
    for (const [key, title] of [['minutes','分钟'],['hours','小时'],['days','天'],['weeks','周'],['months','个月'],['years','年']]) { const o = el('option', '', title); o.value = key; unit.append(o); } unit.value = d.unit;
    amount.input.oninput = () => { d.value = amount.input.value; changed(); }; unit.onchange = () => { d.unit = unit.value; changed(); };
    relative.append(amount.wrap, unit);
    function mode(value) { if (d.mode !== value) changed(); d.mode = value; relative.hidden = value !== 'relative'; absolute.wrap.hidden = value !== 'absolute'; for (const b of tabs.children) b.classList.toggle('active', b.dataset.mode === value); }
    for (const [value, title] of [['relative','多久之后'],['absolute','指定日期']]) { const b = button(title, () => mode(value)); b.dataset.mode = value; tabs.append(b); }
    const shortcuts = el('div', 'tabs'); for (const [value, title] of [['weeks','1 周后'],['months','1 个月后'],['years','1 年后']]) shortcuts.append(button(title, () => { d.value = '1'; d.unit = value; amount.input.value = '1'; unit.value = value; changed(); mode('relative'); }));
    box.append(shortcuts, tabs, relative, absolute.wrap, el('small', 'muted', '月、年按北京时间日历计算；月末自动取目标月最后一天。'));
    const input = el('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/gif'; input.multiple = true; input.hidden = true;
    const addPhoto = button('添加图片', () => input.click());
    const render = () => { clear(previews); d.images.forEach((image, i) => { const n = el('div', 'community-attachment'); n.append(picture(image, false), button(`移除图片 ${i+1}`, () => { if (busy || processing) return; d.images.splice(i,1); changed(); render(); })); previews.append(n); }); addPhoto.disabled = d.images.length >= 3 || busy || processing; count(); };
    input.onchange = async () => {
      if (busy || processing) return;
      const files = [...input.files]; input.value = ''; if (files.length + d.images.length > 3) { notify('每份时间胶囊最多 3 张图片'); return; }
      processing = true; send.disabled = true; addPhoto.disabled = true;
      try { const images = []; for (const file of files) images.push(await ChatActions.normalize(file)); if (epoch !== session || owner !== state.account?.humanId) return; d.images.push(...images); changed(); }
      catch(e) { notify(e.message); } finally { processing = false; send.disabled = busy; render(); }
    };
    const send = button('封存时间胶囊', async () => {
      if (busy || processing) return;
      if ([...d.text].length > 600) { notify('留言不能超过 600 字'); return; }
      if (!d.text.trim() && !d.images.length) { notify('请留下文字或添加图片'); return; }
      const time = d.mode === 'absolute' ? { opensAt: `${d.date}:00+08:00` } : { afterValue: Number(d.value), afterUnit: d.unit };
      if (d.mode === 'absolute' ? !absolute.input.reportValidity() || !d.date : !amount.input.reportValidity() || !d.value) return;
      busy = true; box.querySelectorAll('button,input,textarea,select').forEach(n => n.disabled = true);
      try { const c = await call('create', { text:d.text, images:d.images, ...time, requestId:d.requestId }); if (session !== epoch) return; draft = null; overlay.remove(); notify(`已封存，${fullDate(c.opensAt)} 开启`); await list(); }
      catch(e) { notify(e.message); } finally { busy = false; box.querySelectorAll('button,input,textarea,select').forEach(n => n.disabled = false); render(); }
    }, 'primary');
    box.append(addPhoto, input, previews, send, button('暂存并关闭', () => overlay.remove()), el('small', 'muted', '未封存草稿仅在当前登录会话内保留。'));
    mode(d.mode); render(); overlay.append(box); mountDialog(overlay);
  }
  async function check(force = false) {
    if (checking || !state.account || state.account.needsEmail || humanGame.id || $('#app').classList.contains('hidden') || document.visibilityState !== 'visible') return;
    const session = epoch; checking = true;
    try { const v = await call('status'); if (session !== epoch) return; const listing = document.querySelector('[data-capsule-list]'); if (listing && listing.dataset.unread !== undefined && Number(listing.dataset.unread) !== v.unread) void list(listing.dataset.before ? Number(listing.dataset.before) : null).catch(e=>notify(e.message)); if (!v.unread) { $('#capsule-alert')?.remove(); return; } if (!force && reminded === v.latestId) return;
      reminded = v.latestId; $('#capsule-alert')?.remove(); const b = button(`有 ${v.unread} 份时间胶囊到期，点击开启 →`, run(() => navigate('capsules')), 'post-card capsule-alert'); b.id = 'capsule-alert'; $('#app-content').before(b);
    } catch { /* Keep ordinary chat usable if the relay is older or temporarily offline. */ } finally { checking = false; }
  }
  setInterval(() => void check(), 60000);
  window.Capsules = { list, check, reset: () => { epoch++; draft = null; reminded = ''; $('#capsule-alert')?.remove(); document.querySelectorAll('.capsule-compose').forEach(n => n.closest('.dialog')?.remove()); } };
})();
