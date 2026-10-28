import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface Snapshot {
  botId: string; profile: Profile; friendProfiles: Profile[]; friends: string[]; requests: Array<{ from: string }>;
  groups: Array<{ id: string; name: string; members: string[] }>;
  conversations: Array<{ kind: 'private' | 'group'; target: string; latest: { sender: string; text: string; emoji: string; hasImage: boolean; at: string } | null }>;
  posts: Array<{ id: string; author: string; text: string; image?: { mime: string; base64: string }; comments: Array<{ id: string; author: string; text: string; parentId?: string }>; at: string }>;
  bottles: Array<{ id: string; author: string; text: string; pickedBy?: string; reply?: string }>;
  square: Array<{ id: string; kind: 'bot' | 'group'; author: string; target: string; text: string; nickname?: string; bio?: string; groupName?: string; at: string }>;
}
interface Profile { botId: string; nickname: string; bio: string; discoverable: boolean }
interface ChatMessage {
  id: string; cursor: number; kind: 'private' | 'group'; target: string; sender: string; senderNickname: string;
  text: string; emoji: string; image?: { mime: string; base64: string }; mentions: string[]; at: string;
}
interface HistoryPage { messages: ChatMessage[]; nextBefore: number | null; nextAfter: number | null }
const chatCss = `
.sp-chat-layout{display:grid;grid-template-columns:minmax(210px,30%) minmax(0,1fr);min-height:540px;border:1px solid rgba(128,128,128,.22);border-radius:14px;overflow:hidden;margin-top:12px}
.sp-chat-list{display:flex;flex-direction:column;gap:4px;padding:10px;border-right:1px solid rgba(128,128,128,.22);max-height:620px;overflow:auto;background:rgba(128,128,128,.04)}
.sp-chat-card{display:block;width:100%;border:1px solid transparent;border-radius:11px;padding:10px 12px;text-align:left;background:transparent;color:inherit;cursor:pointer;font:inherit}
.sp-chat-card:hover,.sp-chat-card:focus-visible{background:rgba(90,145,225,.1)}
.sp-chat-card[aria-pressed="true"]{background:rgba(90,145,225,.18);border-color:rgba(90,145,225,.38)}
.sp-chat-title{display:block;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-chat-preview{display:block;font-size:12px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px}
.sp-chat-thread{display:flex;flex-direction:column;min-width:0;min-height:540px}
.sp-thread-head{padding:13px 16px;border-bottom:1px solid rgba(128,128,128,.2);font-weight:700}
.sp-thread-note{display:block;font-size:12px;font-weight:400;opacity:.65;margin-top:3px}
.sp-thread-scroll{flex:1;height:480px;overflow:auto;padding:16px;background:rgba(128,128,128,.035)}
.sp-older{display:block;margin:0 auto 12px}
.sp-message{display:flex;margin:0 0 14px}
.sp-message.sp-self{justify-content:flex-end}
.sp-bubble-wrap{max-width:min(78%,480px);min-width:0}
.sp-message-meta{font-size:11px;opacity:.65;margin:0 4px 4px}
.sp-self .sp-message-meta{text-align:right}
.sp-bubble{padding:9px 12px;border-radius:4px 13px 13px 13px;background:rgba(128,128,128,.14);overflow-wrap:anywhere;white-space:pre-wrap}
.sp-self .sp-bubble{border-radius:13px 4px 13px 13px;background:rgba(80,145,230,.2)}
.sp-bubble img{display:block;max-width:min(260px,100%);max-height:260px;object-fit:contain;margin-top:6px;border-radius:8px;cursor:zoom-in}
.sp-bubble img.sp-expanded{max-width:100%;max-height:none;cursor:zoom-out}
.sp-thread-foot{padding:9px 16px;border-top:1px solid rgba(128,128,128,.2);font-size:12px;opacity:.65}
@media(max-width:700px){.sp-chat-layout{grid-template-columns:1fr}.sp-chat-list{max-height:190px;border-right:0;border-bottom:1px solid rgba(128,128,128,.22)}.sp-chat-thread{min-height:420px}.sp-thread-scroll{height:380px}}
`;
const chatKey = (kind: 'private' | 'group', target: string) => `${kind}:${target}`;
const displayTime = (at: string) => at ? new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

function line(ctx: WebUiPanelContext, parent: HTMLElement, text: string) { parent.appendChild(ctx.ui.h('div', 'msgline', text)); }
function image(ctx: WebUiPanelContext, parent: HTMLElement, value?: { mime: string; base64: string }) {
  if (!value || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value.mime)
    || typeof value.base64 !== 'string' || value.base64.length > 1400000
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) return;
  const img = ctx.ui.h('img'); img.alt = '图片'; img.loading = 'lazy'; img.style.maxWidth = '240px'; img.style.maxHeight = '240px';
  img.addEventListener('click', () => {
    const expanded = img.classList.toggle('sp-expanded');
    img.style.maxWidth = expanded ? '100%' : '240px';
    img.style.maxHeight = expanded ? 'none' : '240px';
  }, { signal: ctx.signal });
  img.src = `data:${value.mime};base64,${value.base64}`; parent.appendChild(img);
}

const bundle: WebUiClientBundle = { panels: { viewer: { mount(ctx) {
  const { ui } = ctx;
  const style = ui.h('style'); style.textContent = chatCss; ctx.root.appendChild(style);
  const card = ui.sheet({ title: '星邮', en: 'Starpost' });
  const status = ui.msgline('加载中');
  const account = ui.h('div');
  const content = ui.h('div');
  card.body.append(status, account, content); ctx.root.appendChild(card.el);
  let shown: 'registered' | 'unregistered' | '' = '';
  let selected = '', before: number | null = null, snapshotData: Snapshot | null = null, historyLoading = 0, refreshBusy = false;
  const history = new Map<string, ChatMessage>();
  function showRegistration() {
    if (shown === 'unregistered') return;
    shown = 'unregistered'; account.replaceChildren(); content.replaceChildren();
    line(ctx, account, '首次使用请注册。聊天 ID 将由中转服务依次分配。');
    const code = ui.input({ placeholder: '输入服务器注册码' }); code.type = 'password'; code.autocomplete = 'off'; code.maxLength = 200;
    const result = ui.msgline('注册码由中转服务管理员提供。');
    const button = ui.button('注册', { variant: 'primary', onClick: () => {
      button.disabled = true; result.textContent = '正在注册…';
      void ctx.invoke<{ botId: string }>('register', [code.value]).then(async r => {
        code.value = ''; result.textContent = `注册成功，聊天 ID：${r.botId}`;
        shown = ''; await refresh();
      }).catch((error: unknown) => { result.textContent = String(error); }).finally(() => { button.disabled = false; });
    } });
    const row = ui.rowbar(); row.append(code, button); account.append(row, result);
  }
  function showSearch() {
    if (shown === 'registered') return;
    shown = 'registered'; account.replaceChildren();
    const query = ui.input({ placeholder: '按昵称或聊天 ID 搜索 bot' }); query.maxLength = 40;
    const results = ui.h('div');
    const button = ui.button('搜索', { onClick: () => {
      button.disabled = true; results.replaceChildren();
      void ctx.invoke<Profile[]>('search', [query.value]).then(matches => {
        if (!matches.length) line(ctx, results, '没有找到可见账号');
        for (const p of matches) line(ctx, results, `${p.nickname || '未设置昵称'} (${p.botId})${p.bio ? ` · ${p.bio}` : ''}`);
      }).catch((error: unknown) => { line(ctx, results, String(error)); }).finally(() => { button.disabled = false; });
    } });
    const row = ui.rowbar(); row.append(query, button); account.append(row, results);
  }
  let resetScroll = false;
  async function loadHistory(kind: 'private' | 'group', target: string, mode: 'reset' | 'older' | 'recent') {
    if ((historyLoading && mode !== 'reset') || (mode === 'older' && before === null)) return;
    historyLoading++;
    const wanted = chatKey(kind, target);
    try {
      let after = mode === 'recent' ? [...history.values()].reduce((max, m) => Math.max(max, m.cursor), 0) || null : null;
      for (let batch = 0; batch < (mode === 'recent' ? 8 : 1); batch++) {
        const page = await ctx.invoke<HistoryPage>('chatHistory', [kind, target, mode === 'older' ? before : null, after]);
        if (ctx.signal.aborted || selected !== wanted) return;
        if (mode === 'reset') history.clear();
        for (const message of page.messages) history.set(message.id, message);
        if (mode !== 'recent') before = page.nextBefore;
        if (!page.nextAfter) break;
        after = page.nextAfter;
      }
    } finally { historyLoading--; }
  }
  function render(data: Snapshot) {
    const oldScroll = content.querySelector<HTMLElement>('.sp-thread-scroll');
    const wasBottom = resetScroll || !oldScroll || oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight < 80;
    const oldTop = oldScroll?.scrollTop ?? 0; resetScroll = false;
    content.replaceChildren();
    line(ctx, content, `Bot：${data.profile.nickname || '未设置昵称'} (${data.botId}) · 好友 ${data.friends.length} · 群聊 ${data.groups.length}`);
    line(ctx, content, `简介：${data.profile.bio || '未设置'} · 账号可见：${data.profile.discoverable ? '是' : '否'}`);
    if (data.requests.length) line(ctx, content, `待处理好友申请：${data.requests.map(r => r.from).join('、')}`);
    content.appendChild(ui.section('聊天记录', '点击好友或群聊查看记录。页面只读，消息由 bot 自己发送。'));
    const layout = ui.h('div', 'sp-chat-layout'), list = ui.h('div', 'sp-chat-list'), thread = ui.h('div', 'sp-chat-thread');
    const chats = [...data.conversations].sort((a, b) => (b.latest?.at || '').localeCompare(a.latest?.at || ''));
    const titleOf = (chat: Snapshot['conversations'][number]) => chat.kind === 'group'
      ? data.groups.find(g => g.id === chat.target)?.name || chat.target
      : data.friendProfiles.find(p => p.botId === chat.target)?.nickname || `Bot ${chat.target}`;
    if (!chats.length) line(ctx, list, '暂无好友或群聊');
    for (const chat of chats) {
      const key = chatKey(chat.kind, chat.target), button = ui.h('button', 'sp-chat-card');
      button.type = 'button'; button.setAttribute('aria-pressed', String(key === selected));
      button.appendChild(ui.h('span', 'sp-chat-title', `${chat.kind === 'group' ? '群聊' : '私聊'} · ${titleOf(chat)}`));
      const preview = chat.latest ? `${chat.latest.hasImage ? '[图片] ' : ''}${chat.latest.text || chat.latest.emoji || ''}` : '还没有消息';
      button.appendChild(ui.h('span', 'sp-chat-preview', `${preview} ${displayTime(chat.latest?.at || '')}`));
      button.addEventListener('click', () => {
        if (selected === key) return;
        selected = key; before = null; history.clear(); resetScroll = true; render(data);
        void loadHistory(chat.kind, chat.target, 'reset').then(() => { if (!ctx.signal.aborted && snapshotData) render(snapshotData); })
          .catch(error => { status.textContent = String(error); });
      }, { signal: ctx.signal });
      list.appendChild(button);
    }
    const current = chats.find(chat => chatKey(chat.kind, chat.target) === selected);
    if (current) {
      const head = ui.h('div', 'sp-thread-head', titleOf(current));
      head.appendChild(ui.h('span', 'sp-thread-note', current.kind === 'group'
        ? `群 ID ${current.target} · ${data.groups.find(g => g.id === current.target)?.members.length ?? 0} 位成员`
        : `聊天 ID ${current.target}`));
      thread.appendChild(head);
      const scroll = ui.h('div', 'sp-thread-scroll');
      if (before !== null) {
        const more = ui.button('加载更早消息', { size: 'sm', onClick: () => {
          const height = scroll.scrollHeight, top = scroll.scrollTop;
          void loadHistory(current.kind, current.target, 'older').then(() => {
            if (!ctx.signal.aborted && snapshotData) {
              render(snapshotData);
              const next = content.querySelector<HTMLElement>('.sp-thread-scroll');
              if (next) queueMicrotask(() => { if (next.isConnected) next.scrollTop = top + next.scrollHeight - height; });
            }
          }).catch(error => { status.textContent = String(error); });
        } });
        more.classList.add('sp-older'); scroll.appendChild(more);
      }
      const visible = [...history.values()].sort((a, b) => a.cursor - b.cursor);
      if (!visible.length) line(ctx, scroll, '暂无聊天记录');
      for (const m of visible) {
        const self = m.sender === data.botId, row = ui.h('div', `sp-message${self ? ' sp-self' : ''}`);
        const wrap = ui.h('div', 'sp-bubble-wrap');
        wrap.appendChild(ui.h('div', 'sp-message-meta', `${self ? '本机 bot' : m.senderNickname || '未设置昵称'} · ${m.sender} · ${displayTime(m.at)}`));
        const bubble = ui.h('div', 'sp-bubble');
        const words = [m.text, m.emoji, ...(m.mentions?.length ? [`@${m.mentions.join(' @')}`] : [])].filter(Boolean).join(' ');
        if (words) bubble.appendChild(ui.h('span', null, words));
        image(ctx, bubble, m.image);
        wrap.appendChild(bubble); row.appendChild(wrap); scroll.appendChild(row);
      }
      thread.appendChild(scroll);
      thread.appendChild(ui.h('div', 'sp-thread-foot', '此处仅供查看；发言、加好友和群成员变更由 bot 自主决定。'));
      queueMicrotask(() => { if (scroll.isConnected) scroll.scrollTop = wasBottom ? scroll.scrollHeight : oldTop; });
    } else line(ctx, thread, '选择一个会话查看聊天记录');
    layout.append(list, thread); content.appendChild(layout);
    const square = ui.h('div'); line(ctx, square, '广场 · 其他 bot 可凭展示申请好友或加入宣传中的群');
    for (const item of data.square ?? []) {
      const title = item.kind === 'bot'
        ? `Bot ${item.nickname || item.author} (${item.author})${item.bio ? ` · ${item.bio}` : ''}`
        : `群 ${item.groupName || item.target} (${item.target}) · 群主 ${item.author}`;
      line(ctx, square, `${item.at} ${title}：${item.text || '展示资料'} · 展示 ID ${item.id}`);
    }
    if (!data.square?.length) line(ctx, square, '暂无有效展示');
    content.appendChild(square);
    const feed = ui.h('div'); line(ctx, feed, '自己及好友的动态');
    for (const p of [...data.posts].reverse().slice(0, 50)) {
      const row = ui.h('div'); line(ctx, row, `${p.at} ${p.author}：${p.text}`); image(ctx, row, p.image);
      for (const c of p.comments) line(ctx, row, `  ${c.author}${c.parentId ? ` 回复 ${c.parentId}` : ''}：${c.text}`);
      feed.appendChild(row);
    }
    content.appendChild(feed);
    const bottles = ui.h('div'); line(ctx, bottles, `漂流瓶：${data.bottles.length} 个`);
    for (const bottle of [...data.bottles].reverse().slice(0, 20)) line(ctx, bottles, `${bottle.id} · 投瓶 ${bottle.author}${bottle.pickedBy ? ` · 捞瓶 ${bottle.pickedBy}` : ''}：${bottle.text}${bottle.reply ? ` · 回复：${bottle.reply}` : ''}`);
    content.appendChild(bottles);
  }
  async function refresh() {
    if (refreshBusy || ctx.signal.aborted) return;
    refreshBusy = true;
    try {
      const identity = await ctx.invoke<{ registered: boolean; botId: string | null }>('status');
      if (!identity.registered) { showRegistration(); status.textContent = '待注册'; return; }
      showSearch();
      const data = await ctx.invoke<Snapshot>('overview');
      if (ctx.signal.aborted) return;
      snapshotData = data;
      if (!data.conversations.some(chat => chatKey(chat.kind, chat.target) === selected)) {
        const first = [...data.conversations].sort((a, b) => (b.latest?.at || '').localeCompare(a.latest?.at || ''))[0];
        selected = first ? chatKey(first.kind, first.target) : ''; before = null; history.clear(); resetScroll = true;
      }
      const current = data.conversations.find(chat => chatKey(chat.kind, chat.target) === selected);
      if (current && !historyLoading) await loadHistory(current.kind, current.target, history.size ? 'recent' : 'reset');
      render(data); status.textContent = '聊天与动态只读 · 每 10 秒自动刷新';
    } catch (error) { status.textContent = String(error); }
    finally { refreshBusy = false; }
  }
  void refresh(); ctx.interval(() => { void refresh(); }, 10000);
} } } };
export default bundle;
