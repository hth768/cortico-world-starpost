@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package io.starpost.mobile

import androidx.compose.foundation.layout.*
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
    else->ContentList(ui){when(s.route.page){
        "games"->{
            Entry("我的 bot 对局","包含加入其他 bot 的预约、私密局与历史局"){ui.go("botGames",kind="own")}
            val rules=s.data.optJSONObject("rules")?:JSONObject();SectionTitle("狼人杀广场","${s.data.str("nickname")} · ${s.data.str("humanId")} · 今日 ${rules.optInt("usedToday")}/${rules.optInt("dailyLimit",5)} 局")
            val moderation=s.data.optJSONObject("moderation")?:JSONObject();if(moderation.str("message").isNotEmpty())Text(moderation.str("message"),color=MaterialTheme.colorScheme.error)
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){if(!moderation.optBoolean("banned"))Button(onClick={ui.go("schedule")}){Text("发起预约")};TextButton(onClick={ui.form("设置人类昵称",listOf(TextFieldSpec("nickname","昵称",s.data.str("nickname")))){ui.vm.perform("human.profile",obj("nickname" to it["nickname"]))}}){Text("修改昵称")}}
            val games=s.data.rows("games");if(games.isEmpty())EmptyState("还没有游戏预约","发起一局，等朋友们一起加入。")
            games.forEach{g->val joined=g.optBoolean("participant")||g.str("creator")==s.data.str("humanId");Entry(g.str("title"),"${gameStates[g.str("status")]?:g.str("status")} · ${time(g.str("scheduledAt"))}\n${g.optInt("joined")} / ${g.optInt("maxPlayers")} 人"){if(joined)ui.go("humanReservation",g.str("gameId"))else if(g.str("status")=="scheduled"&&!moderation.optBoolean("banned"))ui.confirm("加入预约",g.str("title")){ui.vm.perform("human.join",obj("gameId" to g.str("gameId")),Route("humanReservation",g.str("gameId")))}}}
        }
        "botGames"->{ChoiceTabs(listOf("own" to "我的 bot 对局","public" to "公开对局"),s.route.kind){ui.vm.navigate(Route("botGames",kind=it),false)};Pager(ui,s)
            if(s.data.rows("items").isEmpty())EmptyState("暂无对局记录","预约、已开始和已结束的对局都会显示在这里。")
            s.data.rows("items").forEach{g->Entry("${if(g.str("gameType")=="mystery")"剧本杀" else "狼人杀"} · ${g.str("title")}","${gameStates[g.str("status")]?:g.str("status")} · ${time(g.str("scheduledAt"))} · ${if(g.optBoolean("public"))"公开" else "私密"}"){ui.go("game",g.str("gameId"))}}
        }
        "featuredSummary"->{SectionTitle("每日精彩对局","北京时间每天 00:00 结算前一日。");Text(if(s.data.optBoolean("published"))"${s.data.str("date")} · 共开局 ${s.data.optInt("totalGames")} 场" else "当天统计尚未发布");val f=s.data.optJSONObject("featured");if(f!=null)Entry(f.str("title"),"最长公开完赛局 · ${f.optLong("durationMs")/60000} 分钟"){ui.go("featured",f.str("gameId"))}else EmptyState("暂无精彩对局","完赛的公开对局参与每日选取。")}
        "humanReservation"->{val g=s.data.optJSONObject("game")?:JSONObject();SectionTitle(g.str("title"),"${gameStates[g.str("status")]?:g.str("status")} · ${time(g.str("scheduledAt"))} · 已报到 ${g.optInt("checkedIn")} 人");Panel{Text(rulesText(g))};if(g.str("status")=="scheduled"){Button(enabled=!s.working,onClick={ui.vm.perform("human.checkin",obj("gameId" to s.route.id))}){Text("集合报到")};OutlinedButton(onClick={ui.confirm("退出预约",g.str("title")){ui.vm.perform("human.leave",obj("gameId" to s.route.id),Route("games"))}}){Text("退出预约")};if(g.str("creator")==s.data.str("humanId"))TextButton(onClick={ui.confirm("取消本局","所有预约参与者都会看到取消结果。 "){ui.vm.perform("human.cancel",obj("gameId" to s.route.id),Route("games"))}}){Text("取消本局",color=MaterialTheme.colorScheme.error)}}else{Pager(ui,s);GameMessages(ui,s.data.rows("messages"))}}
        else->{val g=s.data.optJSONObject(if(s.route.page=="featured")"featured" else "game")?:JSONObject();SectionTitle(g.str("title"),if(s.route.page=="featured")"${s.data.str("date")} · 当日 ${s.data.optInt("totalGames")} 场 · ${g.optLong("durationMs")/60000} 分钟"else "${if(g.str("gameType")=="mystery")"剧本杀" else "狼人杀"} · ${gameStates[g.str("status")]?:g.str("status")}");Text("对局过程 · 只读查看",style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant);Pager(ui,s);GameMessages(ui,s.data.rows("messages"))}
    }}
}}
@Composable private fun GameMessages(ui:UiActions,messages:List<JSONObject>){messages.forEach{m->val channel=mapOf("public" to "公共","private" to "私密","wolf" to "狼人","judge" to "法官","outside" to "局外")[m.str("channel")]?:m.str("channel");Bubble(ui,m,false,text=gameText(m),label="${m.str("senderNickname",m.str("sender"))} · $channel")}}
@Composable private fun HumanRoom(ui:UiActions,s:ClientState){
    val g=s.data.optJSONObject("game")?:JSONObject();var draft by rememberSaveable(s.route.id){mutableStateOf("")};val channels=s.data.strings("channels");var channel by rememberSaveable(s.route.id){mutableStateOf("public")};LaunchedEffect(channels){if(channel !in channels)channel=channels.firstOrNull()?:"public"}
    val messages=s.data.rows("messages");val list=rememberLazyListState()
    LaunchedEffect(messages.lastOrNull()?.str("id")){if(s.route.before==null&&!list.canScrollForward&&messages.isNotEmpty())list.animateScrollToItem(messages.size-1)}
    Column(Modifier.fillMaxSize()){
        Surface(color=MaterialTheme.colorScheme.tertiaryContainer,modifier=Modifier.fillMaxWidth()){Column(Modifier.padding(horizontal=20.dp,vertical=12.dp)){Text("${g.str("title")} · 第 ${g.optInt("day")} 天",style=MaterialTheme.typography.titleMedium);Text("${roleNames[g.str("ownRole")]?:"等待身份"} · ${gameStates[g.str("status")]?:g.str("status")} · 截止 ${time(g.str("phaseDeadlineAt"))}",style=MaterialTheme.typography.bodyMedium);TextButton(onClick={ui.confirm("本局规则",rulesText(g)) {}}){Text("查看规则")}}}
        Pager(ui,s)
        LazyColumn(state=list,modifier=Modifier.weight(1f),contentPadding=PaddingValues(20.dp),verticalArrangement=Arrangement.spacedBy(14.dp)){items(messages,key={it.str("id",it.toString())}){m->Bubble(ui,m,m.str("sender")==s.account.str("humanId"),text=gameText(m),label="${m.str("senderNickname",m.str("sender"))} · ${if(m.str("channel")=="wolf")"狼人" else if(m.str("channel")=="private")"私密" else "公共"}")}}
        Column(Modifier.padding(horizontal=16.dp,vertical=8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
            s.data.rows("options").forEach{o->var selected by remember(o.toString()){mutableStateOf(o.rows("targets").firstOrNull()?.str("id")?:"")};var expanded by remember{mutableStateOf(false)}
                Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)){Box(Modifier.weight(1f)){OutlinedButton(onClick={expanded=true},modifier=Modifier.fillMaxWidth()){Text(o.rows("targets").find{it.str("id")==selected}?.let{"${it.str("nickname")} ${it.str("id")}"}?:"选择目标");Glyph("down")};DropdownMenu(expanded,{expanded=false}){o.rows("targets").forEach{t->DropdownMenuItem(text={Text("${t.str("nickname")} ${t.str("id")}")},onClick={selected=t.str("id");expanded=false})}}};FilledTonalButton(enabled=!s.working&&o.rows("targets").isNotEmpty(),onClick={ui.confirm(o.str("label"),"确认目标：${selected.ifBlank{"跳过"}}？"){ui.vm.perform("human.move",obj("gameId" to s.route.id,"move" to o.str("move"),"target" to selected))}}){Text(o.str("label"))}}
            }
            if(channels.isNotEmpty()){ChoiceTabs(channels.map{it to if(it=="wolf")"狼人频道" else "公共频道"},channel){channel=it};Row(verticalAlignment=Alignment.Bottom,horizontalArrangement=Arrangement.spacedBy(8.dp)){OutlinedTextField(draft,{draft=it.take(1000)},Modifier.weight(1f),placeholder={Text("说出你的推理…")},maxLines=3);FilledIconButton(enabled=!s.working&&draft.isNotBlank(),onClick={val sent=draft;ui.vm.perform("human.message",obj("gameId" to s.route.id,"channel" to channel,"text" to sent)){r->if(r.optBoolean("rejected"))ui.vm.notice(r.optJSONObject("moderation")?.str("message")?:"发言未通过")else if(draft==sent)draft=""}}){Glyph("send","发送游戏发言")}}}
            else Text("本阶段暂不可发言，等待法官推进。",style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
            s.data.optJSONObject("moderation")?.str("message")?.takeIf{it.isNotEmpty()}?.let{Text(it,color=MaterialTheme.colorScheme.error)}
        }
    }
}
@Composable private fun ScheduleGame(ui:UiActions,s:ClientState){
    var title by rememberSaveable{mutableStateOf("")};var count by rememberSaveable{mutableStateOf("6")};var custom by rememberSaveable{mutableStateOf("")};var public by rememberSaveable{mutableStateOf(true)}
    var at by rememberSaveable{mutableLongStateOf(Instant.now().plusSeconds(600).toEpochMilli())};var showDate by remember{mutableStateOf(false)};var showTime by remember{mutableStateOf(false)};var chosenDate by remember{mutableStateOf(LocalDate.now(ZoneId.of("Asia/Shanghai")))}
    ContentList(ui){SectionTitle("约一场认真推理","到约定时间前 3 分钟，请记得集合报到。")
        OutlinedTextField(title,{title=it},Modifier.fillMaxWidth(),label={Text("预约标题")},singleLine=true)
        OutlinedButton(onClick={showDate=true},modifier=Modifier.fillMaxWidth()){Text("北京时间 · ${time(Instant.ofEpochMilli(at).toString())}")}
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
