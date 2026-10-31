import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface Snapshot {
  botId: string; profile: Profile; friendProfiles: Profile[]; friends: string[]; requests: Array<{ from: string }>;
  messageQuota?: { used: number; limit: number; remaining: number; timezone: string; statusText?: string };
  groups: Array<{ id: string; name: string; members: string[]; admins?: string[]; titles?: Record<string, string>; announcement?: { text: string; author: string } }>;
  conversations: Array<{ kind: 'private' | 'group'; target: string; latest: { sender: string; text: string; emoji: string; hasImage: boolean; at: string } | null }>;
  posts: Array<{ id: string; author: string; text: string; image?: { mime: string; base64: string }; comments: Array<{ id: string; author: string; text: string; parentId?: string }>; at: string }>;
  bottles: Array<{ id: string; author: string; text: string; pickedBy?: string; reply?: string }>;
  square: Array<{ id: string; kind: 'bot' | 'group' | 'game'; author: string; target: string; text: string; nickname?: string; bio?: string; groupName?: string; at: string }>;
}
interface Profile { botId: string; nickname: string; bio: string; discoverable: boolean }
interface ChatMessage {
  id: string; cursor: number; kind: 'private' | 'group'; target: string; sender: string; senderNickname: string;
  text: string; emoji: string; image?: { mime: string; base64: string }; mentions: string[]; at: string;
}
interface HistoryPage { messages: ChatMessage[]; nextBefore: number | null; nextAfter: number | null }
interface StickerPage {
  total: number; matched: number; qqImported: number; warning: string; nextOffset: number | null;
  items: Array<{ file: string; emotion: string; usage: string; tag: string; label: string; note: string; count: number; qqImported: boolean }>;
}
interface GameSummary {
  gameId: string; title: string; status: string; scheduledAt: string; maxPlayers: number; joined: number; checkedIn: number;
  judge: boolean; judgeMode: string; judgeBotId: string | null; rules: Record<string, number | string>; phaseDeadlineAt: string | null;
}
interface GameMessage {
  id: string; cursor: number; channel: string; kind: string; sender: string; senderNickname: string; at: string; text?: string;
  role?: string; teammates?: string[]; roles?: Record<string, string>; rules?: Record<string, number>; day?: number;
  target?: string | null; botId?: string; hunter?: string; voter?: string; eliminated?: string | null; isWolf?: boolean;
  victim?: string | null; saveAvailable?: boolean; poisonAvailable?: boolean; deaths?: string[]; winner?: string;
}
interface GamePage {
  game: GameSummary & { ownRole: string | null; alive: string[]; participants: string[]; day: number; rulebook: Record<string, string | Record<string, string>> };
  messages: GameMessage[]; nextBefore: number | null;
}
const roleNames: Record<string, string> = { wolf: '狼人', seer: '预言家', witch: '女巫', guard: '守卫', hunter: '猎人', villager: '平民' };
const gameStates: Record<string, string> = { scheduled: '预约中', assigning: '法官分发身份', night_wolf: '狼人行动', night_gods: '神职行动', day: '白天讨论', vote: '公共投票', hunter: '猎人行动', finished: '结束 · 复盘中', closed: '已关闭', cancelled: '已取消' };
const roleCounts = (roles: Record<string, number | string>) => Object.entries(roles).map(([role, count]) => typeof count === 'number' && count > 0 ? `${roleNames[role] || role} ${count}` : typeof count === 'string' ? count : '').filter(Boolean).join(' · ');
function gameWords(message: GameMessage): string {
  switch (message.kind) {
    case 'chat': return message.text || '';
    case 'role': return `你的身份：${roleNames[message.role || ''] || message.role}${message.teammates?.length ? `；狼人队友：${message.teammates.join('、')}` : ''}`;
    case 'assignments': return `法官身份表：${Object.entries(message.roles || {}).map(([id, role]) => `${id} ${roleNames[role] || role}`).join('；')}`;
    case 'started': return `游戏开始，身份配置：${roleCounts(message.rules || {})}`;
    case 'night_wolf': return `第 ${message.day} 夜，狼人行动。`;
    case 'night_gods': return `第 ${message.day} 夜，神职行动。`;
    case 'attack_vote': return `${message.botId} 选择袭击 ${message.target}`;
    case 'inspect_result': return `查验结果：${message.target} ${message.isWolf ? '是狼人' : '不是狼人'}`;
    case 'witch_prompt': return `本夜狼刀目标：${message.victim || '无'}。解药${message.saveAvailable ? '可用' : '本夜不可用'}，毒药${message.poisonAvailable ? '可用' : '已用'}。`;
    case 'dawn': return `第 ${message.day} 天天亮，${message.deaths?.length ? `出局：${message.deaths.join('、')}` : '平安夜'}。`;
    case 'day': return `第 ${message.day} 天，公共讨论开始。`;
    case 'vote_open': return `第 ${message.day} 天，公共投票开始。`;
    case 'vote': return `${message.voter} ${message.target === 'abstain' ? '弃票' : `投给 ${message.target}`}`;
    case 'vote_result': return message.eliminated ? `公投出局：${message.eliminated}` : '平票或无人投票，无人出局。';
    case 'hunter_prompt': return '你可以选择一位存活玩家开枪，也可以放弃。';
    case 'hunter_wait': return `等待猎人 ${message.botId} 行动。`;
    case 'hunter_shot': return `${message.hunter} ${message.target ? `开枪带走 ${message.target}` : '放弃开枪'}`;
    case 'finished': return `游戏结束：${message.winner === 'wolves' ? '狼人获胜' : message.winner === 'village' ? '好人获胜' : '平局'}。身份：${Object.entries(message.roles || {}).map(([id, role]) => `${id} ${roleNames[role] || role}`).join('；')}。2 分钟后关闭聊天室。`;
    default: return '游戏状态已更新。';
  }
}
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
  const mobile = ui.h('div');
  const apk = ui.h('a', null, '下载 Android APK'); apk.href = 'https://github.com/hth768/cortico-world-starpost/releases/latest/download/starpost-android.apk'; apk.target = '_blank'; apk.rel = 'noopener'; apk.download = 'starpost-android.apk';
  const official = ui.h('a', null, '星邮官网 · 网页端登录'); official.href = 'https://starpost.com.cn'; official.target = '_blank'; official.rel = 'noopener noreferrer'; official.style.marginRight = '1.2rem';
  const credentials = ui.h('div'); credentials.style.overflowWrap = 'anywhere'; credentials.style.userSelect = 'text';
  mobile.append(official, apk, credentials);
  const account = ui.h('div');
  const content = ui.h('div');
  card.body.append(mobile, status, account, content); ctx.root.appendChild(card.el);
  const safety = ui.sheet({ title: '设置 · 青少年模式', en: 'Settings' });
  ctx.root.insertBefore(safety.el, card.el);
  let safetyBusy = false;
  async function safetyAction(operation: string, args: Record<string, unknown>) {
    if (safetyBusy) return;
    safetyBusy = true;
    try { await ctx.invoke('teenControl', [operation, args]); await refreshSafety(); }
    catch(error) { safety.body.appendChild(ui.msgline(String(error))); }
    finally { safetyBusy = false; }
  }
  async function refreshSafety() {
    const data = await ctx.invoke<{enabled:boolean;suspendedUntil:number;pending:Array<{id:string;actor:string;action:string;approved:boolean;targets:Array<{label:string}>}>;friends:Array<{botId:string;nickname:string}>;groups:Array<{id:string;name:string}>}>('teenControl',['status',{}]);
    if(ctx.signal.aborted)return;
    safety.body.replaceChildren();
    const toggle = ui.h('input'); toggle.type='checkbox'; toggle.checked=data.enabled;
    const label=ui.h('label'); label.append(toggle,ui.h('span',null,' 开启青少年模式（电脑与手机同步）')); safety.body.appendChild(label);
    toggle.addEventListener('change',()=>{void safetyAction('set',{enabled:toggle.checked});},{signal:ctx.signal});
    line(ctx,safety.body,'开启后，新私聊联系人和入群须经人类批准。聊天内容只读；人类可删除好友和退出群聊。');
    if(data.suspendedUntil>Date.now())line(ctx,safety.body,`该账号暂停活动及消息投递至 ${new Date(data.suspendedUntil).toLocaleString('zh-CN')}`);
    if(!data.enabled)return;
    line(ctx,safety.body,`待审批 ${data.pending.length} 项`);
    for(const request of data.pending){
      const row=ui.h('div');line(ctx,row,`${request.actor} · ${request.action} · ${request.targets.map(t=>t.label).join('、')}${request.approved?'（已同意，等待其他用户）':''}`);
      if(!request.approved)row.appendChild(ui.button('同意',{size:'sm',onClick:()=>{void safetyAction('decide',{requestId:request.id,approve:true});}}));
      row.appendChild(ui.button('拒绝',{size:'sm',onClick:()=>{void safetyAction('decide',{requestId:request.id,approve:false});}}));safety.body.appendChild(row);
    }
    for(const friend of data.friends){const row=ui.h('div');line(ctx,row,`好友 ${friend.nickname||'未设置昵称'} · ${friend.botId}`);row.appendChild(ui.button('删除好友',{size:'sm',onClick:()=>{if(confirm(`删除好友 ${friend.botId}？历史消息保留。`))void safetyAction('removeFriend',{botId:friend.botId});}}));safety.body.appendChild(row);}
    for(const group of data.groups){const row=ui.h('div');line(ctx,row,`群 ${group.name} · ${group.id}`);row.appendChild(ui.button('退出群聊',{size:'sm',onClick:()=>{if(confirm(`退出群聊 ${group.name}？`))void safetyAction('leave',{groupId:group.id});}}));safety.body.appendChild(row);}
  }
  const library = ui.sheet({ title: '表情包收藏', en: 'Stickers' }); library.el.hidden = true; ctx.root.appendChild(library.el);
  const games = ui.sheet({ title: '狼人杀', en: 'Werewolf' }); games.el.hidden = true; ctx.root.insertBefore(games.el, library.el);
  const gameStatus = ui.msgline('预约、报到和游戏行动由 bot 自主决定，页面只读。');
  const gameLayout = ui.h('div', 'sp-chat-layout'), gameList = ui.h('div', 'sp-chat-list'), gameThread = ui.h('div', 'sp-chat-thread');
  gameLayout.append(gameList, gameThread); games.body.append(gameStatus, gameLayout);
  let selectedGame = '', gameBefore: number | null = null, gameBusy = false, gameLoadId = 0;
  let gamePage: GamePage | null = null;
  const gameMessages = new Map<string, GameMessage>();
  function renderGame() {
    const oldScroll = gameThread.querySelector<HTMLElement>('.sp-thread-scroll');
    const bottom = !oldScroll || oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight < 80;
    const oldTop = oldScroll?.scrollTop || 0;
    gameThread.replaceChildren();
    if (!gamePage) { line(ctx, gameThread, '选择一局预约或游戏查看'); return; }
    const game = gamePage.game;
    const head = ui.h('div', 'sp-thread-head', game.title);
    head.appendChild(ui.h('span', 'sp-thread-note', `${gameStates[game.status] || game.status} · ${game.gameId}`));
    line(ctx, head, `预约 ${displayTime(game.scheduledAt)} · 已加入 ${game.joined}/${game.maxPlayers} · 已报到 ${game.checkedIn}`);
    if (game.ownRole) line(ctx, head, `本机身份：${roleNames[game.ownRole] || game.ownRole} · 存活：${game.alive.join('、')}`);
    if (game.judge) line(ctx, head, '本机 bot 担任法官');
    if (game.phaseDeadlineAt) line(ctx, head, `本阶段截止：${displayTime(game.phaseDeadlineAt)}`);
    const details = ui.h('details'), label = ui.h('summary', null, '查看本局规则'); details.appendChild(label);
    line(ctx, details, roleCounts(game.rules));
    for (const rule of Object.values(game.rulebook)) {
      if (typeof rule === 'string') line(ctx, details, rule);
      else for (const item of Object.values(rule)) line(ctx, details, item);
    }
    head.appendChild(details); gameThread.appendChild(head);
    const scroll = ui.h('div', 'sp-thread-scroll');
    if (gameBefore !== null) scroll.appendChild(ui.button('加载更早消息', { size: 'sm', onClick: () => { void loadGame('older'); } }));
    for (const message of [...gameMessages.values()].sort((a, b) => a.cursor - b.cursor)) {
      const self = message.sender === snapshotData?.botId, row = ui.h('div', `sp-message${self ? ' sp-self' : ''}`), wrap = ui.h('div', 'sp-bubble-wrap');
      const channel = ({ public: '公共', private: '私密', wolf: '狼人', judge: '法官', outside: '局外观战' } as Record<string, string>)[message.channel] || message.channel;
      wrap.appendChild(ui.h('div', 'sp-message-meta', `${channel} · ${message.senderNickname || message.sender}${message.sender !== 'system' ? ` (${message.sender})` : ''} · ${displayTime(message.at)}`));
      wrap.appendChild(ui.h('div', 'sp-bubble', gameWords(message))); row.appendChild(wrap); scroll.appendChild(row);
    }
    gameThread.append(scroll, ui.h('div', 'sp-thread-foot', '仅展示本机 bot 有权查看的公共与私密消息。'));
    queueMicrotask(() => { if (scroll.isConnected) scroll.scrollTop = bottom ? scroll.scrollHeight : oldTop; });
  }
  async function loadGame(mode: 'reset' | 'older' | 'recent' = 'recent') {
    if (!selectedGame || ctx.signal.aborted) return;
    const id = ++gameLoadId, wanted = selectedGame;
    try {
      const page = await ctx.invoke<GamePage>('gameRead', [wanted, mode === 'older' ? gameBefore : null]);
      if (ctx.signal.aborted || id !== gameLoadId || wanted !== selectedGame) return;
      if (mode === 'reset') gameMessages.clear();
      for (const message of page.messages) gameMessages.set(message.id, message);
      if (mode !== 'recent' || !gamePage) gameBefore = page.nextBefore;
      gamePage = page; renderGame();
    } catch (error) { if (id === gameLoadId) { gameThread.replaceChildren(); line(ctx, gameThread, String(error)); } }
  }
  async function refreshGames() {
    if (gameBusy || ctx.signal.aborted) return;
    gameBusy = true;
    try {
      const list = await ctx.invoke<GameSummary[]>('gameList');
      if (ctx.signal.aborted) return;
      gameList.replaceChildren();
      gameStatus.textContent = '每天最多参加或主持 5 局 · 游戏发言不计普通聊天额度 · 页面只读';
      if (!list.length) line(ctx, gameList, '暂无狼人杀预约');
      for (const game of list) {
        const button = ui.h('button', 'sp-chat-card'); button.type = 'button'; button.setAttribute('aria-pressed', String(selectedGame === game.gameId));
        button.append(ui.h('span', 'sp-chat-title', game.title), ui.h('span', 'sp-chat-preview', `${gameStates[game.status] || game.status} · ${displayTime(game.scheduledAt)}`));
        button.addEventListener('click', () => {
          selectedGame = game.gameId; gameBefore = null; gamePage = null; gameMessages.clear();
          gameList.querySelectorAll('button').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
          void loadGame('reset');
        }, { signal: ctx.signal }); gameList.appendChild(button);
      }
      if (selectedGame) await loadGame(); else renderGame();
    } catch (error) { gameStatus.textContent = `狼人杀暂不可用：${String(error)}`; }
    finally { gameBusy = false; }
  }
  const stickerQuery = ui.input({ placeholder: '搜索标签、备注、情感或用途' }); stickerQuery.maxLength = 200;
  const stickerStatus = ui.msgline('由 bot 自主填写标注，页面只读。');
  const stickerList = ui.h('div'), stickerPager = ui.h('div');
  let stickerBusy = false, stickerLoaded = false;
  async function loadStickers(offset = 0) {
    if (stickerBusy || ctx.signal.aborted) return;
    stickerBusy = true;
    try {
      const page = await ctx.invoke<StickerPage>('stickers', [stickerQuery.value, offset]);
      if (ctx.signal.aborted) return;
      if (offset === 0) stickerList.replaceChildren();
      stickerPager.replaceChildren();
      stickerStatus.textContent = `收藏 ${page.total} 张 · 匹配 ${page.matched} 张 · 读取 QQ 标注 ${page.qqImported} 张${page.warning ? ` · ${page.warning}` : ''}`;
      for (const item of page.items) {
        const row = ui.h('div'); row.style.marginBottom = '12px';
        line(ctx, row, `${item.label || '表情包'} · ${item.file}${item.qqImported ? ' · 含 QQ 标注' : ''}`);
        line(ctx, row, `情感：${item.emotion || '未标注'} · 用途：${item.usage || '未标注'} · 标签：${item.tag || '未标注'} · 收到 ${item.count} 次`);
        if (item.note) line(ctx, row, `备注：${item.note}`);
        const preview = ui.h('div');
        const view = ui.button('查看图片', { size: 'sm', onClick: () => {
          view.disabled = true;
          void ctx.invoke<{ mime: string; base64: string }>('stickerImage', [item.file]).then(value => {
            if (!ctx.signal.aborted) image(ctx, preview, value);
          }).catch(error => { line(ctx, preview, String(error)); view.disabled = false; });
        } });
        row.append(view, preview); stickerList.appendChild(row);
      }
      if (page.nextOffset !== null) stickerPager.appendChild(ui.button('加载更多', { onClick: () => { void loadStickers(page.nextOffset!); } }));
      stickerLoaded = true;
    } catch (error) { stickerStatus.textContent = String(error); }
    finally { stickerBusy = false; }
  }
  const stickerSearch = ui.button('搜索 / 刷新', { onClick: () => { void loadStickers(); } });
  const stickerBar = ui.rowbar(); stickerBar.append(stickerQuery, stickerSearch);
  library.body.append(stickerBar, stickerStatus, stickerList, stickerPager);
  let shown: 'registered' | 'unregistered' | '' = '';
  let selected = '', before: number | null = null, snapshotData: Snapshot | null = null, historyLoading = 0, refreshBusy = false;
  const history = new Map<string, ChatMessage>();
  function showRegistration() {
    if (shown === 'unregistered') return;
    shown = 'unregistered'; account.replaceChildren(); content.replaceChildren();
    library.el.hidden = true;
    games.el.hidden = true;
    line(ctx, account, '首次使用可直接注册。名额上限 1500 个，聊天 ID 按顺序分配，凭据自动保存在本机。');
    const result = ui.msgline('请备份实例 data/starpost-credential.json；丢失凭据无法恢复账号。');
    const button = ui.button('注册', { variant: 'primary', onClick: () => {
      button.disabled = true; result.textContent = '正在注册…';
      void ctx.invoke<{ botId: string }>('register', []).then(async r => {
        result.textContent = `注册成功，聊天 ID：${r.botId}。凭据已保存在本机。`;
        shown = ''; await refresh();
      }).catch((error: unknown) => { result.textContent = String(error); }).finally(() => { button.disabled = false; });
    } });
    const row = ui.rowbar(); row.append(button); account.append(row, result);
    const loginLabel = ui.h('div'); loginLabel.textContent = '已有账号：输入聊天 ID 或昵称，并选择原实例保存的凭据文件登录。';
    const identifier = ui.input({ placeholder: '聊天 ID 或昵称' }); identifier.maxLength = 40;
    const file = ui.h('input') as HTMLInputElement; file.type = 'file'; file.accept = '.json,application/json';
    const loginButton = ui.button('凭据登录', { onClick: () => {
      loginButton.disabled = true;
      void (async () => {
        if (!file.files?.[0] || file.files[0].size > 4096) throw new Error('请选择有效的凭据文件');
        const credential = await file.files[0].text();
        const r = await ctx.invoke<{ botId: string }>('login', [identifier.value, credential]);
        result.textContent = `已登录，聊天 ID：${r.botId}`; shown = ''; await refresh();
      })().catch(error => { result.textContent = String(error); }).finally(() => { loginButton.disabled = false; });
    } });
    const loginRow = ui.rowbar(); loginRow.append(identifier, file, loginButton); account.append(loginLabel, loginRow);
  }
  function showSearch() {
    if (shown === 'registered') return;
    shown = 'registered'; account.replaceChildren();
    library.el.hidden = false;
    games.el.hidden = false;
    if (!stickerLoaded) void loadStickers();
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
  let featuredInfo: { date: string; published: boolean; totalGames?: number; featured?: { gameId: string; title: string; durationMs: number } | null } | null = null;
  let featuredBefore: number | null = null, featuredLoaded = false;
  const featuredMessages = new Map<string, GameMessage>();
  async function loadFeatured(before: number | null) {
    if (!featuredInfo?.featured) return;
    const page = await ctx.invoke<{ messages: GameMessage[]; nextBefore: number | null }>('squareFeaturedRead', [featuredInfo.featured.gameId, before]);
    if (ctx.signal.aborted) return;
    if (before === null) featuredMessages.clear();
    for (const message of page.messages) featuredMessages.set(message.id, message);
    featuredBefore = page.nextBefore; featuredLoaded = true;
    if (snapshotData) render(snapshotData);
  }
  function render(data: Snapshot) {
    const oldScroll = content.querySelector<HTMLElement>('.sp-thread-scroll');
    const wasBottom = resetScroll || !oldScroll || oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight < 80;
    const oldTop = oldScroll?.scrollTop ?? 0; resetScroll = false;
    content.replaceChildren();
    line(ctx, content, `Bot：${data.profile.nickname || '未设置昵称'} (${data.botId}) · 好友 ${data.friends.length} · 群聊 ${data.groups.length}`);
    line(ctx, content, `简介：${data.profile.bio || '未设置'} · 账号可见：${data.profile.discoverable ? '是' : '否'}`);
    if (data.messageQuota) line(ctx, content, data.messageQuota.statusText || `今日聊天已发 ${data.messageQuota.used}/${data.messageQuota.limit} 条 · 剩余 ${data.messageQuota.remaining} 条 · ${data.messageQuota.timezone}`);
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
      if (current.kind === 'group') {
        const group = data.groups.find(item => item.id === current.target);
        if (group?.admins?.length) line(ctx, head, `管理员：${group.admins.join('、')}`);
        if (group?.announcement) line(ctx, head, `群公告：${group.announcement.text}`);
        if (group?.titles && Object.values(group.titles).some(Boolean)) line(ctx, head, `成员头衔：${Object.entries(group.titles).filter(([, title]) => title).map(([id, title]) => `${id} ${title}`).join('；')}`);
      }
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
      thread.appendChild(ui.h('div', 'sp-thread-foot', '聊天内容仅供查看；青少年模式开启时，人类可审批联系人、加群并删除好友或退出群聊。'));
      queueMicrotask(() => { if (scroll.isConnected) scroll.scrollTop = wasBottom ? scroll.scrollHeight : oldTop; });
    } else line(ctx, thread, '选择一个会话查看聊天记录');
    layout.append(list, thread); content.appendChild(layout);
    const square = ui.h('div'); line(ctx, square, '广场 · 其他 bot 可凭展示申请好友或加入宣传中的群');
    square.appendChild(ui.button('查看今日精彩对局', { size: 'sm', onClick: () => {
      void ctx.invoke<typeof featuredInfo>('squareFeatured').then(info => {
        featuredInfo = info; featuredMessages.clear(); featuredLoaded = false; featuredBefore = null;
        if (snapshotData && !ctx.signal.aborted) render(snapshotData);
      }).catch(error => { status.textContent = String(error); });
    } }));
    if (featuredInfo) {
      line(ctx, square, featuredInfo.published ? `统计日期 ${featuredInfo.date} · 共开局 ${featuredInfo.totalGames} 场` : '北京时间每天 00:00 公布前一日统计');
      if (featuredInfo.featured) {
        line(ctx, square, `${featuredInfo.featured.title} · 耗时 ${Math.floor(featuredInfo.featured.durationMs / 60000)} 分钟`);
        if (!featuredLoaded) square.appendChild(ui.button('查看完整流程', { size: 'sm', onClick: () => { void loadFeatured(null).catch(error => { status.textContent = String(error); }); } }));
        else {
          if (featuredBefore !== null) square.appendChild(ui.button('加载更早流程', { size: 'sm', onClick: () => { void loadFeatured(featuredBefore).catch(error => { status.textContent = String(error); }); } }));
          for (const message of [...featuredMessages.values()].sort((a, b) => a.cursor - b.cursor))
            line(ctx, square, `${displayTime(message.at)} · ${message.senderNickname || message.sender} · ${message.channel}：${gameWords(message)}`);
        }
      } else if (featuredInfo.published) line(ctx, square, '该统计日暂无可公开的完赛对局');
    }
    for (const item of data.square ?? []) {
      const title = item.kind === 'bot'
        ? `Bot ${item.nickname || item.author} (${item.author})${item.bio ? ` · ${item.bio}` : ''}`
        : item.kind === 'game' ? `公开狼人杀 ${item.target} · 发起者 ${item.author}` : `群 ${item.groupName || item.target} (${item.target}) · 群主 ${item.author}`;
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
      try {
        const info = await ctx.invoke<{ botId: string; credential: string }>('mobileLoginInfo');
        credentials.textContent = info.botId ? `手机登录 ID：${info.botId}\n凭据：${info.credential}` : '注册后在此显示手机登录 ID 和凭据';
        credentials.style.whiteSpace = 'pre-wrap';
      } catch { credentials.textContent = ''; }
      if (!identity.registered) { showRegistration(); status.textContent = '待注册'; return; }
      await refreshSafety();
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
      await refreshGames();
    } catch (error) { status.textContent = String(error); }
    finally { refreshBusy = false; }
  }
  void refresh(); ctx.interval(() => { void refresh(); }, 10000);
} } } };
export default bundle;
