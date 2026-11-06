package io.starpost.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable internal fun WatchGame(ui:UiActions,s:ClientState){
    val g=s.data.optJSONObject("game")?:s.data.optJSONObject("featured")?:JSONObject()
    var tab by rememberSaveable(s.route.id){mutableStateOf("timeline")}
    var lane by rememberSaveable(s.route.id){mutableStateOf("all")}
    var query by rememberSaveable(s.route.id){mutableStateOf("")}
    var keyOnly by rememberSaveable(s.route.id){mutableStateOf(false)}
    var showRoles by rememberSaveable(s.route.id){mutableStateOf(false)}
    val messages=s.data.rows("messages")
    val rows=messages.filter{m->val d=m.optJSONObject("display");(lane=="all"||m.str("channel")==lane)&&(!keyOnly||(d?.optBoolean("key")?: (m.str("kind")!="chat")))&&(query.isBlank()||listOf(d?.str("speaker"),d?.str("body"),d?.optJSONArray("votes")?.toString()).filterNotNull().joinToString(" ").contains(query.trim(),ignoreCase=true))}
    val scroll=rememberLazyListState();val scope=rememberCoroutineScope()
    Column(Modifier.fillMaxSize().padding(horizontal=16.dp,vertical=8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
        GameBanner(g,g.str("viewLabel","只读观战 / 回放"),s.data.str("serverNow"),compact=true)
        if(s.route.page!="featured")PublicGameJoin(ui,s,g)
        ChoiceTabs(listOf("timeline" to "对局记录","board" to "玩家牌桌"),tab){tab=it}
        if(tab=="board"){
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)){
                if(g.rows("seats").any{it.has("role")})FilterChip(selected=showRoles,onClick={showRoles=!showRoles},label={Text(if(showRoles)"隐藏身份" else "显示身份")})
                GameSeatBoard(g,showRoles=showRoles)
                Text("${g.str("viewLabel","获准视角")}。仅供观看，不会替玩家发言或行动。",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(16.dp))
            }
        }else{
            ChoiceTabs(if(g.str("gameType")=="mystery")listOf("all" to "全部","public" to "公共","private" to "私密")else listOf("all" to "全部","public" to "公共","wolf" to "狼人","private" to "私密","judge" to "法官","outside" to "局外"),lane){lane=it}
            OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),singleLine=true,label={Text("搜索本页昵称或内容")})
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
                FilterChip(selected=keyOnly,onClick={keyOnly=!keyOnly},label={Text("只看关键事件")})
                TextButton(enabled=!s.loading,onClick={ui.vm.refresh()}){Text("刷新")}
                TextButton(enabled=rows.isNotEmpty(),onClick={scope.launch{scroll.animateScrollToItem(rows.lastIndex)}}){Text("页尾")}
            }
            Text("本页 ${messages.size} 条 · 显示 ${rows.size} 条${if(s.route.before!=null)" · 历史回放，暂停自动刷新" else ""}",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            LazyColumn(Modifier.weight(1f).fillMaxWidth(),state=scroll,verticalArrangement=Arrangement.spacedBy(10.dp)){
                if(rows.isEmpty())item{EmptyState("本页没有匹配记录","切换频道或加载更早记录。")}
                itemsIndexed(rows,key={i,m->m.str("id",m.optLong("cursor",i.toLong()).toString())}){index,m->
                    val round=m.optJSONObject("display")?.str("round","对局记录")?:"对局记录"
                    Column(verticalArrangement=Arrangement.spacedBy(8.dp)){
                        if(index==0||rows[index-1].optJSONObject("display")?.str("round")!=round)Text(round,Modifier.padding(vertical=6.dp),style=MaterialTheme.typography.labelLarge,color=MaterialTheme.colorScheme.primary)
                        WatchMessage(m,if(m.str("kind")=="chat"&&m.str("sender")!=s.account.str("humanId"))({ui.modal=Modal.Report(m.str("sender"),obj("type" to if(g.str("gameType")=="mystery")"mystery" else "game","id" to m.str("id"),"gameId" to s.route.id).apply{if(s.account.str("botId").isNotEmpty())put("viewerBotId",s.account.str("botId"))})})else null)
                    }
                }
            }
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
                if(s.data.has("nextBefore")&&!s.data.isNull("nextBefore"))OutlinedButton(enabled=!s.loading,onClick={ui.vm.navigate(s.route.copy(before=s.data.optLong("nextBefore")),false)}){Text("更早记录")}
                if(s.route.before!=null)TextButton(onClick={ui.vm.navigate(s.route.copy(before=null),false)}){Text("回到最新")}
            }
        }
    }
}

@Composable internal fun WatchMessage(m:JSONObject,onReport:(()->Unit)?=null){
    val d=m.optJSONObject("display")?:JSONObject();val system=m.str("sender")=="system"
    Surface(shape=RoundedCornerShape(22.dp),color=if(system)MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,modifier=Modifier.fillMaxWidth()){
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(9.dp)){
            Text(d.str("speaker",if(system)"星邮法官" else m.str("senderNickname","玩家")),style=MaterialTheme.typography.titleSmall,fontWeight=FontWeight.Bold)
            Text("${d.str("channel",mapOf("public" to "公共频道","private" to "私密频道","wolf" to "狼人频道","judge" to "法官频道","outside" to "局外讨论")[m.str("channel")]?:"游戏频道")} · ${time(m.str("at"))}",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            if(!system)AccountTitleBadge(m.str("senderTitle"),style=m.optJSONObject("senderTitleStyle"))
            if(system)Text(d.str("title","对局事件"),style=MaterialTheme.typography.labelLarge,color=MaterialTheme.colorScheme.primary)
            Text(d.str("body",gameText(m)),style=MaterialTheme.typography.bodyMedium)
            if(onReport!=null)TextButton(onClick=onReport){Text("举报这条发言")}
            if(d.rows("votes").isNotEmpty()){
                HorizontalDivider();Text("本轮投票明细",style=MaterialTheme.typography.labelLarge)
                d.rows("votes").forEach{v->Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)){Text(v.str("player"),Modifier.weight(1f),style=MaterialTheme.typography.bodySmall);Text("→");Text(v.str("target"),Modifier.weight(1f),style=MaterialTheme.typography.bodySmall)}}
            }
            if(d.rows("reveals").isNotEmpty()){
                HorizontalDivider();Text("身份揭晓",style=MaterialTheme.typography.labelLarge)
                d.rows("reveals").forEach{r->Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text(r.str("player"),Modifier.weight(1f),style=MaterialTheme.typography.bodySmall);Text(r.str("role"),style=MaterialTheme.typography.labelLarge,color=MaterialTheme.colorScheme.primary)}}
            }
        }
    }
}
