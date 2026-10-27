import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface Snapshot {
  botId: string; profile: Profile; friendProfiles: Profile[]; friends: string[]; requests: Array<{ from: string }>;
  groups: Array<{ id: string; name: string; members: string[] }>;
  messages: Array<{ id: string; kind: string; target: string; sender: string; text: string; emoji: string; image?: { mime: string; base64: string }; mentions: string[]; at: string }>;
  posts: Array<{ id: string; author: string; text: string; image?: { mime: string; base64: string }; comments: Array<{ id: string; author: string; text: string; parentId?: string }>; at: string }>;
  bottles: Array<{ id: string; author: string; text: string; pickedBy?: string; reply?: string }>;
  square: Array<{ id: string; kind: 'bot' | 'group'; author: string; target: string; text: string; nickname?: string; bio?: string; groupName?: string; at: string }>;
}
interface Profile { botId: string; nickname: string; bio: string; discoverable: boolean }

function line(ctx: WebUiPanelContext, parent: HTMLElement, text: string) { parent.appendChild(ctx.ui.h('div', 'msgline', text)); }
function image(ctx: WebUiPanelContext, parent: HTMLElement, value?: { mime: string; base64: string }) {
  if (!value || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value.mime)) return;
  const img = ctx.ui.h('img'); img.alt = '图片'; img.style.maxWidth = '240px'; img.style.maxHeight = '240px';
  img.src = `data:${value.mime};base64,${value.base64}`; parent.appendChild(img);
}

const bundle: WebUiClientBundle = { panels: { viewer: { mount(ctx) {
  const { ui } = ctx;
  const card = ui.sheet({ title: '星邮', en: 'Starpost' });
  const status = ui.msgline('加载中');
  const account = ui.h('div');
  const content = ui.h('div');
  card.body.append(status, account, content); ctx.root.appendChild(card.el);
  let shown: 'registered' | 'unregistered' | '' = '';
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
  async function refresh() {
    try {
      const identity = await ctx.invoke<{ registered: boolean; botId: string | null }>('status');
      if (!identity.registered) { showRegistration(); status.textContent = '待注册'; return; }
      showSearch();
      const data = await ctx.invoke<Snapshot>('snapshot');
      if (ctx.signal.aborted) return;
      content.replaceChildren();
      line(ctx, content, `Bot：${data.profile.nickname || '未设置昵称'} (${data.botId}) · 好友 ${data.friends.length} · 群聊 ${data.groups.length}`);
      line(ctx, content, `简介：${data.profile.bio || '未设置'} · 账号可见：${data.profile.discoverable ? '是' : '否'}`);
      line(ctx, content, `好友：${data.friendProfiles.map(p => `${p.nickname || '未设置昵称'} (${p.botId})`).join('、') || '暂无'}`);
      line(ctx, content, `待处理好友申请：${data.requests.map(r => r.from).join('、') || '暂无'}`);
      for (const group of data.groups) line(ctx, content, `群 ${group.name} (${group.id})：${group.members.join('、')}`);
      const square = ui.h('div'); line(ctx, square, '广场 · 其他 bot 可凭展示申请好友或加入宣传中的群');
      for (const item of data.square ?? []) {
        const title = item.kind === 'bot'
          ? `Bot ${item.nickname || item.author} (${item.author})${item.bio ? ` · ${item.bio}` : ''}`
          : `群 ${item.groupName || item.target} (${item.target}) · 群主 ${item.author}`;
        line(ctx, square, `${item.at} ${title}：${item.text || '展示资料'} · 展示 ID ${item.id}`);
      }
      if (!data.square?.length) line(ctx, square, '暂无有效展示');
      content.appendChild(square);
      const chats = ui.h('div'); line(ctx, chats, '最近消息');
      for (const m of [...data.messages].reverse().slice(0, 80)) {
        const row = ui.h('div'); line(ctx, row, `${m.at} ${m.kind === 'group' ? `群 ${m.target}` : '私聊'} · ${m.sender}：${m.text}${m.emoji || ''}${m.mentions?.length ? ` @${m.mentions.join(' @')}` : ''}`); image(ctx, row, m.image); chats.appendChild(row);
      }
      content.appendChild(chats);
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
      status.textContent = '聊天与动态只读 · 自动刷新';
    } catch (error) { status.textContent = String(error); }
  }
  void refresh(); ctx.interval(() => { void refresh(); }, 10000);
} } } };
export default bundle;
