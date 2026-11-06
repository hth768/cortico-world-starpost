package io.starpost.mobile

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/** The full application surface moves; this is not a dialog or bottom sheet. */
@Composable internal fun MiniAppsReveal(open:Boolean,onOpen:(Boolean)->Unit,enabled:Boolean,pullEnabled:Boolean,
    menu:@Composable ()->Unit,content:@Composable ()->Unit) {
    val focus=LocalFocusManager.current
    val expanded=open&&enabled
    LaunchedEffect(expanded){if(!expanded)focus.clearFocus()}
    LaunchedEffect(enabled){if(!enabled)onOpen(false)}
    BackHandler(expanded){onOpen(false)}
    BoxWithConstraints(Modifier.fillMaxSize().clipToBounds()) {
        val density=LocalDensity.current
        val distance=with(density){(maxHeight-80.dp).coerceAtLeast(120.dp).toPx()}
        val threshold=with(density){88.dp.toPx()}
        val animated by animateFloatAsState(if(expanded)distance else 0f,spring(dampingRatio=0.85f,stiffness=400f),label="miniAppsReveal")
        var drag by remember{mutableStateOf<Float?>(null)}
        val offset=if(enabled)(drag?:animated).coerceIn(0f,distance) else 0f
        val currentOffset by rememberUpdatedState(offset)
        val currentExpanded by rememberUpdatedState(expanded)
        val changeOpen by rememberUpdatedState(onOpen)
        fun settle(){val y=drag?:return;changeOpen(if(currentExpanded)y>distance-threshold else y>=threshold);drag=null}
        val connection=remember(enabled,pullEnabled,distance,threshold){object:NestedScrollConnection{
            override fun onPreScroll(available:Offset,source:NestedScrollSource):Offset {
                if(!enabled||!pullEnabled||source!=NestedScrollSource.UserInput||currentExpanded)return Offset.Zero
                if(currentOffset>0&&available.y<0){val used=available.y.coerceAtLeast(-currentOffset);drag=currentOffset+used;return Offset(0f,used)}
                return Offset.Zero
            }
            override fun onPostScroll(consumed:Offset,available:Offset,source:NestedScrollSource):Offset {
                if(!enabled||!pullEnabled||currentExpanded||source!=NestedScrollSource.UserInput||available.y<=0)return Offset.Zero
                drag=(currentOffset+available.y*0.8f).coerceAtMost(distance)
                return Offset(0f,available.y)
            }
            override suspend fun onPreFling(available:Velocity):Velocity {if(drag==null)return Velocity.Zero;settle();return available}
        }}
        if(offset>0f)Box(Modifier.fillMaxWidth().height(with(density){offset.toDp()}).clipToBounds()
            .then(if(!expanded)Modifier.clearAndSetSemantics{}else Modifier).testTag("mini-apps-page")) {menu()}
        Box(Modifier.fillMaxSize().offset{IntOffset(0,offset.roundToInt())}.nestedScroll(connection).testTag("main-page-surface")) {
            Box(Modifier.fillMaxSize().then(if(expanded)Modifier.clearAndSetSemantics{} else Modifier)){content()}
            if(expanded)Surface(Modifier.fillMaxSize().pointerInput(distance){detectVerticalDragGestures(
                onDragEnd={settle()},onDragCancel={drag=null},onVerticalDrag={change,amount->change.consume();drag=(currentOffset+amount).coerceIn(0f,distance)})},
                shape=RoundedCornerShape(topStart=28.dp,topEnd=28.dp),color=MaterialTheme.colorScheme.surfaceContainerHigh) {
                Box(Modifier.fillMaxWidth().height(72.dp).clickable{onOpen(false)},contentAlignment=Alignment.TopCenter){Text("上滑或点此返回",Modifier.padding(top=24.dp),style=MaterialTheme.typography.labelLarge)}
            }
        }
    }
}

internal data class MiniApp(val title:String,val hint:String,val icon:String,val page:String,val kind:String="private",val id:String="",val aliases:String="")
internal val miniApps=listOf(
    MiniApp("狼人杀","预约与参赛","game","games",aliases="游戏 推理 werewolf"),
    MiniApp("剧本杀","加入预约 · 一起推理","mystery","games","mystery",aliases="游戏 参赛 观战 mystery"),
    MiniApp("Bot 对局","私密与历史","people","botGames","own",aliases="我的 游戏 狼人杀 剧本杀 记录"),
    MiniApp("公开游戏","发现正在玩的局","explore","botGames","public",aliases="观战 狼人杀 剧本杀"),
    MiniApp("游戏战绩","胜负与最近对局","person","gameRecord",aliases="狼人杀 历史 统计"),
    MiniApp("精彩对局","每日精选回放","spark","featuredSummary",aliases="游戏 历史 狼人杀"),
    MiniApp("Bot 动态","朋友们的日常","sticker","feed",aliases="朋友圈"),
    MiniApp("我的 bot","专属聊天频道","person","owner",aliases="桌宠 消息"),
    MiniApp("Bot 会话","查看聊天记录","chat","chats",aliases="私聊 群聊"),
)
internal fun searchMiniApps(query:String)=query.trim().let{q->miniApps.filter{q.isEmpty()||"${it.title} ${it.hint} ${it.aliases}".contains(q,ignoreCase=true)}}

@Composable internal fun MiniAppsPage(ui:UiActions) = MiniAppsCatalog(onClose={ui.miniAppsOpen=false},onSelect={ui.go(it.page,it.id,it.kind)})

@Composable internal fun MiniAppsCatalog(onClose:()->Unit,onSelect:(MiniApp)->Unit) {
    var query by rememberSaveable{mutableStateOf("")}
    val results=searchMiniApps(query)
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLow).safeDrawingPadding().imePadding()
        .verticalScroll(rememberScrollState()).padding(horizontal=24.dp,vertical=12.dp),verticalArrangement=Arrangement.spacedBy(20.dp)) {
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){Column(Modifier.weight(1f)){Text("小程序",style=MaterialTheme.typography.headlineLarge,fontWeight=FontWeight.Bold);Text("在星邮，发现更多玩法",color=MaterialTheme.colorScheme.onSurfaceVariant)};IconButton(onClick=onClose){Glyph("close","收起小程序")}}
        OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),singleLine=true,shape=RoundedCornerShape(28.dp),placeholder={Text("搜索游戏和额外功能")},leadingIcon={Glyph("search")},trailingIcon={if(query.isNotEmpty())IconButton(onClick={query=""}){Glyph("close","清空搜索")}})
        Text(if(query.isBlank())"游戏与服务" else "搜索结果 · ${results.size}",style=MaterialTheme.typography.titleMedium)
        if(results.isEmpty())Text("没有找到相关功能，试试“狼人杀”或“动态”。",color=MaterialTheme.colorScheme.onSurfaceVariant)
        results.chunked(3).forEach{row->Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(12.dp)){
            row.forEach{app->Column(Modifier.weight(1f).clickable{onSelect(app)}.padding(vertical=8.dp),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(8.dp)){
                Surface(modifier=Modifier.size(64.dp),shape=RoundedCornerShape(22.dp),color=if(app.title=="剧本杀")MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.primaryContainer){
                    Box(Modifier.fillMaxSize(),contentAlignment=Alignment.Center){
                        if(app.icon=="mystery")Text("剧",style=MaterialTheme.typography.headlineSmall,fontWeight=FontWeight.Bold)
                        else Glyph(app.icon,modifier=Modifier.size(28.dp),color=MaterialTheme.colorScheme.onPrimaryContainer)
                    }
                };Text(app.title,style=MaterialTheme.typography.labelLarge);Text(app.hint,style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            }};repeat(3-row.size){Spacer(Modifier.weight(1f))}
        }}
        Spacer(Modifier.height(16.dp))
    }
}
