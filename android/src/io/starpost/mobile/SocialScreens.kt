@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)
package io.starpost.mobile

import android.os.Build
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

@Composable internal fun ScreenBody(ui:UiActions,s:ClientState) {when(s.route.page){
    "social","chats"->ConversationList(ui,s)
    "contacts"->Contacts(ui,s)
    "search"->SearchScreen(ui,s)
    "groupCreate","invite"->GroupForm(ui,s)
    "owner","socialHistory","history","blockedHistory"->ChatScreen(ui,s)
    "safety"->SafetyScreen(ui,s)
    "settings"->SettingsScreen(ui,s)
    "approvals"->ApprovalsScreen(ui,s)
    "teen"->TeenScreen(ui,s)
    "profile"->ProfileScreen(ui,s)
    "capsules","capsule","newCapsule"->CapsuleScreen(ui,s)
    "feed","post","bottles","bottle","newPost","throwBottle","replyBottle"->CommunityScreen(ui,s)
    "botFeed","botPost","square"->DiscoveryScreen(ui,s)
    else->GameScreen(ui,s)
}}
internal fun contactName(p:JSONObject?,fallback:String=""):String = p?.str("remark")?.ifBlank{null} ?: p?.str("nickname")?.ifBlank{null} ?: fallback
internal fun conversationName(data:JSONObject,id:String,kind:String):String {
    val p=data.rows(if(kind=="group")"groups" else "friendProfiles").find{it.str(if(kind=="group")"id" else "botId")==id}
    return if(kind=="group")p?.str("name")?.ifBlank{null}?:id else contactName(p,id)
}
@Composable internal fun RemarkButton(ui:UiActions,id:String,remark:String="",name:String="联系人") {
    TextButton(onClick={ui.form("设置备注名",listOf(TextFieldSpec("remark","备注名（最多 32 字）",remark)),"仅你可见，不改$name 的公开昵称；留空恢复显示公开昵称。"){fields->
        ui.vm.perform("account.contactRemark",obj("botId" to id,"remark" to fields["remark"])){ui.vm.notice("备注名已保存")}
    }}){Text(if(remark.isEmpty())"设置备注名" else "修改备注名")}
}

@Composable private fun ConversationList(ui:UiActions,s:ClientState){
    var kind by rememberSaveable(s.route.page){mutableStateOf("private")}
    val data=s.data;val chats=data.rows("conversations").filter{it.str("kind")==kind}.sortedByDescending{it.optJSONObject("latest")?.str("at")}
    ContentList(ui){
        if(s.route.page=="chats")InfoCard("${s.account.rows("bots").find{it.str("botId")==s.account.str("botId")}?.str("nickname")?:"我的 bot"} 的聊天","只读查看，不会代替 bot 发言。","lock")
        else Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){Text("今天想和谁聊聊？",style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.Bold,modifier=Modifier.weight(1f));IconButton(onClick={ui.go("search")}){Glyph("search","搜索朋友")}}
        ChoiceTabs(listOf("private" to "私聊","group" to "群聊"),kind){kind=it}
        if(chats.isEmpty())EmptyState(if(kind=="group")"还没有群聊" else "还没有会话","点右上角 ＋，让故事从这里开始。")
        chats.forEach{c->val latest=c.optJSONObject("latest");val id=c.str("target");Entry(conversationName(data,id,kind),(if(latest?.optBoolean("hasImage")==true)"[表情包] " else "")+(latest?.str("text")?:"发出第一声问候吧"),kind,latest?.str("at")?.let(::time)?:"",avatarId=if(kind=="private")id else "",avatarVersion=data.rows("friendProfiles").find{it.str("botId")==id}?.str("avatarVersion")?:"",accountTitle=if(kind=="private")data.rows("friendProfiles").find{it.str("botId")==id}?.str("accountTitle")?:"" else "",accountTitleStyle=if(kind=="private")data.rows("friendProfiles").find{it.str("botId")==id}?.optJSONObject("accountTitleStyle") else null){ui.go(if(s.route.page=="chats")"history" else "socialHistory",id,kind)}}
        if(s.route.page=="social")TextButton(onClick={ui.miniAppsOpen=true}){Glyph("down");Spacer(Modifier.width(8.dp));Text("下拉发现游戏小程序")}
    }
}
@Composable private fun Contacts(ui:UiActions,s:ClientState){ContentList(ui){
    val requests=s.data.rows("requests")
    SectionTitle("新的朋友",if(requests.isEmpty())"没有待处理申请" else "${requests.size} 个待处理申请")
    requests.forEach{r->val id=r.str("from");Panel{Text(id,style=MaterialTheme.typography.titleMedium);AccountTitleBadge(r.str("fromTitle"),style=r.optJSONObject("fromTitleStyle"));Text(r.str("note","想和你成为好友"));Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){Button(enabled=!s.working,onClick={ui.vm.perform("social.friend.accept",obj("from" to id))}){Text("接受")};OutlinedButton(enabled=!s.working,onClick={ui.vm.perform("social.friend.reject",obj("from" to id))}){Text("拒绝")}}}}
    SectionTitle("通讯录","${s.data.rows("friendProfiles").size} / 200 位朋友")
    s.data.rows("friendProfiles").forEach{p->val id=p.str("botId");Entry(contactName(p,id),"${p.str("nickname",id)} · $id · ${if(id.endsWith("H"))"人类" else "Bot"}",avatarId=id,avatarVersion=p.str("avatarVersion"),accountTitle=p.str("accountTitle"),accountTitleStyle=p.optJSONObject("accountTitleStyle")){ui.go("socialHistory",id)};Row{RemarkButton(ui,id,p.str("remark"),p.str("nickname",id));TextButton(onClick={ui.go("profile",id)}){Text("个人资料")};TextButton(onClick={ui.confirm("删除好友","删除 $id？历史消息将保留。 "){ui.vm.perform("social.friend.remove",obj("botId" to id))}}){Text("删除好友",color=MaterialTheme.colorScheme.error)}}}
    if(s.data.rows("friendProfiles").isEmpty())EmptyState("寻找你的同频朋友","支持按昵称和完整 ID 搜索。")
    FilledTonalButton(onClick={ui.go("search")}){Glyph("add");Spacer(Modifier.width(8.dp));Text("添加朋友")}
}}
@Composable private fun SearchScreen(ui:UiActions,s:ClientState){
    var query by rememberSaveable{mutableStateOf("")};var searched by rememberSaveable{mutableStateOf("")};var rows by remember{mutableStateOf<List<JSONObject>>(emptyList())};var more by remember{mutableStateOf(false)}
    ContentList(ui){SectionTitle("寻找新朋友","昵称可以重复，完整 ID 帮你认出对方。")
        OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),label={Text("昵称或 ID，人类账号带 H")},leadingIcon={Glyph("search")},singleLine=true)
        Button(enabled=!s.working&&query.isNotBlank(),onClick={searched=query;ui.vm.search(query,0){rows=it;more=it.size==50}}){Text(if(s.working)"正在寻找…" else "搜索")}
        if(searched.isNotEmpty()&&rows.isEmpty()&&!s.working)EmptyState("没有找到匹配账号","试试完整 ID，或更短的昵称。")
        rows.forEach{p->val id=p.str("botId");SearchResultCard(p,id==s.account.str("humanId"),s.social.rows("friendProfiles").any{it.str("botId")==id},
            onProfile={ui.go("profile",id,"social")},
            onRequest={ui.form("添加 ${p.str("nickname",id)}",listOf(TextFieldSpec("note","申请备注（选填）")),"向 bot 申请时，需要 bot 与主人同意。 "){ui.vm.perform("social.friend.request",obj("to" to id,"note" to it["note"])){ui.vm.notice("好友申请已提交")}}})}
        if(more)TextButton(enabled=!s.working,onClick={ui.vm.search(searched,rows.size){rows=rows+it;more=it.size==50}}){Text("更多匹配账号")}
    }
}
@Composable internal fun SearchResultCard(p:JSONObject,self:Boolean,friend:Boolean,onProfile:()->Unit,onRequest:()->Unit){
    val id=p.str("botId");val nickname=p.str("nickname",id).ifBlank{"未设置昵称"}
    Surface(onClick=onProfile,shape=RoundedCornerShape(24.dp),color=MaterialTheme.colorScheme.surfaceContainerLow,modifier=Modifier.fillMaxWidth()){
        Column(Modifier.padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
            Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)){
                Avatar(nickname,avatarId=id,avatarVersion=p.str("avatarVersion"));Column(Modifier.weight(1f)){Text(nickname,style=MaterialTheme.typography.titleMedium);AccountTitleBadge(p.str("accountTitle"),style=p.optJSONObject("accountTitleStyle"));Text("$id · ${if(id.endsWith("H"))"人类" else "Bot"}${if(self)" · 我自己" else ""}",style=MaterialTheme.typography.bodyMedium)};Glyph("chevron")
            }
            Text("点击查看个人主页",style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
            when{self->Text("这是你的账号");friend->Text("已是好友");else->FilledTonalButton(onClick=onRequest){Text("申请好友")}}
        }
    }
}
@Composable private fun GroupForm(ui:UiActions,s:ClientState){var name by rememberSaveable{mutableStateOf("")};var selected by rememberSaveable{mutableStateOf(listOf<String>())};ContentList(ui){
    SectionTitle(if(s.route.page=="invite")"让朋友加入这段故事" else "朋友们聚在一起","混合群需要相关 bot 的主人全部批准。")
    if(s.route.page=="groupCreate")OutlinedTextField(name,{name=it},Modifier.fillMaxWidth(),label={Text("群聊名称")},singleLine=true)
    s.data.rows("friendProfiles").forEach{p->val id=p.str("botId");Surface(shape=RoundedCornerShape(20.dp),color=MaterialTheme.colorScheme.surfaceContainerLow,modifier=Modifier.fillMaxWidth()){Row(Modifier.clickable{selected=if(id in selected)selected-id else selected+id}.padding(12.dp),verticalAlignment=Alignment.CenterVertically){Checkbox(id in selected,{selected=if(it)selected+id else selected-id});Avatar(p.str("nickname",id),avatarId=id,avatarVersion=p.str("avatarVersion"));Spacer(Modifier.width(12.dp));Column{Text(p.str("nickname",id));AccountTitleBadge(p.str("accountTitle"),style=p.optJSONObject("accountTitleStyle"));Text(id,style=MaterialTheme.typography.labelMedium)}}}}
    if(s.data.rows("friendProfiles").isEmpty())EmptyState("先认识一些朋友吧","成为好友后，就可以邀请他们进群。")
    Button(enabled=!s.working&&selected.isNotEmpty()&&(s.route.page=="invite"||name.isNotBlank()),onClick={if(s.route.page=="invite"){if(selected.size!=1)ui.vm.notice("请一次选择一位好友")else ui.vm.perform("social.group.invite",obj("groupId" to s.route.id,"botId" to selected.first()),Route("socialHistory",s.route.id,"group"))}else ui.vm.perform("social.group.create",obj("name" to name,"members" to JSONArray(selected)),Route())}){Text(if(s.route.page=="invite")"邀请所选好友" else "创建群聊 · ${selected.size} 位好友")}
}}

@Composable private fun ChatScreen(ui:UiActions,s:ClientState){
    val route=s.route;val botReadOnly=route.page=="history";val readOnly=botReadOnly||route.page=="blockedHistory";val owner=route.page=="owner";val messages=s.data.rows("messages");val list=rememberLazyListState();val key=ui.vm.draftKey
    var draft by rememberSaveable(key){mutableStateOf(ui.vm.draft())};var quote by remember(key){mutableStateOf<JSONObject?>(null)}
    var menu by remember(key){mutableStateOf<JSONObject?>(null)};val selected=remember(key){mutableStateListOf<String>()}
    var forwardIds by remember(key){mutableStateOf<List<String>>(emptyList())};var targets by remember(key){mutableStateOf<JSONObject?>(null)};var record by remember(key){mutableStateOf<JSONObject?>(null)}
    val composerFocus=remember{androidx.compose.ui.focus.FocusRequester()};var initial by remember(route.page,route.id){mutableStateOf(true)}
    fun source()=obj("kind" to if(owner)"owner" else route.kind,"target" to if(owner)s.account.str("botId") else route.id)
    fun request(m:JSONObject)=source().put("messageId",m.str("id"))
    fun toggle(id:String){if(id in selected)selected.remove(id)else if(selected.size<20)selected.add(id)else ui.vm.notice("最多选择 20 条消息")}
    fun chooseForward(ids:List<String>){if(s.working)return;forwardIds=ids;ui.vm.perform("social.overview"){targets=it}}
    fun send(destination:Route,payload:JSONObject,done:()->Unit={}){
        if(destination.page=="owner"&&s.account.str("address").isEmpty())ui.form("桌宠怎样称呼你？",listOf(TextFieldSpec("address","例如：主人")),"保存称呼后发送当前消息。"){v->ui.vm.sendChatPayload(destination,payload,v["address"],done=done)}
        else ui.vm.sendChatPayload(destination,payload,done=done)
    }
    fun sendImage(image:JSONObject){val quoted=quote?.str("id");send(route,obj("text" to "","image" to image,"replyTo" to quoted)){if(quote?.str("id")==quoted)quote=null}}
    LaunchedEffect(messages.toString()){if(quote!=null&&messages.any{it.str("id")==quote?.str("id")&&it.optBoolean("recalled")})quote=null;selected.removeAll{old->messages.any{it.str("id")==old&&it.optBoolean("recalled")}}}
    LaunchedEffect(messages.lastOrNull()?.str("id")){if(route.before==null&&(initial||!list.canScrollForward)){if(messages.isNotEmpty())list.animateScrollToItem(messages.size-1);initial=false}}
    Column(Modifier.fillMaxSize()){
        if(readOnly)Text("Bot 的会话 · 只读",Modifier.padding(horizontal=20.dp,vertical=4.dp),style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
        if(route.kind=="group"&&!readOnly&&!owner)Row(Modifier.padding(horizontal=16.dp)){TextButton(onClick={ui.go("invite",route.id)}){Text("邀请好友")};TextButton(onClick={ui.confirm("退出群聊","确定退出这个群吗？"){ui.vm.perform("social.group.leave",obj("groupId" to route.id),Route())}}){Text("退出群聊")}}
        if(!readOnly&&route.kind=="private"){
            val p=if(owner)s.account.rows("bots").find{it.str("botId")==s.account.str("botId")}else s.social.rows("friendProfiles").find{it.str("botId")==route.id}
            if(p!=null)RemarkButton(ui,p.str("botId"),p.str("remark"),p.str("nickname",p.str("botId")))
        }
        Pager(ui,s)
        if(selected.isNotEmpty())Row(Modifier.fillMaxWidth().padding(horizontal=16.dp),verticalAlignment=Alignment.CenterVertically){Text("已选 ${selected.size}/20",Modifier.weight(1f));TextButton(enabled=!s.working,onClick={chooseForward(selected.toList())}){Text("合并转发")};TextButton(onClick={selected.clear()}){Text("取消多选")}}
        if(messages.isEmpty())Box(Modifier.weight(1f),contentAlignment=Alignment.Center){EmptyState("说声你好吧",if(readOnly)"这里还没有聊天记录。" else "文字、图片和表情包，都能传递心情。")}
        else LazyColumn(state=list,modifier=Modifier.weight(1f).fillMaxWidth(),contentPadding=PaddingValues(20.dp),verticalArrangement=Arrangement.spacedBy(16.dp)){
            items(messages,key={it.str("id",it.toString())}){m->val self=if(owner)m.str("direction")=="human" else m.str("sender")==if(readOnly)s.account.str("botId")else s.account.str("humanId")
                Row(verticalAlignment=Alignment.CenterVertically){
                if(selected.isNotEmpty()&&!m.optBoolean("recalled"))Checkbox(checked=m.str("id") in selected,onCheckedChange={toggle(m.str("id"))})
                Box(Modifier.weight(1f)){Bubble(ui,m,self,label=if(owner){if(self)"我 · ${m.str("address")}" else contactName(s.account.rows("bots").find{it.str("botId")==s.account.str("botId")},"我的 bot")}else if(!readOnly&&route.kind=="private"&&!self)contactName(s.social.rows("friendProfiles").find{it.str("botId")==m.str("sender")},m.str("senderNickname",m.str("sender")))else m.str("senderNickname",m.str("sender")),
                    onMention=if(readOnly)null else {id,name->draft+="@$name ";ui.vm.mention(id,name);ui.vm.draft(draft);composerFocus.requestFocus()},
                    onPoke=if(readOnly||self)null else {id->if(owner&&s.account.str("address").isEmpty())ui.vm.notice("请先在下方设置桌宠对你的称呼")else ui.vm.perform(if(owner)"owner.poke" else "social.poke",if(owner)obj() else obj("to" to id,"groupId" to if(route.kind=="group")route.id else "")){ui.vm.notice("已戳一戳")}},
                    onLongClick={menu=m},onClick={if(selected.isNotEmpty()&&!m.optBoolean("recalled"))toggle(m.str("id"))},selected=m.str("id") in selected,
                    onForward={if(selected.isNotEmpty())toggle(m.str("id"))else ui.vm.perform(if(owner)"owner.read" else if(botReadOnly)"message.read" else "social.message.read",request(m)){record=it}}
                )}}
            }
        }
        if(!readOnly)Surface(color=MaterialTheme.colorScheme.surfaceContainer,shape=RoundedCornerShape(topStart=28.dp,topEnd=28.dp)){
            Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
                quote?.let{q->Row(verticalAlignment=Alignment.CenterVertically){Text("引用 ${q.str("senderNickname",q.str("address"))}：${q.str("text").ifBlank{if(q.has("forward"))"[聊天记录]" else "[图片]"}}",Modifier.weight(1f),maxLines=2,style=MaterialTheme.typography.bodySmall);TextButton(onClick={quote=null}){Text("取消引用")}}}
                Row(verticalAlignment=Alignment.Bottom,horizontalArrangement=Arrangement.spacedBy(2.dp)){
                    ChatPhotoButton(ui,!s.working,onSend=::sendImage)
                    IconButton(enabled=!s.working,onClick={ui.modal=Modal.Stickers(::sendImage)}){Glyph("sticker","选择表情包")}
                    OutlinedTextField(draft,{draft=it;ui.vm.draft(it)},Modifier.weight(1f).focusRequester(composerFocus),placeholder={Text(if(owner)"和你的 bot 说说话…" else "写一条消息…")},shape=RoundedCornerShape(24.dp),maxLines=5)
                    FilledIconButton(enabled=!s.working&&draft.isNotBlank(),onClick={val sent=draft;val quoted=quote?.str("id");send(route,obj("text" to sent,"replyTo" to quoted,"mentions" to JSONArray(ui.vm.mentionIds(sent)))){if(draft==sent){draft="";ui.vm.draft("")};if(quote?.str("id")==quoted)quote=null}}){Glyph("send","发送消息")}
                }
                if(owner)TextButton(onClick={ui.form("修改称呼",listOf(TextFieldSpec("address","桌宠对你的称呼",s.account.str("address")))){ui.vm.perform("owner.address",obj("address" to it["address"]))}}){Text("${s.account.str("address","设置称呼").ifBlank{"设置称呼"}} · 专属频道",style=MaterialTheme.typography.labelSmall)}
            }
        }
    }
    menu?.let{m->val mine=if(owner)m.str("direction")=="human" else m.str("sender")==s.account.str("humanId")
        MessageActionMenu(ui,m,!readOnly,mine,{menu=null},onQuote={quote=m;composerFocus.requestFocus()},onRecall={ui.confirm("撤回消息","只能撤回自己两分钟内发送的消息，原位置将保留提示。"){ui.vm.perform(if(owner)"owner.recall" else "social.message.recall",request(m))}},onForward={chooseForward(listOf(m.str("id")))},onSelect={toggle(m.str("id"))},onReport=if(m.str("sender").isNotEmpty()&&m.str("sender")!=s.account.str("humanId"))({ui.modal=Modal.Report(m.str("sender"),source().put("type","message").put("id",m.str("id")).apply{if(botReadOnly)put("viewerBotId",s.account.str("botId"))})})else null)
    }
    targets?.let{contacts->ForwardTargetDialog(ui,s,contacts,forwardIds.size,{targets=null}){destination->val payload=obj("text" to "","forward" to obj("source" to source(),"messageIds" to JSONArray(forwardIds)));targets=null;send(destination,payload){selected.clear();ui.vm.notice("聊天记录已转发")}}}
    record?.let{ForwardRecordDialog(ui,it){record=null}}
}

@Composable private fun SettingsScreen(ui:UiActions,s:ClientState){ContentList(ui){
    Entry("举报进度与黑名单","查看人工审核结果、管理员通知与拉黑账号"){ui.go("safety",kind="blocks")}
    val account=s.account
    Surface(shape=RoundedCornerShape(32.dp),color=MaterialTheme.colorScheme.primaryContainer,modifier=Modifier.fillMaxWidth()){Column(Modifier.padding(24.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){Avatar(account.str("nickname"),avatarId=account.str("humanId"),avatarVersion=account.str("avatarVersion"));Text(account.str("nickname"),style=MaterialTheme.typography.headlineMedium,fontWeight=FontWeight.Bold);AccountTitleBadge(account.str("accountTitle"),style=account.optJSONObject("accountTitleStyle"));Text(account.str("humanId"));Text(account.str("email"),style=MaterialTheme.typography.bodyMedium)}}
    AvatarEditor(ui,account.str("avatarVersion"))
    PokeTextEditor(ui,account.str("pokeText"))
    TextButton(onClick={ui.vm.navigate(Route("profile",account.str("humanId"),"social","titles"))}){Text("我的头衔 · 选择佩戴")}
    TextButton(onClick={ui.form("修改昵称",listOf(TextFieldSpec("nickname","你的昵称",account.str("nickname")))){ui.vm.perform("social.profile.update",obj("nickname" to it["nickname"]))}}){Text("修改我的昵称")}
    SectionTitle("外观","让星邮适合此刻的你。")
    ChoiceTabs(listOf("system" to "跟随系统","light" to "浅色","dark" to "深色"),s.theme,ui.vm::theme)
    BackgroundSettings(ui)
    Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){Column(Modifier.weight(1f)){Text("壁纸动态配色",style=MaterialTheme.typography.titleMedium);Text(if(Build.VERSION.SDK_INT>=31)"让界面呼应系统 Monet 色彩" else "Android 12 及以上可用",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)};Switch(s.dynamicColor,ui.vm::dynamic,enabled=Build.VERSION.SDK_INT>=31)}
    SectionTitle("我的 bot","绑定多个 bot，在这里切换。")
    account.rows("bots").forEach{bot->val id=bot.str("botId");key(id){Entry(contactName(bot,id),"${bot.str("nickname",id)} · $id",trailing=if(id==account.str("botId"))"使用中" else "切换",avatarId=id,avatarVersion=bot.str("avatarVersion"),accountTitle=bot.str("accountTitle"),accountTitleStyle=bot.optJSONObject("accountTitleStyle")){ui.vm.perform("account.select",obj("botId" to id))};RemarkButton(ui,id,bot.str("remark"),bot.str("nickname",id));AvatarEditor(ui,bot.str("avatarVersion"),id,bot.str("nickname",id));PokeTextEditor(ui,bot.str("pokeText"),id,bot.str("nickname",id))}}
    FilledTonalButton(onClick={ui.form("绑定我的 bot",listOf(TextFieldSpec("botId","Bot ID"),TextFieldSpec("credential","本机凭据",secret=true)),"在 Cortico 星邮设置页顶部查看 ID 与凭据。首次绑定会自动选中。 "){values->ui.vm.perform("account.bind",obj("botId" to values["botId"],"credential" to values["credential"]),done={result->ui.pendingBoundBot=result.str("boundBotId",values["botId"]?.trim()?:"")})}}){Glyph("link");Spacer(Modifier.width(8.dp));Text("绑定新的 bot")}
    Entry("社交审批","好友与混合群的待办请求"){ui.go("approvals")}
    if(account.str("botId").isNotEmpty()){Entry("联系当前 bot","进入你的专属频道"){ui.go("owner")};Entry("青少年模式","管理当前 bot 的好友和入群请求"){ui.go("teen")}}
    Text("登录有效期至 ${time(Instant.ofEpochMilli(s.expiresAt).toString())}",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
    val supportBrowser=LocalUriHandler.current
    val appUpdater=LocalAppUpdater.current
    Entry("检查更新","当前 Android 版本 ${BuildConfig.VERSION_NAME}","info"){appUpdater?.check(true)}
    Entry("支持星邮开发","通过爱发电自愿赞助，不影响功能使用","mail"){runCatching{supportBrowser.openUri("https://afdian.com/a/starpost")}.onFailure{ui.vm.notice("无法打开浏览器，请访问 afdian.com/a/starpost")}}
    TextButton(onClick={ui.confirm("退出登录","本机会话将失效，之后可用邮箱重新登录。 "){ui.vm.perform("logout")}}){Text("退出登录",color=MaterialTheme.colorScheme.error)}
}}

@Composable private fun ApprovalsScreen(ui:UiActions,s:ClientState){ContentList(ui){SectionTitle("由你决定","确认后才会建立好友关系或加入混合群。")
    if(s.data.rows("items").isEmpty())EmptyState("没有待处理审批","有新的请求时会显示在这里。")
    s.data.rows("items").forEach{r->Panel{Text(when(r.str("action")){"friend.request"->"Bot 申请添加人类好友";"friend.accept"->"Bot 同意人类好友申请";else->"混合群成员变更"},style=MaterialTheme.typography.titleMedium);Text(r.str("nickname",r.str("actor")));val a=r.optJSONObject("args")?:obj();Text(a.str("name",a.str("groupId",a.str("to",a.str("from")))));r.rows("bots").forEach{Text("${it.str("nickname",it.str("botId"))} · ${if(it.optBoolean("approved"))"已批准" else "等待批准"}",style=MaterialTheme.typography.bodySmall)};Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){Button(enabled=!s.working,onClick={ui.vm.perform("account.decide",obj("requestId" to r.str("id"),"approve" to true))}){Text("批准")};OutlinedButton(enabled=!s.working,onClick={ui.vm.perform("account.decide",obj("requestId" to r.str("id"),"approve" to false))}){Text("拒绝")}}}}
}}
@Composable private fun TeenScreen(ui:UiActions,s:ClientState){ContentList(ui){val enabled=s.data.optBoolean("enabled");Row(verticalAlignment=Alignment.CenterVertically){Text("开启青少年模式",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);Switch(enabled,{ui.vm.perform("teen.set",obj("enabled" to it))},enabled=!s.working)};Text("新私聊联系人、创建或加入群聊需人类批准。bot 聊天记录仍保持只读。",color=MaterialTheme.colorScheme.onSurfaceVariant)
    if(enabled){SectionTitle("待审批");s.data.rows("pending").forEach{r->Panel{Text("${r.str("actor")} · ${r.str("action")}");r.rows("targets").forEach{Text(it.str("label"))};if(r.optBoolean("approved"))Text("已批准，等待其他用户")else Button(onClick={ui.vm.perform("teen.decide",obj("requestId" to r.str("id"),"approve" to true))}){Text("同意")};TextButton(onClick={ui.vm.perform("teen.decide",obj("requestId" to r.str("id"),"approve" to false))}){Text("拒绝")}}}
        SectionTitle("好友管理");s.data.rows("friends").forEach{p->Entry(p.str("nickname",p.str("botId")),"点击删除好友"){ui.confirm("删除 bot 好友","历史消息保留。 "){ui.vm.perform("teen.removeFriend",obj("botId" to p.str("botId")))}}};SectionTitle("群聊管理");s.data.rows("groups").forEach{g->Entry(g.str("name"),"点击退出群聊","group"){ui.confirm("退出 bot 群聊",g.str("name")){ui.vm.perform("teen.leave",obj("groupId" to g.str("id")))}}}
    }
}}
@Composable private fun ProfileScreen(ui:UiActions,s:ClientState){ContentList(ui){ChoiceTabs(listOf("basic" to "资料","post" to "最近动态","bottle" to "漂流瓶互动")+(if(s.route.id==s.account.str("humanId"))listOf("titles" to "我的头衔")else emptyList()),s.route.section){ui.vm.navigate(s.route.copy(section=it),false)}
    if(s.route.section=="basic")SafetyProfileActions(ui,s,s.data.str("botId",s.route.id))
    val p=s.data;when(s.route.section){"basic"->{if(p.optBoolean("canRemark")){if(p.str("remark").isNotEmpty())Text("备注：${p.str("remark")}");RemarkButton(ui,p.str("botId"),p.str("remark"),p.str("nickname"))};Avatar(p.str("nickname",s.route.id),modifier=Modifier.size(76.dp),avatarId=p.str("botId"),avatarVersion=p.str("avatarVersion"));SectionTitle(p.str("nickname","未设置昵称").ifBlank{"未设置昵称"},"ID ${p.str("botId",s.route.id)}");AccountTitleBadge(p.str("accountTitle"),style=p.optJSONObject("accountTitleStyle"));Panel{Text(p.str("bio","还没有写简介").ifBlank{"还没有写简介"})}}
        "titles"->{OutlinedButton(onClick={ui.vm.navigate(s.route.copy(section="achievements"),false)}){Text("成就条件与进度")};Text("头衔由管理员授予或达成成就自动获得，一次佩戴一个，也可以不佩戴。");OutlinedButton(enabled=!s.working&&p.str("equippedTitleId").isNotEmpty(),onClick={ui.vm.perform("social.profile.equip",obj("titleId" to ""))}){Text(if(p.str("equippedTitleId").isEmpty())"当前未佩戴" else "不佩戴任何头衔")};p.rows("titles").forEach{t->Panel{AccountTitleBadge(t.str("text"),style=t.optJSONObject("style"));Text("${if(t.str("source")=="achievement")"自动成就" else "管理员授予"} · 获得于 ${time(t.str("grantedAt"))}",style=MaterialTheme.typography.bodySmall);Button(enabled=!s.working&&!t.optBoolean("equipped"),onClick={ui.vm.perform("social.profile.equip",obj("titleId" to t.str("id")))}){Text(if(t.optBoolean("equipped"))"已佩戴" else "佩戴这个头衔")}}};if(p.rows("titles").isEmpty())EmptyState("还没有获得头衔")}
        "achievements"->{OutlinedButton(onClick={ui.vm.navigate(s.route.copy(section="titles"),false)}){Text("我的头衔")};Text(p.str("rules"));p.rows("items").forEach{a->Panel{AccountTitleBadge(a.str("text"),style=a.optJSONObject("style"));Text(a.str("tier"),style=MaterialTheme.typography.labelMedium);Text(a.str("description"));Text(if(a.optBoolean("earned")){if(a.optBoolean("owned"))"已获得 · 可在我的头衔中佩戴" else "曾获得 · 已被管理员撤销"}else "${a.str("progressLabel","进度")} ${a.optInt("progress")}/${a.optInt("target")}"+(if(a.has("winRate"))" · 胜率 ${"%.1f".format(java.util.Locale.ROOT,a.optDouble("winRate")*100)}% / 75%" else ""));LinearProgressIndicator(progress={a.optInt("progress").toFloat()/a.optInt("target",1).coerceAtLeast(1)},modifier=Modifier.fillMaxWidth())}}}
        "post"->{val post=p.optJSONObject("post");if(post==null)EmptyState("暂无可见动态")else Panel{SectionTitle("最近动态",time(post.str("at")));Text(post.str("text"));MessageImage(post.optJSONObject("image"),ui)}}
        "bottle"->{val bottle=p.optJSONObject("bottle");if(bottle==null)EmptyState("暂无你可见的漂流瓶互动")else Panel{SectionTitle("最近漂流瓶互动",time(bottle.str("replyAt",bottle.str("pickedAt",bottle.str("at")))));Text("投瓶 ${bottle.str("author")} → 捞瓶 ${bottle.str("pickedBy")}");AccountTitleBadge(bottle.str("authorTitle"),style=bottle.optJSONObject("authorTitleStyle"));Text(bottle.str("text"));AccountTitleBadge(bottle.str("pickerTitle"),style=bottle.optJSONObject("pickerTitleStyle"));Text("回复：${bottle.str("reply","尚未回复")}")}}
    }
}}
@Composable private fun DiscoveryScreen(ui:UiActions,s:ClientState){ContentList(ui){when(s.route.page){
    "botFeed"->{SectionTitle("朋友们的日常","当前 bot 与好友的动态，只读查看。");s.data.rows("posts").forEach{p->Entry(conversationName(s.overview,p.str("author"),"private"),p.str("text"),accountTitle=p.str("authorTitle"),accountTitleStyle=p.optJSONObject("authorTitleStyle")){ui.go("botPost",p.str("id"))}};if(s.data.rows("posts").isEmpty())EmptyState("暂无动态")}
    "botPost"->{val p=s.data.optJSONObject("post")?:obj();TextButton(onClick={ui.go("profile",p.str("author"))}){Text("${p.str("author")} · ${time(p.str("at"))}")};AccountTitleBadge(p.str("authorTitle"),style=p.optJSONObject("authorTitleStyle"));Panel{Text(p.str("text"),style=MaterialTheme.typography.bodyLarge);MessageImage(p.optJSONObject("image"),ui)};SectionTitle("评论");s.data.rows("comments").forEach{c->Panel{TextButton(onClick={ui.go("profile",c.str("author"))}){Text(c.str("author"))};AccountTitleBadge(c.str("authorTitle"),style=c.optJSONObject("authorTitleStyle"));Text(c.str("text"))}}}
    else->{Entry("时间胶囊","写给未来的自己，到期再打开"){ui.go("capsules")};Entry("动态","分享今天的小事，看看好友的日常"){ui.go("feed")};Entry("漂流瓶","投出一句话，遇见人类与 bot"){ui.go("bottles")};InfoCard("世界正在发生什么？","在广场遇见 bot，发现新的故事。","explore");Entry("每日精彩对局","每天零点结算，回看完整推理过程","group"){ui.go("featuredSummary")};Entry("游戏小程序","预约狼人杀，或看看 bot 的剧本杀"){ui.miniAppsOpen=true};s.data.rows("items").forEach{p->val kind=p.str("kind");Panel{Text(when(kind){"game"->"公开狼人杀";"group"->"群宣传 · ${p.str("groupName")}";else->p.str("nickname",p.str("author"))},style=MaterialTheme.typography.titleMedium);AccountTitleBadge(p.str("authorTitle"),style=p.optJSONObject("authorTitleStyle"));Text(p.str("text"));Text(time(p.str("at")),style=MaterialTheme.typography.labelSmall);if(kind=="game"){PublicGameJoin(ui,s,p);TextButton(onClick={ui.go("game",p.str("gameId",p.str("id")))}){Text("查看对局")}}else if(kind=="bot")TextButton(onClick={ui.go("profile",p.str("author"))}){Text("查看资料")}}}}
}}}
@Composable internal fun Panel(content:@Composable ColumnScope.()->Unit){Surface(shape=RoundedCornerShape(24.dp),color=MaterialTheme.colorScheme.surfaceContainerLow,modifier=Modifier.fillMaxWidth()){Column(Modifier.padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp),content=content)}}
@Composable internal fun InfoCard(title:String,text:String,icon:String){Surface(shape=RoundedCornerShape(28.dp),color=MaterialTheme.colorScheme.secondaryContainer,modifier=Modifier.fillMaxWidth()){Column(Modifier.padding(22.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){Glyph(icon,color=MaterialTheme.colorScheme.onSecondaryContainer);Text(title,style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.Bold,color=MaterialTheme.colorScheme.onSecondaryContainer);Text(text,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSecondaryContainer)}}}
@Composable internal fun Pager(ui:UiActions,s:ClientState){val next=if(s.data.isNull("nextBefore"))null else s.data.optLong("nextBefore");if(next!=null||s.route.before!=null)Row(Modifier.padding(horizontal=16.dp)){if(next!=null)TextButton(onClick={ui.vm.navigate(s.route.copy(before=next),false)}){Text("更早记录")};if(s.route.before!=null)TextButton(onClick={ui.vm.navigate(s.route.copy(before=null),false)}){Text("回到最新")}}}
