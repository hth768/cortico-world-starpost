@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package io.starpost.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.time.*
import java.time.format.DateTimeFormatter

internal val roleNames=mapOf("wolf" to "狼人","witch" to "女巫","seer" to "预言家","guard" to "守卫","hunter" to "猎人","villager" to "平民")
internal val gameStates=mapOf("scheduled" to "预约中","assigning" to "分发身份","night_wolf" to "狼人行动","night_gods" to "神职行动","day" to "白天讨论","vote" to "公共投票","hunter" to "猎人行动","finished" to "结束 · 复盘","closed" to "已关闭","cancelled" to "已取消")
private fun roleSummary(roles:JSONObject?):String=roles?.keys()?.asSequence()?.map{key->val v=roles.opt(key);if(v is Number)"${roleNames[key]?:key} $v" else "$key · ${roleNames[v.toString()]?:v}"}?.joinToString("\n")?:""
private fun gameText(m:JSONObject):String {val kind=m.str("kind");if(m.str("gameType")=="mystery")return m.str("text",kind);return when(kind){
    "chat","left"->m.str("text")
    "role"->"身份：${roleNames[m.str("role")]?:m.str("role")}\n狼人队友：${m.strings("teammates").joinToString("、").ifBlank{"无"}}"
    "finished","assignments"->(if(kind=="finished")"游戏结束 · ${when(m.str("winner")){"wolves"->"狼人获胜";"village"->"好人获胜";else->"平局"}}" else "身份表")+"\n"+roleSummary(m.optJSONObject("roles"))
    "dawn"->"天亮了 · ${m.strings("deaths").joinToString("、").ifBlank{"平安夜"}}"
    "inspect_result"->"查验 ${m.str("target")}：${if(m.optBoolean("isWolf"))"狼人" else "非狼人"}"
    "witch_prompt"->"狼刀目标：${m.str("victim","无")}\n解药${if(m.optBoolean("saveAvailable"))"可用" else "不可用"} · 毒药${if(m.optBoolean("poisonAvailable"))"可用" else "不可用"}"
    "vote"->"${m.str("voter")} 投票给 ${m.str("target")}"
    "vote_result"->"投票结算 · ${if(m.optBoolean("tie"))"平票" else "出局：${m.str("eliminated","无")}"}\n"+(m.optJSONObject("votes")?.let{votes->votes.keys().asSequence().joinToString("\n"){"$it → ${votes.str(it,"弃权")}"}}?:"")
    "attack_vote"->"${m.str("botId")} 选择袭击 ${m.str("target")}"
    "hunter_shot"->"猎人 ${m.str("hunter")} 开枪：${m.str("target","跳过")}"
    "started"->"游戏开始\n"+roleSummary(m.optJSONObject("rules"))
    "forfeit"->"${m.str("botId")} 弃权出局"
    "vote_open"->"公共投票开始"
    "hunter_prompt","hunter_wait"->"等待猎人行动"
    else->m.str("text").ifBlank{"第 ${m.optInt("day")} 天 · ${gameStates[kind]?:"游戏状态更新"}"}
}}
private fun rulesText(game:JSONObject):String=roleSummary(game.optJSONObject("rules"))+"\n"+(game.optJSONObject("rulebook")?.let{r->r.keys().asSequence().flatMap{key->val v=r.opt(key);if(v is JSONObject)v.keys().asSequence().map{v.str(it)}else sequenceOf(v.toString())}.joinToString("\n")}?:"")
@Composable internal fun GameScreen(ui:UiActions,s:ClientState){when(s.route.page){
    "humanRoom"->HumanRoom(ui,s)
    "schedule"->ScheduleGame(ui,s)
    "gameInvite"->GameInvites(ui,s)
    else->ContentList(ui){when(s.route.page){
        "games"->{
            GameBanner(obj("title" to "今夜，来一场推理","status" to "scheduled"),"游戏大厅")
            Entry("我的 bot 对局","包含加入其他 bot 的预约、私密局与历史局"){ui.go("botGames",kind="own")}
            val rules=s.data.optJSONObject("rules")?:JSONObject();SectionTitle("狼人杀广场","${s.data.str("nickname")} · ${s.data.str("humanId")} · 今日 ${rules.optInt("usedToday")}/${rules.optInt("dailyLimit",5)} 局")
            val moderation=s.data.optJSONObject("moderation")?:JSONObject();if(moderation.str("message").isNotEmpty())Text(moderation.str("message"),color=MaterialTheme.colorScheme.error)
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){if(!moderation.optBoolean("banned"))Button(onClick={ui.go("schedule")}){Text("发起预约")};TextButton(onClick={ui.form("设置人类昵称",listOf(TextFieldSpec("nickname","昵称",s.data.str("nickname")))){ui.vm.perform("human.profile",obj("nickname" to it["nickname"]))}}){Text("修改昵称")}}
            val games=s.data.rows("games");if(games.isEmpty())EmptyState("还没有游戏预约","发起一局，等朋友们一起加入。")
            games.forEach{g->val joined=g.optBoolean("participant")||g.str("creator")==s.data.str("humanId");GameLobbyCard(g){if(joined)ui.go("humanReservation",g.str("gameId"))else if(g.str("status")=="scheduled"&&!moderation.optBoolean("banned"))ui.confirm("加入预约",g.str("title")){ui.vm.perform("human.join",obj("gameId" to g.str("gameId")),Route("humanReservation",g.str("gameId")))}else if(g.optBoolean("public")&&!moderation.optBoolean("banned"))ui.go("game",g.str("gameId"))else ui.vm.notice("当前无法加入此预约")}}

        }
        "gameRecord"->{
            val id=s.route.id.ifBlank{s.account.str("humanId")};var query by rememberSaveable(id){mutableStateOf(id)}
            SectionTitle("游戏战绩","狼人杀战绩与最近 3 场对局，人类和 bot 分别统计。")
            ChoiceTabs(listOf(s.account.str("humanId") to "我自己")+s.account.rows("bots").map{it.str("botId") to it.str("nickname",it.str("botId"))},id){ui.vm.navigate(s.route.copy(id=it),false)}
            OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),label={Text("查看其他账号 ID")},singleLine=true)
            TextButton(onClick={ui.vm.navigate(s.route.copy(id=query.trim()),false)}){Text("查看账号战绩")}
            ChoiceTabs(listOf("record" to "狼人杀战绩","recent" to "最近 3 场对局"),if(s.route.section=="basic")"record" else s.route.section){ui.vm.navigate(s.route.copy(section=it),false)}
            if(s.route.section!="recent")Panel{Text("胜 ${s.data.optInt("wins")} · 负 ${s.data.optInt("losses")} · 平 ${s.data.optInt("draws")}")}
            else{if(s.data.rows("games").isEmpty())EmptyState("暂无完赛记录");s.data.rows("games").forEach{g->Entry(g.str("title"),"${time(g.str("at"))} · ${when(g.str("result")){"win"->"胜";"loss"->"负";else->"平"}}"){if(g.has("gameId")){if(id==s.account.str("humanId"))ui.go("humanReservation",g.str("gameId"))else if(id!=s.account.str("botId")&&s.account.rows("bots").any{it.str("botId")==id})ui.vm.perform("account.select",obj("botId" to id),Route("game",g.str("gameId")))else ui.go("game",g.str("gameId"))}}}}
        }
        "botGames"->{ChoiceTabs(listOf("own" to "我的 bot 对局","public" to "公开对局"),s.route.kind){ui.vm.navigate(Route("botGames",kind=it),false)};Pager(ui,s)
            if(s.data.rows("items").isEmpty())EmptyState("暂无对局记录","预约、已开始和已结束的对局都会显示在这里。")
            var filter by rememberSaveable(s.route.id){mutableStateOf(if(s.route.id=="mystery")"mystery" else "all")}
            ChoiceTabs(listOf("all" to "全部","werewolf" to "狼人杀","mystery" to "剧本杀"),filter){filter=it}
            if(filter=="mystery")Text("剧本杀目前仅供 bot 参赛，你可以在这里观看公开对局。")
            s.data.rows("items").filter{filter=="all" || (if(it.str("gameType")=="mystery")"mystery" else "werewolf")==filter}.forEach{g->GameLobbyCard(g){ui.go("game",g.str("gameId"))}}

        }
        "featuredSummary"->{SectionTitle("每日精彩对局","北京时间每天 00:00 结算前一日。");Text(if(s.data.optBoolean("published"))"${s.data.str("date")} · 共开局 ${s.data.optInt("totalGames")} 场" else "当天统计尚未发布");val f=s.data.optJSONObject("featured");if(f!=null)Entry(f.str("title"),"最长公开完赛局 · ${f.optLong("durationMs")/60000} 分钟"){ui.go("featured",f.str("gameId"))}else EmptyState("暂无精彩对局","完赛的公开对局参与每日选取。")}
        "humanReservation"->{val g=s.data.optJSONObject("game")?:JSONObject();GameBanner(g,if(g.str("status")=="scheduled")"预约房间" else "个人回放",s.data.str("serverNow"));Text("北京时间 · ${time(g.str("scheduledAt"))}");GameSeatBoard(g,s.data.str("humanId"));TextButton(onClick={ui.confirm("本局规则",rulesText(g)) {}}){Text("查看规则")};if(g.optBoolean("canInvite"))Button(enabled=!s.working,onClick={ui.go("gameInvite",s.route.id)}){Text("邀请好友 / 群成员")};if(g.str("status")=="scheduled"){Button(enabled=!s.working,onClick={ui.vm.perform("human.checkin",obj("gameId" to s.route.id))}){Text("集合报到")};OutlinedButton(onClick={ui.confirm("退出预约",g.str("title")){ui.vm.perform("human.leave",obj("gameId" to s.route.id),Route("games"))}}){Text("退出预约")};if(g.str("creator")==s.data.str("humanId"))TextButton(onClick={ui.confirm("取消本局","所有预约参与者都会看到取消结果。 "){ui.vm.perform("human.cancel",obj("gameId" to s.route.id),Route("games"))}}){Text("取消本局",color=MaterialTheme.colorScheme.error)}}else{Pager(ui,s);GameMessages(ui,s.data.rows("messages"))}}
        else->{val g=s.data.optJSONObject(if(s.route.page=="featured")"featured" else "game")?:JSONObject();if(s.route.page=="featured")Text("${s.data.str("date")} · 当日 ${s.data.optInt("totalGames")} 场 · ${g.optLong("durationMs")/60000} 分钟",style=MaterialTheme.typography.bodyMedium);GameBanner(g,"只读观战 / 回放",s.data.str("serverNow"));if(s.route.page!="featured")GameSeatBoard(g);Text("对局过程 · 只读查看",style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant);Pager(ui,s);GameMessages(ui,s.data.rows("messages"))}
    }}
}}
@Composable private fun GameMessages(ui:UiActions,messages:List<JSONObject>){messages.forEach{GameMessage(ui,it)}}
@Composable private fun GameInvites(ui:UiActions,s:ClientState){
    var kind by rememberSaveable(s.route.id){mutableStateOf("private")}
    ContentList(ui){
        SectionTitle("邀请朋友一起玩","公开或私密预约都能邀请；对方自行决定是否加入和报到。")
        ChoiceTabs(listOf("private" to "好友 / 我的 bot","group" to "群成员"),kind){kind=it}
        val rows=if(kind=="group")s.data.rows("groups")else(s.data.rows("friendProfiles")+s.account.rows("bots")).distinctBy{it.str("botId")}
        if(rows.isEmpty())EmptyState("暂无可邀请对象",if(kind=="group")"加入群聊后可邀请群成员。" else "添加好友或绑定自己的 bot 后可发出邀请。")
        rows.forEach{p->val id=p.str(if(kind=="group")"id" else "botId");val label=p.str(if(kind=="group")"name" else "nickname",id)
            Entry(label,if(kind=="group")"邀请这个群的成员 · $id" else "邀请参加本局 · $id"){
                if(!s.working)ui.confirm("发出游戏邀请",if(kind=="group")"向「$label」的群成员发送本局邀请？" else "邀请「$label」加入本局？"){
                    ui.vm.perform("human.invite",obj("gameId" to s.route.id,"sourceKind" to kind,"sourceTarget" to id),Route("humanReservation",s.route.id)){r->ui.vm.notice(if(r.optInt("invited")>0)"已邀请 ${r.optInt("invited")} 位成员，等待对方加入" else "没有新的可邀请成员，可能已受邀或已加入")}
                }
            }
        }
    }
}
@Composable private fun HumanRoom(ui:UiActions,s:ClientState){
    val g=s.data.optJSONObject("game")?:JSONObject();var draft by rememberSaveable(s.route.id){mutableStateOf("")};val channels=s.data.strings("channels");var channel by rememberSaveable(s.route.id){mutableStateOf("public")};LaunchedEffect(channels){if(channel !in channels)channel=channels.firstOrNull()?:"public"}
    val messages=s.data.rows("messages");val list=rememberLazyListState();var tab by rememberSaveable(s.route.id){mutableStateOf("board")}
    var action by remember(s.route.id){mutableStateOf<JSONObject?>(null)};var actionPhase by remember(s.route.id){mutableStateOf("")}
    LaunchedEffect(messages.lastOrNull()?.str("id")){if(s.route.before==null&&!list.canScrollForward&&messages.isNotEmpty())list.animateScrollToItem(messages.size-1)}
    Column(Modifier.fillMaxSize()){
        Box(Modifier.padding(horizontal=12.dp,vertical=6.dp)){GameBanner(g,"参赛中",s.data.str("serverNow"),compact=true)}
        Box(Modifier.padding(horizontal=16.dp)){ChoiceTabs(listOf("board" to "牌桌","discussion" to "讨论记录"),tab){tab=it}}
        if(tab=="board")Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(14.dp)){
            GameRoleCard(g)
            listOfNotNull(messages.lastOrNull{it.str("channel")=="private"&&it.str("kind")!="role"},messages.lastOrNull{it.str("channel")!="private"&&it.str("kind")!="role"}).forEach{m->
                OutlinedCard(onClick={tab="discussion"},modifier=Modifier.fillMaxWidth(),shape=androidx.compose.foundation.shape.RoundedCornerShape(20.dp)){
                    Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
                        Text("${if(m.str("channel")=="private")"最近私密通知" else "最新消息"} · ${if(m.str("sender")=="system")"星邮法官" else m.str("senderNickname",m.str("sender"))}",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.primary)
                        Text(gameText(m),style=MaterialTheme.typography.bodySmall,maxLines=2,overflow=androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                        Text("查看讨论记录 →",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            GameSeatBoard(g,s.data.str("humanId",s.account.str("humanId")))
            TextButton(onClick={ui.confirm("本局规则",rulesText(g)) {}}){Text("查看规则")}
            Text(if(channels.isNotEmpty())"切换到讨论记录，查看其他玩家的发言。" else "当前阶段暂不可发言，可在讨论记录中查看法官通知。",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
        }else Column(Modifier.weight(1f)){Pager(ui,s);LazyColumn(state=list,modifier=Modifier.weight(1f),contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){items(messages,key={it.str("id",it.toString())}){m->GameMessage(ui,m,m.str("sender")==s.account.str("humanId"))}}}
        Surface(color=MaterialTheme.colorScheme.surfaceContainerLow){Column(Modifier.padding(horizontal=16.dp,vertical=8.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
            if(s.data.rows("options").isNotEmpty())Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)){
                s.data.rows("options").forEach{o->FilledTonalButton(enabled=!s.working&&o.rows("targets").isNotEmpty(),onClick={action=o;actionPhase=gamePhaseKey(g)}){Text(o.str("label"))}}
            }else Text(if(channels.isNotEmpty())"轮到讨论 · 说出你的判断" else "当前没有可用行动，等待法官推进。",style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
            if(channels.isNotEmpty()){
                if(channels.size>1)ChoiceTabs(channels.map{it to if(it=="wolf")"狼人频道" else "公共频道"},channel){channel=it}
                else Text(if(channel=="wolf")"狼人频道 · 仅队友可见" else "公共频道",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.primary)
                Row(verticalAlignment=Alignment.Bottom,horizontalArrangement=Arrangement.spacedBy(8.dp)){OutlinedTextField(draft,{draft=it.take(1000)},Modifier.weight(1f),placeholder={Text("说出你的推理…")},maxLines=3);FilledIconButton(enabled=!s.working&&draft.isNotBlank(),onClick={val sent=draft;ui.vm.perform("human.message",obj("gameId" to s.route.id,"channel" to channel,"text" to sent)){r->if(r.optBoolean("rejected"))ui.vm.notice(r.optJSONObject("moderation")?.str("message")?:"发言未通过")else if(draft==sent)draft=""}}){Glyph("send","发送游戏发言")}}
            }
            s.data.optJSONObject("moderation")?.str("message")?.takeIf{it.isNotEmpty()}?.let{Text(it,color=MaterialTheme.colorScheme.error)}
        }}
    }
    action?.let{o->val current=s.data.rows("options").find{it.str("move")==o.str("move")};val valid=actionPhase==gamePhaseKey(g)
        GameTargetDialog(o,current,valid,s.working,onDismiss={action=null}){target->
            if(valid&&current?.rows("targets")?.any{it.str("id")==target}==true&&!s.working){action=null;ui.vm.perform("human.move",obj("gameId" to s.route.id,"move" to o.str("move"),"target" to target,"expectedPhase" to obj("status" to g.str("status"),"day" to g.optInt("day"),"deadlineAt" to g.str("phaseDeadlineAt"))))}
        }
    }
}
@Composable private fun GameMessage(ui:UiActions,m:JSONObject,mine:Boolean=false){
    val lane=mapOf("public" to "公共","private" to "私密","wolf" to "狼人","judge" to "法官","outside" to "局外")[m.str("channel")]?:m.str("channel")
    if(m.str("sender")=="system")Surface(shape=androidx.compose.foundation.shape.RoundedCornerShape(20.dp),color=MaterialTheme.colorScheme.secondaryContainer,modifier=Modifier.fillMaxWidth()){
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){Text("✦ 星邮法官 · $lane · ${time(m.str("at"))}",style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSecondaryContainer);Text(gameText(m),style=MaterialTheme.typography.bodyMedium)}
    }else Bubble(ui,m,mine,text=gameText(m),label="${m.str("senderNickname",m.str("sender"))} · $lane")
}
@Composable private fun ScheduleGame(ui:UiActions,s:ClientState){
    var title by rememberSaveable{mutableStateOf("")};var count by rememberSaveable{mutableStateOf("6")};var custom by rememberSaveable{mutableStateOf("")};var public by rememberSaveable{mutableStateOf(true)}
    var at by rememberSaveable{mutableLongStateOf(Instant.now().plusSeconds(600).toEpochMilli())};var showDate by remember{mutableStateOf(false)};var showTime by remember{mutableStateOf(false)};var chosenDate by remember{mutableStateOf(LocalDate.now(ZoneId.of("Asia/Shanghai")))}
    ContentList(ui){SectionTitle("约一场认真推理","到约定时间前 3 分钟，请记得集合报到。")
        OutlinedTextField(title,{title=it},Modifier.fillMaxWidth(),label={Text("预约标题")},singleLine=true)
        OutlinedButton(onClick={showDate=true},modifier=Modifier.fillMaxWidth()){Text("北京时间 · ${time(Instant.ofEpochMilli(at).toString())}")}
        ChoiceTabs(listOf("6" to "6 人","8" to "8 人","10" to "10 人","12" to "12 人"),count){count=it}
        OutlinedTextField(count,{count=it.filter(Char::isDigit).take(2)},Modifier.fillMaxWidth(),label={Text("人数（6–20）")},singleLine=true)
        Row(verticalAlignment=Alignment.CenterVertically){Text("公开并公告到广场",Modifier.weight(1f));Switch(public,{public=it})}
        OutlinedTextField(custom,{custom=it},Modifier.fillMaxWidth(),label={Text("自定义身份（选填）")},supportingText={Text("狼,巫,预,守,猎,民，例如 2,1,1,0,0,4")})
        Text("每天最多 5 局。北京时间周末全天可开局，工作日 06–09、12–14、18–24；私密预约可通过自己的 bot 邀请朋友。",style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
        Button(enabled=!s.working,onClick={runCatching{
            val players=count.toInt();require(players in 6..20){"人数须在 6–20 之间"}
            val args=obj("title" to title.ifBlank{"一起玩狼人杀"},"scheduledAt" to Instant.ofEpochMilli(at).toString(),"maxPlayers" to players,"public" to public)
            if(custom.isNotBlank()){val values=custom.split(',','，').map{it.trim().toInt()};require(values.size==6&&values.all{it>=0}){"请填写六个非负整数"};args.put("roles",JSONObject().apply{listOf("wolf","witch","seer","guard","hunter","villager").forEachIndexed{i,k->put(k,values[i])}})}
            ui.vm.perform("human.schedule",args,Route("games"))
        }.onFailure{ui.vm.notice(it.message?:"请检查预约内容")}}){Text("发起预约")}
    }
    if(showDate){val dateState=rememberDatePickerState(initialSelectedDateMillis=Instant.ofEpochMilli(at).atZone(ZoneId.of("Asia/Shanghai")).toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli());DatePickerDialog(onDismissRequest={showDate=false},confirmButton={TextButton(onClick={dateState.selectedDateMillis?.let{chosenDate=Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate();showDate=false;showTime=true}}){Text("选择时间")}},dismissButton={TextButton(onClick={showDate=false}){Text("取消")}}){DatePicker(dateState)}}
    if(showTime){val local=Instant.ofEpochMilli(at).atZone(ZoneId.of("Asia/Shanghai"));val timeState=rememberTimePickerState(local.hour,local.minute,true);AlertDialog(onDismissRequest={showTime=false},title={Text("北京时间")},text={TimePicker(timeState)},confirmButton={TextButton(onClick={at=chosenDate.atTime(timeState.hour,timeState.minute).atZone(ZoneId.of("Asia/Shanghai")).toInstant().toEpochMilli();showTime=false}){Text("确定")}},dismissButton={TextButton(onClick={showTime=false}){Text("取消")}})}
}
