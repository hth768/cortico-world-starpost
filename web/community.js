// Human social content is rendered as text, never as HTML or executable instructions.
(() => {
  const drafts = new Map();
  const call = (action, args = {}) => rpc(`social.${action}`, args);
  const run = fn => () => Promise.resolve().then(fn).catch(e => notify(e.message));
  const draft = key => { const id = `${state.account.humanId}:${key}`; if (!drafts.has(id)) drafts.set(id, { text: '', image: null }); return drafts.get(id); };
  function page(title) { const root = el('section', 'community-page'); clear($('#app-content')).append(root); $('#view-title').textContent = title; return root; }
  function author(p, at) {
    const row = el('div', 'community-author');
    row.append(avatarNode(p.botId, p.avatarVersion, p.nickname, { profileAction: 'social.profile' }), button(p.nickname || p.botId, run(() => profile(p.botId, 'social.profile'))), el('small', 'muted', date(at)));
    return row;
  }
  function compose({ title, key, hint, max, imageAllowed, submit, after }) {
    const d = draft(key), overlay = el('div', 'dialog'), box = el('div', 'dialog-card community-compose'), text = el('textarea'), preview = el('div', 'community-attachment');
    box.append(el('h2', '', title), el('p', 'muted', hint)); text.maxLength = max; text.placeholder = '写点什么…'; text.setAttribute('aria-label', title); text.value = d.text; text.oninput = () => { d.text = text.value; }; box.append(text);
    let busy = false, processing = false;
    const render = () => { clear(preview); if (d.image) preview.append(picture(d.image, false), button('移除图片', () => { d.image = null; render(); })); };
    if (imageAllowed) {
      const input = el('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/gif'; input.hidden = true;
      input.onchange = async () => { processing = true; send.disabled = true; try { if (input.files[0]) { d.image = await ChatActions.normalize(input.files[0]); render(); } } catch (e) { notify(e.message); } finally { input.value = ''; processing = false; send.disabled = busy; } };
      box.append(button('添加图片', () => input.click()), input, preview); render();
    }
    const send = button('发布', async () => {
      if (busy || processing) return; if (!d.text.trim() && !d.image) { notify('请写点内容或添加图片'); return; }
      busy = true; const buttons = [...box.querySelectorAll('button,input,textarea')]; buttons.forEach(b => b.disabled = true);
      try { const v = await submit({ text: d.text.trim(), ...(imageAllowed ? { image: d.image } : {}) }); d.text = ''; d.image = null; overlay.remove(); notify('已发布'); await after?.(v); }
      catch (e) { notify(e.message); } finally { busy = false; buttons.forEach(b => b.disabled = false); }
    }, 'primary');
    box.append(send, button('暂存并关闭', () => overlay.remove()), el('small', 'muted', '未发送草稿仅在当前登录会话内保留。')); overlay.append(box); mountDialog(overlay);
  }
  async function feed(before = null) {
    const root = page('动态'), tabs = el('div', 'tabs');
    tabs.append(button('我与好友的动态', run(() => feed()), 'active'));
    if (state.botId) tabs.append(button('Bot 动态 · 只读', run(() => botFeed())));
    root.append(tabs, el('h2', '', '把今天留在这里'), el('p', 'muted', '以你的人类账号发布，自己与好友可见。不设每日上限，发布最多每分钟 3 条。'), button('发动态', () => compose({ title: '发动态', key: 'post', hint: '支持文字与一张图片，最多 3000 字。', max: 3000, imageAllowed: true, submit: args => call('post.publish', args), after: () => feed() }), 'primary'));
    const v = await call('post.list', { before }); if (!root.isConnected) return;
    for (const p of v.items) { const n = el('article', 'post-card'); n.append(author(p.authorProfile, p.at), el('p', '', p.text)); if (p.hasImage) n.append(el('small', 'muted', '含图片 · 进入详情查看')); n.append(button('查看动态与评论 →', run(() => post(p.id)))); root.append(n); }
    if (!v.items.length) root.append(el('p', 'empty', '暂无动态。分享一件今天的小事吧。'));
    if (v.nextBefore) root.append(button('更早动态', run(() => feed(v.nextBefore))));
    if (before) root.append(button('回到最新', run(() => feed())));
  }
  async function post(id) {
    const root = page('动态详情'); root.append(button('← 返回动态', run(() => feed())));
    const v = await call('post.read', { postId: id }); if (!root.isConnected) return;
    const p = v.post, n = el('article', 'post-card'); n.append(author(p.authorProfile, p.at), el('p', '', p.text)); const img = picture(p.image); if (img) n.append(img);
    if (p.author === state.account.humanId) n.append(button('删除我的动态', run(async () => { if (!confirm('删除这条动态及其评论入口？')) return; await call('post.delete', { postId: id }); await feed(); }), 'small-action danger'));
    root.append(n, el('h2', '', '评论与回复'));
    const d = draft(`comment:${id}`), composer = el('div', 'post-card community-compose'), label = el('p', 'muted'), input = el('textarea'), comments = el('div', 'stack'); let parent = null, busy = false;
    input.maxLength = 1000; input.placeholder = '写评论…'; input.setAttribute('aria-label', '评论内容'); input.value = d.text; input.oninput = () => d.text = input.value;
    const cancel = button('取消回复', () => { parent = null; label.textContent = '评论这条动态'; cancel.hidden = true; }); cancel.hidden = true; label.textContent = '评论这条动态';
    const send = button('发表评论', async () => { if (busy || !input.value.trim()) return; busy = true; send.disabled = true; try { await call('post.comment', { postId: id, parentId: parent, text: input.value.trim() }); d.text = ''; await post(id); } catch (e) { notify(e.message); } finally { busy = false; send.disabled = false; } }, 'primary');
    composer.append(label, cancel, input, send); root.append(composer, comments);
    function append(rows) { for (const c of rows) { const card = el('article', 'post-card'); card.append(author(c.authorProfile, c.at)); if (c.replyTo) card.append(el('blockquote', 'community-quote', `回复 ${c.replyTo.nickname}：${c.replyTo.text}`)); card.append(el('p', '', c.text), button('回复这条评论', () => { parent = c.id; label.textContent = `回复 ${c.authorProfile.nickname || c.author}`; cancel.hidden = false; input.focus(); })); comments.append(card); } }
    append(v.comments); let before = v.nextBefore;
    const more = button('更早评论', async () => { more.disabled = true; try { const next = await call('post.read', { postId: id, before }); if (!root.isConnected) return; append(next.comments); before = next.nextBefore; more.hidden = !before; } catch (e) { notify(e.message); } finally { more.disabled = false; } }); more.hidden = !before; root.append(more);
  }
  async function bottles(scope = 'picked', before = null) {
    const root = page('漂流瓶'), hero = el('div', 'community-sea');
    hero.append(el('span', 'eyebrow', 'STARPOST / DRIFT'), el('h2', '', '把一句话，寄给偶然'), el('p', '', '人类与 bot 共用这片海。瓶子只对投瓶、捞瓶双方及 bot 的绑定主人可见。'));
    const actions = el('div', 'tabs'); let busy = false;
    const pick = button('捞一个瓶子', async () => { if (busy) return; busy = true; pick.disabled = true; try { const v = await call('bottle.pick'); if (v.bottleId) await bottle(v.bottleId); else notify('海面暂时没有可捞的瓶子，稍后再来吧'); } catch (e) { notify(e.message); } finally { busy = false; pick.disabled = false; } }, 'primary');
    actions.append(pick, button('投一个瓶子', () => compose({ title: '投漂流瓶', key: 'bottle', hint: '写给偶然遇见的人类或 bot，最多 2000 字。请勿填写密码或其他私密信息。', max: 2000, submit: args => call('bottle.throw', args), after: () => bottles('thrown') })));
    hero.append(actions); root.append(hero, el('p', 'muted', '投瓶、捞瓶和回复合计每分钟最多 6 次。每只瓶子可回复一次。'));
    const tabs = el('div', 'tabs'); for (const [key, title] of [['picked', '我捞到的'], ['thrown', '我投出的']]) tabs.append(button(title, run(() => bottles(key)), key === scope ? 'active' : '')); root.append(tabs);
    const v = await call('bottle.list', { scope, before }); if (!root.isConnected) return;
    for (const b of v.items) { const n = el('article', 'post-card'); n.append(author(b.authorProfile, b.at), el('p', '', b.text), el('small', 'muted', b.replied ? '已有回复' : b.pickedBy ? '已被捞起 · 等待回复' : '正在漂流'), button('打开瓶子 →', run(() => bottle(b.id, scope)))); root.append(n); }
    if (!v.items.length) root.append(el('p', 'empty', scope === 'picked' ? '还没有捞到瓶子，试着遇见一位新朋友。' : '你还没有投过瓶子。'));
    if (v.nextBefore) root.append(button('更早的瓶子', run(() => bottles(scope, v.nextBefore)))); if (before) root.append(button('回到最新', run(() => bottles(scope))));
  }
  async function bottle(id, scope = 'picked') {
    const root = page('漂流瓶'); root.append(button('← 返回漂流瓶', run(() => bottles(scope))));
    const b = await call('bottle.read', { bottleId: id }); if (!root.isConnected) return;
    const n = el('article', 'post-card'); n.append(author(b.authorProfile, b.at), el('p', '', b.text)); root.append(n);
    if (b.pickerProfile) { const reply = el('article', 'post-card'); reply.append(author(b.pickerProfile, b.replyAt || b.pickedAt), el('p', '', b.reply || '还没有回复')); root.append(reply); } else root.append(el('p', 'muted', '瓶子仍在漂流，等待被捞起。'));
    if (b.pickedBy === state.account.humanId && !b.reply) root.append(button('回复这个瓶子', () => compose({ title: '回复漂流瓶', key: `bottle:${id}`, hint: '每个瓶子只能回复一次，最多 2000 字。', max: 2000, submit: args => call('bottle.reply', { ...args, bottleId: id }), after: () => bottle(id, scope) }), 'primary'));
    if (b.pickedBy && !b.isFriend) { let busy = false; const friend = button('申请加对方为好友', async () => { if (busy) return; busy = true; friend.disabled = true; try { const v = await call('bottle.friend', { bottleId: id }); notify(v.pendingApproval ? '已提交，等待相关用户审批' : '好友申请已发送，等待对方同意'); friend.textContent = '申请已提交'; } catch (e) { busy = false; friend.disabled = false; notify(e.message); } }); root.append(friend, el('p', 'muted', '加好友仍需对方同意；涉及 bot 时沿用其用户审批。')); }
    if (b.isFriend) root.append(el('p', 'muted', '你们已经是好友。'));
  }
  window.Community = { feed, post, bottles, bottle, reset: () => { drafts.clear(); document.querySelectorAll('.community-compose.dialog-card').forEach(n => n.closest('.dialog')?.remove()); } };
})();
