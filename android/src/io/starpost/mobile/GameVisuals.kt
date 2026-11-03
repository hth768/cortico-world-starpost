package io.starpost.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.time.Instant

internal fun gamePhaseKey(g:JSONObject)="${g.str("gameId")}/${g.str("status")}/${g.optInt("day")}/${g.str("phaseDeadlineAt")}"
private val mysterySteps=listOf("opening" to "序幕","roles" to "领取剧本","clues" to "搜集线索","discussion" to "讨论推理","accusation" to "指认凶手","reveal" to "真相揭晓","closed" to "结束")
internal fun gamePhaseLabel(g:JSONObject)=if(g.str("gameType")=="mystery")mysterySteps.find{it.first==g.str("phase")}?.second?:"等待开场" else gameStates[g.str("status")]?:"进行中"

@Composable internal fun GameBanner(g:JSONObject,mode:String,serverNow:String="",compact:Boolean=false){
    val colors=MaterialTheme.colorScheme;val night=g.str("status").startsWith("night");val script=g.str("gameType")=="mystery"
    val deadline=remember(g.str("phaseDeadlineAt")){runCatching{Instant.parse(g.str("phaseDeadlineAt")).toEpochMilli()}.getOrDefault(0L)}
    val offset=remember(serverNow){runCatching{Instant.parse(serverNow).toEpochMilli()-System.currentTimeMillis()}.getOrDefault(0L)}
    var now by remember{mutableLongStateOf(System.currentTimeMillis())}
    LaunchedEffect(deadline,offset){while(deadline>0){now=System.currentTimeMillis();delay(1000)}}
    val remaining=((deadline-now-offset+999)/1000).coerceAtLeast(0)
    val foreground=if(night)colors.onPrimaryContainer else colors.onSecondaryContainer
    Surface(shape=RoundedCornerShape(if(compact)20.dp else 28.dp),color=colors.surfaceContainer,modifier=Modifier.fillMaxWidth()){
        Column(Modifier.background(Brush.linearGradient(listOf(if(night)colors.primaryContainer else colors.secondaryContainer,colors.tertiaryContainer))).padding(if(compact)16.dp else 22.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
            Text("${if(script)"MYSTERY · 剧本杀" else "WEREWOLF · 狼人杀"} / $mode",style=MaterialTheme.typography.labelSmall,color=foreground)
            Text(g.str("title","星邮游戏"),style=if(compact)MaterialTheme.typography.titleLarge else MaterialTheme.typography.headlineSmall,fontWeight=FontWeight.Bold,color=foreground,maxLines=2,overflow=TextOverflow.Ellipsis)
            Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)){
                Text(if(script)"✦" else if(night)"☾" else "☀",style=MaterialTheme.typography.headlineMedium,color=foreground)
                Text((if(g.optInt("day")>0&&!script)"第 ${g.optInt("day")} 天 · " else "")+gamePhaseLabel(g),Modifier.weight(1f),style=MaterialTheme.typography.titleSmall,color=foreground)
                if(deadline>0&&g.str("status") !in listOf("closed","cancelled"))Surface(shape=CircleShape,color=colors.surface.copy(alpha=.85f)){Text(if(remaining>0)"%02d:%02d".format(remaining/60,remaining%60)else "等待结算",Modifier.padding(horizontal=12.dp,vertical=8.dp),style=MaterialTheme.typography.labelLarge)}
            }
            if(!compact)Text(if(mode=="游戏大厅")"选择定时预约、人满就开，或实时匹配。" else if(script)"跟随主持人推进剧情，按获准视角查看线索与消息。" else when(g.str("status")){"scheduled"->if(g.str("startMode")=="full")"加入即准备，人满立即开局。保持在线，断连超过 2 分钟释放席位。" else "开局前 3 分钟报到，准时入座。";"day"->"讨论完毕请选择结束发言，全员结束立即投票，计时只作兜底。";"vote"->"点选目标后确认投票，也可以弃票。";"finished","closed"->"故事暂告一段落，一起回顾这场推理。";else->"轮到你行动时，使用牌桌下方的技能按钮。"},style=MaterialTheme.typography.bodyMedium,color=foreground)
            if(script){val current=mysterySteps.indexOfFirst{it.first==g.str("phase")};mysterySteps.chunked(3).forEachIndexed{row,steps->Row(horizontalArrangement=Arrangement.spacedBy(6.dp)){steps.forEachIndexed{col,step->Surface(Modifier.weight(1f),shape=RoundedCornerShape(10.dp),color=if(row*3+col<=current)colors.primaryContainer else colors.surface.copy(alpha=.65f)){Text("${row*3+col+1} ${step.second}",Modifier.padding(8.dp),style=MaterialTheme.typography.labelSmall)}}}}}
            if(g.str("status")=="day"&&g.has("speechesDone"))Text((if(g.optBoolean("speechEnded"))"你已结束本轮发言 · " else "")+"${g.optInt("speechesDone")}/${g.strings("alive").size} 人已结束发言",style=MaterialTheme.typography.labelMedium,color=foreground)
            if(g.str("winner").isNotEmpty())Text(when(g.str("winner")){"wolves"->"狼人阵营获胜";"village"->"好人阵营获胜";else->"本局平局"},style=MaterialTheme.typography.titleMedium,fontWeight=FontWeight.Bold,color=foreground)
        }
    }
}

@Composable internal fun GameSeatBoard(g:JSONObject,self:String=""){
    val seats=g.rows("seats");val scheduled=g.str("status")=="scheduled";val colors=MaterialTheme.colorScheme
    Column(verticalArrangement=Arrangement.spacedBy(10.dp)){
        Text(if(scheduled)"集合席位 · ${g.optInt("checkedIn")} 人已报到" else "${if(g.str("gameType")=="mystery")"在场" else "存活"} ${seats.count{it.optBoolean("alive")}} / ${seats.size}",style=MaterialTheme.typography.titleSmall)
        if(seats.isEmpty())Text("成员就位后显示牌桌",color=colors.onSurfaceVariant)
        seats.chunked(4).forEach{row->Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
            row.forEach{seat->val me=seat.str("id")==self;val active=seat.optBoolean("alive");Surface(Modifier.weight(1f).alpha(if(active)1f else .55f),shape=RoundedCornerShape(18.dp),color=if(me)colors.primaryContainer else colors.surfaceContainerHigh,border=if(me)BorderStroke(1.dp,colors.primary)else null){
                Column(Modifier.padding(horizontal=5.dp,vertical=10.dp),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(5.dp)){
                    Text("%02d".format(seat.optInt("number")),style=MaterialTheme.typography.labelSmall,color=colors.onSurfaceVariant)
                    Surface(shape=CircleShape,color=if(me)colors.primary else colors.secondaryContainer,modifier=Modifier.size(36.dp)){Box(contentAlignment=Alignment.Center){Text(seat.str("nickname",seat.str("id")).take(1),fontWeight=FontWeight.Bold)}}
                    Text(seat.str("nickname",seat.str("id")),style=MaterialTheme.typography.labelMedium,maxLines=1,overflow=TextOverflow.Ellipsis)
                    Text(if(me)"我" else if(seat.str("id").endsWith("H"))"人类" else "Bot",style=MaterialTheme.typography.labelSmall,color=colors.onSurfaceVariant)
                    Text(if(scheduled){if(seat.optBoolean("checkedIn"))"已报到" else "待报到"}else if(active)"在场" else "已离场",style=MaterialTheme.typography.labelSmall)
                }
            }}
            repeat(4-row.size){Spacer(Modifier.weight(1f))}
        }}
    }
}

@Composable internal fun GameRoleCard(g:JSONObject){
    Surface(shape=RoundedCornerShape(24.dp),color=MaterialTheme.colorScheme.tertiaryContainer,modifier=Modifier.fillMaxWidth()){
        Row(Modifier.padding(18.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(16.dp)){
            Text("✦",style=MaterialTheme.typography.headlineLarge)
            Column{Text("仅你可见 · 身份牌",style=MaterialTheme.typography.labelSmall);Text(roleNames[g.str("ownRole")]?:"等待领取身份",style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.Bold);Text(if(g.str("ownRole")=="wolf")"找到同伴，隐藏自己" else "谨慎推理，寻找真相",style=MaterialTheme.typography.bodySmall)}
        }
    }
}

@Composable internal fun GameLobbyCard(g:JSONObject,onClick:()->Unit){
    Card(onClick=onClick,modifier=Modifier.fillMaxWidth(),shape=RoundedCornerShape(24.dp),colors=CardDefaults.cardColors(containerColor=MaterialTheme.colorScheme.surfaceContainerLow)){
        Column(Modifier.padding(20.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
            Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(14.dp)){
                Surface(shape=RoundedCornerShape(18.dp),color=MaterialTheme.colorScheme.primaryContainer,modifier=Modifier.size(52.dp)){Box(contentAlignment=Alignment.Center){Text(if(g.str("gameType")=="mystery")"✦" else "☾",style=MaterialTheme.typography.headlineMedium)}}
                Column(Modifier.weight(1f)){Text(if(g.str("gameType")=="mystery")"剧本杀 · 观战" else "狼人杀",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.primary);Text(g.str("title"),style=MaterialTheme.typography.titleMedium,fontWeight=FontWeight.Bold);Text(gamePhaseLabel(g),style=MaterialTheme.typography.bodySmall)}
                Glyph("chevron")
            }
            Text("${if(g.str("startMode")=="full")if(g.optBoolean("matching"))"实时匹配 · 人满就开" else "人满就开" else time(g.str("scheduledAt"))} · ${if(g.optBoolean("public"))"公开" else "私密"}",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            if(g.optInt("maxPlayers")>0){LinearProgressIndicator(progress={g.optInt("joined").toFloat().div(g.optInt("maxPlayers")).coerceIn(0f,1f)},modifier=Modifier.fillMaxWidth());Text("${g.optInt("joined")} / ${g.optInt("maxPlayers")} 人 · ${if(g.str("status")=="scheduled")"查看预约" else "进入对局"}",style=MaterialTheme.typography.labelMedium)}
        }
    }
}

// The server supplies the legal targets. A polling update must not turn an old selection into a new action.
@Composable internal fun GameTargetDialog(option:JSONObject,current:JSONObject?,validPhase:Boolean,working:Boolean,onDismiss:()->Unit,onConfirm:(String)->Unit){
    var selected by remember(option.toString()){mutableStateOf<String?>(null)}
    val targets=option.rows("targets");val legal=validPhase&&current!=null&&current.rows("targets").any{it.str("id")==selected}
    AlertDialog(onDismissRequest=onDismiss,title={Text(option.str("label"))},text={Column(verticalArrangement=Arrangement.spacedBy(12.dp)){
        Text(if(validPhase&&current!=null)"先选择目标，再确认行动。" else "阶段或可用行动已变化，请关闭后重新选择。",color=if(validPhase&&current!=null)MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)
        Column(Modifier.heightIn(max=340.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)){
            targets.chunked(2).forEach{row->Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){row.forEach{target->val id=target.str("id");val enabled=validPhase&&!working&&current?.rows("targets")?.any{it.str("id")==id}==true;OutlinedCard(onClick={selected=id},enabled=enabled,modifier=Modifier.weight(1f),shape=RoundedCornerShape(18.dp),border=BorderStroke(if(selected==id)2.dp else 1.dp,if(selected==id)MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),colors=CardDefaults.outlinedCardColors(containerColor=if(selected==id)MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface)){
                Column(Modifier.padding(14.dp)){Text(target.str("nickname",id.ifBlank{"跳过"}),fontWeight=FontWeight.Bold);Text(if(id.isBlank())"不选择玩家" else id,style=MaterialTheme.typography.bodySmall)}
            }};if(row.size==1)Spacer(Modifier.weight(1f))}}
        }
        if(selected!=null)Text("已选择：${targets.find{it.str("id")==selected}?.str("nickname")?:selected}",style=MaterialTheme.typography.labelLarge)
    }},confirmButton={Button(enabled=legal&&!working,onClick={selected?.let(onConfirm)}){Text("确认行动")}},dismissButton={TextButton(onClick=onDismiss){Text("取消")}})
}
