@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
package io.starpost.mobile

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.nestedscroll.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal val pageNames=mapOf("social" to "消息","contacts" to "联系人","square" to "发现","settings" to "我","owner" to "我的 bot","chats" to "Bot 会话","feed" to "Bot 动态","post" to "动态详情","search" to "寻找新朋友","groupCreate" to "发起群聊","invite" to "邀请好友","approvals" to "社交审批","teen" to "青少年模式","profile" to "个人资料","games" to "狼人杀广场","botGames" to "Bot 对局","game" to "对局记录","humanReservation" to "游戏预约","humanRoom" to "游戏聊天室","schedule" to "预约狼人杀","featured" to "精彩对局","featuredSummary" to "每日精彩对局","socialHistory" to "聊天","history" to "Bot 聊天记录")
internal val rootPages=listOf("social","contacts","square","settings")
internal fun time(at:String)=runCatching { DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.of("Asia/Shanghai")).format(Instant.parse(at)) }.getOrDefault(at)
internal data class TextFieldSpec(val key:String,val label:String,val initial:String="",val secret:Boolean=false)
internal sealed interface Modal {
    data object Games:Modal
    data object More:Modal
    data class Confirm(val title:String,val message:String,val submit:()->Unit):Modal
    data class Form(val title:String,val fields:List<TextFieldSpec>,val hint:String="",val submit:(Map<String,String>)->Unit):Modal
    data class Stickers(val select:(JSONObject)->Unit):Modal
}
internal class UiActions(val vm:StarpostClient){var modal by mutableStateOf<Modal?>(null)
    fun confirm(title:String,message:String,submit:()->Unit){modal=Modal.Confirm(title,message,submit)}
    fun form(title:String,fields:List<TextFieldSpec>,hint:String="",submit:(Map<String,String>)->Unit){modal=Modal.Form(title,fields,hint,submit)}
    fun go(page:String,id:String="",kind:String="private"){modal=null;vm.navigate(Route(page,id,kind))}
}

@Composable internal fun StarpostApp(vm:StarpostClient,state:ClientState) {
    val ui=remember(vm){UiActions(vm)}
    val pageTitle=when(state.route.page){
        "owner"->state.account.rows("bots").find{it.str("botId")==state.account.str("botId")}?.str("nickname","我的 bot")?:"我的 bot"
        "socialHistory"->conversationName(state.social,state.route.id,state.route.kind)
        "history"->conversationName(state.overview,state.route.id,state.route.kind)
        else->pageNames[state.route.page]?:"星邮"
    }
    val snackbar=remember{SnackbarHostState()}
    LaunchedEffect(state.notice){if(state.notice.isNotEmpty()){snackbar.showSnackbar(state.notice);vm.clearNotice()}}
    BackHandler(enabled=ui.modal!=null||state.signedIn&&state.route.page !in rootPages){if(ui.modal!=null)ui.modal=null else vm.back()}
    Surface(Modifier.fillMaxSize(),color=MaterialTheme.colorScheme.background){
        if(state.starting||(state.signedIn&&state.account.length()==0)){Column(Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.Center){LoadingIndicator();Text("正在连接星邮",style=MaterialTheme.typography.titleLarge);if(state.error.isNotEmpty()){Text(state.error);Button(onClick=vm::retryStart){Text("重试")}}}}
        else if(!state.signedIn||state.account.optBoolean("needsEmail")){Box(Modifier.fillMaxSize()){LoginScreen(vm,state);SnackbarHost(snackbar,Modifier.align(Alignment.BottomCenter).navigationBarsPadding())}}
        else BoxWithConstraints(Modifier.fillMaxSize()) {
            val wide=maxWidth>=840.dp
            Row(Modifier.fillMaxSize()) {
                if(wide&&state.activeGame.isEmpty())NavigationRail(containerColor=MaterialTheme.colorScheme.surfaceContainerLow,modifier=Modifier.fillMaxHeight().navigationBarsPadding(),header={Spacer(Modifier.height(20.dp));Glyph("spark",modifier=Modifier.size(36.dp),color=MaterialTheme.colorScheme.primary);Spacer(Modifier.height(24.dp))}){
                    rootPages.forEachIndexed { i,page -> NavigationRailItem(selected=state.route.page==page,onClick={ui.go(page)},icon={Glyph(listOf("chat","people","explore","person")[i])},label={Text(pageNames.getValue(page))}) }
                }
                Scaffold(modifier=Modifier.weight(1f),containerColor=MaterialTheme.colorScheme.background,snackbarHost={SnackbarHost(snackbar)},
                    topBar={TopAppBar(title={Column{Text(pageTitle,style=MaterialTheme.typography.headlineSmall,fontWeight=FontWeight.Bold,maxLines=1,overflow=TextOverflow.Ellipsis);if(state.route.page in rootPages)Text("STARPOST · ${state.account.str("nickname")}",style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)}},
                        navigationIcon={if(state.route.page !in rootPages&&state.activeGame.isEmpty())IconButton(onClick={vm.back()}){Glyph("back","返回")}},
                        actions={if(state.activeGame.isEmpty()){IconButton(onClick={ui.modal=Modal.Games}){Glyph("game","游戏小程序")};IconButton(onClick={ui.modal=Modal.More}){Glyph("add","更多功能")}}},
                        colors=TopAppBarDefaults.topAppBarColors(containerColor=MaterialTheme.colorScheme.background))},
                    bottomBar={
                        if(!wide && state.route.page in rootPages && state.activeGame.isEmpty()) {
                            NavigationBar(containerColor=MaterialTheme.colorScheme.surfaceContainerLow) {
                                rootPages.forEachIndexed { i,page ->
                                    NavigationBarItem(selected=state.route.page==page,onClick={ui.go(page)},icon={Glyph(listOf("chat","people","explore","person")[i])},label={Text(pageNames.getValue(page))})
                                }
                            }
                        }
                    })
                {padding->Column(Modifier.padding(padding).fillMaxSize().imePadding()){
                    if(state.error.isNotEmpty())Surface(color=MaterialTheme.colorScheme.errorContainer,shape=RoundedCornerShape(20.dp),modifier=Modifier.padding(horizontal=16.dp).fillMaxWidth()){Row(Modifier.padding(12.dp),verticalAlignment=Alignment.CenterVertically){Text(state.error,Modifier.weight(1f),color=MaterialTheme.colorScheme.onErrorContainer,style=MaterialTheme.typography.bodyMedium);TextButton(onClick=vm::refresh){Text("重试")}}}
                    if(state.loading&&state.data.length()==0)Box(Modifier.fillMaxSize(),contentAlignment=Alignment.Center){LoadingIndicator()}
                    else AnimatedContent(targetState=state.route.page to state.route.id,label="page",modifier=Modifier.weight(1f)){routeKey->if(routeKey==(state.route.page to state.route.id))ScreenBody(ui,state)}
                }}
            }
        }
        ModalContent(ui,state)
    }
}

@Composable private fun LoginScreen(vm:StarpostClient,state:ClientState){
    var mode by rememberSaveable { mutableStateOf("password") };val actual=if(state.account.optBoolean("needsEmail"))"claim" else mode
    var email by rememberSaveable(actual){mutableStateOf("")};var password by remember(actual){mutableStateOf("")};var nickname by rememberSaveable(actual){mutableStateOf("")};var code by rememberSaveable(actual){mutableStateOf("")};var challenge by remember(actual){mutableStateOf("")};var challengeEmail by remember(actual){mutableStateOf("")};var retry by remember{mutableIntStateOf(0)};var customServer by rememberSaveable{mutableStateOf("https://starpost.com.cn")};var visible by remember{mutableStateOf(false)}
    LaunchedEffect(retry){if(retry>0){kotlinx.coroutines.delay(1000);retry--}}
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),horizontalAlignment=Alignment.CenterHorizontally){Column(Modifier.widthIn(max=460.dp).fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(16.dp)){
        Spacer(Modifier.height(24.dp));Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){Surface(shape=RoundedCornerShape(26.dp),color=MaterialTheme.colorScheme.primaryContainer){Glyph("mail",modifier=Modifier.padding(20.dp).size(40.dp),color=MaterialTheme.colorScheme.onPrimaryContainer)};Spacer(Modifier.weight(1f));IconButton(onClick={vm.theme(if(state.theme=="dark")"light" else "dark")}){Glyph(if(state.theme=="dark")"sun" else "moon","切换深浅色")}}
        Text(when(actual){"claim"->"让故事继续";"register"->"在星邮相遇";"legacy"->"找回旧身份";else->"欢迎回到\n星邮。"},style=MaterialTheme.typography.displayMedium,fontWeight=FontWeight.Bold)
        Text(if(actual=="claim")"为 ${state.account.str("humanId")} 绑定邮箱，保留原 bot 与游戏记录。"else if(actual=="legacy")"使用原 bot ID 和凭据升级旧账号。"else "与朋友聊天，和 bot 一起生活。",style=MaterialTheme.typography.bodyLarge,color=MaterialTheme.colorScheme.onSurfaceVariant)
        if(actual !in listOf("claim","legacy"))ChoiceTabs(listOf("password" to "密码登录","code" to "验证码","register" to "注册"),actual){mode=it}
        if(actual=="legacy")OutlinedTextField(customServer,{customServer=it},Modifier.fillMaxWidth(),label={Text("服务器 HTTPS 地址")},singleLine=true)
        OutlinedTextField(email,{email=it},Modifier.fillMaxWidth(),label={Text(if(actual=="legacy")"Bot ID" else "邮箱地址")},leadingIcon={Glyph(if(actual=="legacy")"person" else "mail")},singleLine=true,keyboardOptions=KeyboardOptions(keyboardType=if(actual=="legacy")KeyboardType.Number else KeyboardType.Email))
        if(actual!="code")OutlinedTextField(password,{password=it},Modifier.fillMaxWidth(),label={Text(if(actual=="legacy")"本机凭据" else "密码（8–128 字符）")},singleLine=true,visualTransformation=if(visible)VisualTransformation.None else PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password),trailingIcon={TextButton(onClick={visible=!visible}){Text(if(visible)"隐藏" else "显示")}})
        if(actual in listOf("register","claim"))OutlinedTextField(nickname,{nickname=it},Modifier.fillMaxWidth(),label={Text("你的昵称")},singleLine=true)
        if(actual in listOf("code","register","claim"))Row(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalAlignment=Alignment.CenterVertically){OutlinedTextField(code,{code=it.filter(Char::isDigit).take(4)},Modifier.weight(1f),label={Text("四位验证码")},singleLine=true,keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number));FilledTonalButton(enabled=retry==0&&!state.working&&email.isNotBlank(),onClick={vm.sendCode(actual,email){id,seconds->challenge=id;challengeEmail=email.trim();retry=seconds}}){Text(if(retry>0)"${retry}s" else "获取验证码")}}
        if(state.error.isNotEmpty())Text(state.error,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodyMedium)
        Button(onClick={if(challenge.isNotEmpty()&&challengeEmail!=email.trim())vm.notice("邮箱已修改，请重新获取验证码")else vm.login(actual,email,password,nickname,challenge,code,customServer){password=""}},shapes=ButtonDefaults.shapes(),enabled=!state.working&&email.isNotBlank(),modifier=Modifier.fillMaxWidth().heightIn(min=56.dp)){if(state.working)CircularProgressIndicator(Modifier.size(20.dp),strokeWidth=2.dp)else{Text(when(actual){"claim"->"验证并绑定邮箱";"register"->"创建我的账号";"legacy"->"验证旧账号";else->"进入星邮"},style=MaterialTheme.typography.titleMedium);Spacer(Modifier.width(12.dp));Glyph("chevron")}}
        Text("登录状态保留 14 天 · 验证码 5 分钟内有效",style=MaterialTheme.typography.labelMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
        if(actual!="claim")TextButton(onClick={mode=if(actual=="legacy")"password" else "legacy"}){Text(if(actual=="legacy")"返回邮箱登录" else "已有 bot 凭据？升级旧账号")}
        Spacer(Modifier.height(24.dp))
    }}
}

@Composable internal fun ChoiceTabs(choices:List<Pair<String,String>>,selected:String,choose:(String)->Unit){
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)){choices.forEach{(key,label)->FilterChip(selected=key==selected,onClick={choose(key)},label={Text(label)},leadingIcon=if(key==selected){{Glyph("check",modifier=Modifier.size(18.dp))}}else null)}}
}
@Composable internal fun SectionTitle(title:String,description:String="") {Column(Modifier.padding(vertical=8.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){Text(title,style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.Bold);if(description.isNotEmpty())Text(description,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)}}
@Composable internal fun EmptyState(title:String="这里还很安静",hint:String="新的故事，会从一次问候开始。") {Column(Modifier.fillMaxWidth().padding(32.dp),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(12.dp)){Surface(shape=RoundedCornerShape(32.dp),color=MaterialTheme.colorScheme.secondaryContainer){Glyph("spark",modifier=Modifier.padding(24.dp).size(36.dp),color=MaterialTheme.colorScheme.onSecondaryContainer)};Text(title,style=MaterialTheme.typography.titleLarge);Text(hint,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)}}
@Composable internal fun Avatar(label:String,kind:String="",modifier:Modifier=Modifier) {Surface(modifier.size(52.dp),shape=RoundedCornerShape(if(kind=="group")18.dp else 26.dp),color=if(kind=="group")MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.primaryContainer){Box(contentAlignment=Alignment.Center){if(kind=="group")Glyph("people",color=MaterialTheme.colorScheme.onTertiaryContainer)else Text(label.take(1).ifEmpty{"✦"},style=MaterialTheme.typography.titleLarge,color=MaterialTheme.colorScheme.onPrimaryContainer,fontWeight=FontWeight.Bold)}}}
@Composable internal fun Entry(title:String,subtitle:String="",kind:String="",trailing:String="",click:()->Unit) {Surface(onClick=click,shape=RoundedCornerShape(24.dp),color=MaterialTheme.colorScheme.surfaceContainerLow,modifier=Modifier.fillMaxWidth()){Row(Modifier.padding(16.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(14.dp)){Avatar(title,kind);Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(5.dp)){Text(title,style=MaterialTheme.typography.titleMedium,maxLines=1,overflow=TextOverflow.Ellipsis);if(subtitle.isNotEmpty())Text(subtitle,style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=2,overflow=TextOverflow.Ellipsis)};if(trailing.isNotEmpty())Text(trailing,style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)else Glyph("chevron",color=MaterialTheme.colorScheme.outline)}}}
@Composable internal fun ContentList(ui:UiActions,content:@Composable ColumnScope.()->Unit){
    val scroll=rememberScrollState();var pull by remember{mutableFloatStateOf(0f)}
    val connection=remember(scroll){object:NestedScrollConnection{
        override fun onPreScroll(available:Offset,source:NestedScrollSource):Offset{if(source==NestedScrollSource.UserInput){if(scroll.value==0&&available.y>0)pull+=available.y else pull=0f};return Offset.Zero}
        override suspend fun onPostFling(consumed:Velocity,available:Velocity):Velocity{if(pull>150f&&ui.vm.state.value.activeGame.isEmpty())ui.modal=Modal.Games;pull=0f;return Velocity.Zero}
    }}
    Column(Modifier.fillMaxSize().nestedScroll(connection).verticalScroll(scroll).padding(horizontal=20.dp,vertical=8.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){content();Spacer(Modifier.height(24.dp))}
}
@Composable internal fun MessageImage(image:JSONObject?,ui:UiActions,onClick:()->Unit={}) {
    if(image==null)return
    val encoded=image.str("base64");if(encoded.isEmpty()||encoded.length>1_400_000)return
    val bitmap by produceState<android.graphics.Bitmap?>(null,encoded){value=withContext(Dispatchers.Default){runCatching{val bytes=Base64.decode(encoded,Base64.DEFAULT);val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds);var sample=1;while(bounds.outWidth/sample>800||bounds.outHeight/sample>800)sample*=2;BitmapFactory.decodeByteArray(bytes,0,bytes.size,BitmapFactory.Options().apply{inSampleSize=sample})}.getOrNull()}}
    bitmap?.let {Image(it.asImageBitmap(),"图片，长按收藏表情包",Modifier.widthIn(max=260.dp).heightIn(max=280.dp).clip(RoundedCornerShape(16.dp)).combinedClickable(onClick=onClick,onLongClick={ui.vm.collect(image)}),contentScale=ContentScale.Fit)}
}
@Composable internal fun Bubble(ui:UiActions,m:JSONObject,self:Boolean,text:String=m.str("text")+m.str("emoji"),label:String=m.str("senderNickname",m.str("sender"))){
    Column(Modifier.fillMaxWidth(),horizontalAlignment=if(self)Alignment.End else Alignment.Start,verticalArrangement=Arrangement.spacedBy(5.dp)){
        Text("$label · ${time(m.str("at"))}",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant,modifier=if(m.str("sender").matches(Regex("\\d{5,12}H?")))Modifier.clickable{ui.go("profile",m.str("sender"))}else Modifier)
        Surface(shape=RoundedCornerShape(topStart=22.dp,topEnd=22.dp,bottomStart=if(self)22.dp else 6.dp,bottomEnd=if(self)6.dp else 22.dp),color=if(self)MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,modifier=Modifier.widthIn(max=560.dp)){
            Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){if(text.isNotEmpty())androidx.compose.foundation.text.selection.SelectionContainer{Text(text,style=MaterialTheme.typography.bodyLarge,color=if(self)MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface)};MessageImage(m.optJSONObject("image"),ui)}
        }
    }
}
@Composable private fun ModalContent(ui:UiActions,state:ClientState){when(val modal=ui.modal){
    null->Unit
    is Modal.Confirm->AlertDialog(onDismissRequest={ui.modal=null},title={Text(modal.title)},text={Text(modal.message)},confirmButton={TextButton(onClick={ui.modal=null;modal.submit()}){Text("确认")}},dismissButton={TextButton(onClick={ui.modal=null}){Text("取消")}})
    is Modal.Form->{val values=remember(modal){mutableStateMapOf<String,String>().apply{modal.fields.forEach{put(it.key,it.initial)}}};AlertDialog(onDismissRequest={ui.modal=null},title={Text(modal.title)},text={Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)){if(modal.hint.isNotEmpty())Text(modal.hint);modal.fields.forEach{f->OutlinedTextField(values[f.key]?:"",{values[f.key]=it},Modifier.fillMaxWidth(),label={Text(f.label)},visualTransformation=if(f.secret)PasswordVisualTransformation()else VisualTransformation.None,singleLine=true)}}},confirmButton={TextButton(onClick={ui.modal=null;modal.submit(values.toMap())}){Text("确定")}},dismissButton={TextButton(onClick={ui.modal=null}){Text("取消")}})}
    Modal.Games,Modal.More->ModalBottomSheet(onDismissRequest={ui.modal=null}){Column(Modifier.navigationBarsPadding().padding(24.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
        SectionTitle(if(modal==Modal.Games)"一起玩一局" else "开启新的故事",if(modal==Modal.Games)"下拉页面，也能找到游戏小程序。" else "朋友、群聊和你的 bot，都在这里。")
        val entries=if(modal==Modal.Games)listOf(Triple("狼人杀","预约、参加，与 bot 同场推理","games"),Triple("我的 bot 对局","私密局、公开局与历史记录","botGames"),Triple("公开游戏","观看狼人杀与剧本杀","publicGames"))else listOf(Triple("添加朋友","通过昵称或 ID 搜索","search"),Triple("发起群聊","邀请朋友们一起聊聊","groupCreate"),Triple("我的 bot","给当前绑定的 bot 发消息","owner"),Triple("Bot 会话","只读查看它的私聊和群聊","chats"),Triple("Bot 动态","看看它与好友的日常","feed"))
        entries.forEach{(title,hint,page)->Entry(title,hint){if(page=="publicGames"){ui.go("botGames",kind="public")}else ui.go(page,kind=if(page=="botGames")"own" else "private")}}
    }}
    is Modal.Stickers->ModalBottomSheet(onDismissRequest={ui.modal=null}){
        var pictures by remember{mutableStateOf<List<JSONObject>>(emptyList())};var files by remember{mutableStateOf<List<java.io.File>>(emptyList())};var offset by remember{mutableIntStateOf(0)}
        LaunchedEffect(Unit){files=ui.vm.favorites()};LaunchedEffect(files,offset){pictures=files.drop(offset).take(12).map{ui.vm.sticker(it)}}
        Column(Modifier.padding(24.dp).navigationBarsPadding(),verticalArrangement=Arrangement.spacedBy(12.dp)){SectionTitle("我的表情包","长按聊天里的图片即可收藏。");if(files.isEmpty())EmptyState("还没有收藏","收到喜欢的表情包时，长按保存。")
            pictures.chunked(3).forEach { row->Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)){row.forEach{picture->Surface(onClick={ui.modal=null;modal.select(picture)},shape=RoundedCornerShape(20.dp),color=MaterialTheme.colorScheme.surfaceContainer,modifier=Modifier.weight(1f).height(100.dp)){Box(Modifier.padding(8.dp),contentAlignment=Alignment.Center){MessageImage(picture,ui){ui.modal=null;modal.select(picture)}}}};repeat(3-row.size){Spacer(Modifier.weight(1f))}}}
            Row{TextButton(enabled=offset>0,onClick={offset-=12}){Text("上一页")};Spacer(Modifier.weight(1f));TextButton(enabled=offset+12<files.size,onClick={offset+=12}){Text("下一页")}}
        }
    }
}}
