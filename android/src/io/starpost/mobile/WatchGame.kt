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
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun WatchGame(ui: UiActions, s: ClientState) {
    val game = s.data.optJSONObject("game") ?: s.data.optJSONObject("featured") ?: JSONObject()
    val gameId = game.str("gameId", s.route.id)
    var tab by rememberSaveable(gameId) { mutableStateOf("timeline") }
    var lane by rememberSaveable(gameId) { mutableStateOf("all") }
    var query by rememberSaveable(gameId) { mutableStateOf("") }
    var keyOnly by rememberSaveable(gameId) { mutableStateOf(false) }
    var showFilters by rememberSaveable(gameId) { mutableStateOf(false) }
    var showDetails by rememberSaveable(gameId) { mutableStateOf(false) }
    var showRoles by rememberSaveable(gameId) { mutableStateOf(false) }
    val mystery = game.str("gameType") == "mystery"
    val messages = s.data.rows("messages")
    val rows = messages.filter { message ->
        val display = message.optJSONObject("display")
        (lane == "all" || message.str("channel") == lane) &&
            (!keyOnly || (display?.optBoolean("key") ?: (message.str("kind") != "chat"))) &&
            (query.isBlank() || listOf(display?.str("speaker"), display?.str("body"), display?.optJSONArray("votes")?.toString())
                .filterNotNull().joinToString(" ").contains(query.trim(), ignoreCase = true))
    }
    val timeline = rememberLazyListState()
    val board = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val filterCount = listOf(lane != "all", query.isNotBlank(), keyOnly).count { it }
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        state = if (tab == "timeline") timeline else board,
        contentPadding = PaddingValues(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        item(key = "overview") {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        if (!showDetails) {
                            Text(game.str("title", "星邮游戏"), style = MaterialTheme.typography.titleMedium,
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val day = game.optInt("day")
                            Text((if (!mystery && day > 0) "第 ${day} 天 · " else "") + gamePhaseLabel(game),
                                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        } else Text("对局详情", style = MaterialTheme.typography.titleMedium)
                    }
                    TextButton(onClick = { showDetails = !showDetails }) { Text(if (showDetails) "收起详情" else "展开详情") }
                }
                if (showDetails) GameBanner(game, game.str("viewLabel", "只读观战 / 回放"), s.data.str("serverNow"), compact = true)
                if (s.route.page != "featured") PublicGameJoin(ui, s, game)
            }
        }
        stickyHeader(key = "views") {
            Surface(color = MaterialTheme.colorScheme.background) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        ChoiceTabs(listOf("timeline" to "对局记录", "board" to "玩家牌桌"), tab) { tab = it }
                    }
                    if (tab == "timeline") TextButton(onClick = { showFilters = true }) {
                        Text(if (filterCount == 0) "筛选" else "筛选 ($filterCount)")
                    }
                }
            }
        }
        if (tab == "board") {
            item(key = "seats") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (game.rows("seats").any { it.has("role") })
                        FilterChip(selected = showRoles, onClick = { showRoles = !showRoles }, label = { Text(if (showRoles) "隐藏身份" else "显示身份") })
                    GameSeatBoard(game, showRoles = showRoles)
                    Text(game.str("viewLabel", "获准视角") + "。仅供观看，不会替玩家发言或行动。",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        } else {
            item(key = "reading-actions") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val count = if (filterCount == 0) "本页 ${messages.size} 条" else "显示 ${rows.size} / ${messages.size} 条"
                    Text(count + if (s.route.before != null) " · 历史回放" else "", Modifier.weight(1f),
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(enabled = !s.loading, onClick = { ui.vm.refresh() }) { Text("刷新") }
                    TextButton(enabled = rows.isNotEmpty(), onClick = {
                        scope.launch { timeline.animateScrollToItem((timeline.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)) }
                    }) { Text("页尾") }
                }
            }
            if (rows.isEmpty()) item { EmptyState("本页没有匹配记录", "切换频道或加载更早记录。") }
            itemsIndexed(rows, key = { i, m -> "message:" + m.str("id", m.optLong("cursor", i.toLong()).toString()) }) { index, m ->
                val round = m.optJSONObject("display")?.str("round", "对局记录") ?: "对局记录"
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (index == 0 || rows[index - 1].optJSONObject("display")?.str("round") != round)
                        Text(round, Modifier.padding(vertical = 6.dp), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    WatchMessage(m, if (m.str("kind") == "chat" && m.str("sender") != s.account.str("humanId")) ({
                        ui.modal = Modal.Report(m.str("sender"), obj("type" to if (mystery) "mystery" else "game",
                            "id" to m.str("id"), "gameId" to s.route.id).apply {
                            if (s.account.str("botId").isNotEmpty()) put("viewerBotId", s.account.str("botId"))
                        })
                    }) else null)
                }
            }
            if (!s.data.isNull("nextBefore") || s.route.before != null) item(key = "paging") { Pager(ui, s) }
        }
    }
    if (showFilters) {
        ModalBottomSheet(onDismissRequest = { showFilters = false }) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("筛选对局记录", style = MaterialTheme.typography.titleMedium)
                val lanes = if (mystery) listOf("all" to "全部", "public" to "公共", "private" to "私密")
                    else listOf("all" to "全部", "public" to "公共", "wolf" to "狼人", "private" to "私密", "judge" to "法官", "outside" to "局外")
                ChoiceTabs(lanes, lane) { lane = it }
                OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("搜索本页昵称或内容") })
                FilterChip(selected = keyOnly, onClick = { keyOnly = !keyOnly }, label = { Text("只看关键事件") })
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { showFilters = false; scope.launch { timeline.scrollToItem(0) } }) { Text("查看 ${rows.size} 条记录") }
                    TextButton(enabled = filterCount > 0, onClick = { lane = "all"; query = ""; keyOnly = false }) { Text("清除筛选") }
                }
                Spacer(Modifier.height(12.dp))
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
            if(d.rows("votes").isNotEmpty()) WatchBreakdown("本轮投票明细",d.rows("votes").size) {
                d.rows("votes").forEach{v->Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)){Text(v.str("player"),Modifier.weight(1f),style=MaterialTheme.typography.bodySmall);Text("→");Text(v.str("target"),Modifier.weight(1f),style=MaterialTheme.typography.bodySmall)}}
            }
            if(d.rows("reveals").isNotEmpty()) WatchBreakdown("身份揭晓",d.rows("reveals").size) {
                d.rows("reveals").forEach{r->Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text(r.str("player"),Modifier.weight(1f),style=MaterialTheme.typography.bodySmall);Text(r.str("role"),style=MaterialTheme.typography.labelLarge,color=MaterialTheme.colorScheme.primary)}}
            }
        }
    }
}

@Composable private fun WatchBreakdown(label: String, count: Int, content: @Composable () -> Unit) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    TextButton(onClick = { expanded = !expanded }) {
        Text((if (expanded) "收起" else "展开") + label + "（" + count + "）")
    }
    if (expanded) content()
}
