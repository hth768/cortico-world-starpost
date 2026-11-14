package io.starpost.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable internal fun ChatHistorySearchDialog(
    ui:UiActions,s:ClientState,onDismiss:()->Unit,
    read:suspend (String,JSONObject)->JSONObject={action,args->ui.vm.readChatHistory(action,args)}
) {
    val owner=s.route.page=="owner"
    val viewer=s.route.page=="history"
    val kind=if(owner)"owner" else s.route.kind
    val target=if(owner)s.account.str("botId") else s.route.id
    val prefix=if(owner)"owner" else if(viewer)"history" else "social.history"
    val title=if(owner)contactName(s.account.rows("bots").find{it.str("botId")==target},"我的 bot") else conversationName(if(viewer)s.overview else s.social,target,kind)
    val source=remember(prefix,kind,target,s.account.str("botId")){obj("kind" to kind,"target" to target).apply{if(owner||viewer)put("viewerBotId",s.account.str("botId"))}}
    var query by rememberSaveable{mutableStateOf("")}
    var start by rememberSaveable{mutableStateOf("")}
    var end by rememberSaveable{mutableStateOf("")}
    var dates by rememberSaveable{mutableStateOf(false)}
    var busy by remember{mutableStateOf(false)}
    var error by remember{mutableStateOf("")}
    var searched by remember{mutableStateOf(false)}
    var applied by remember{mutableStateOf(obj())}
    var next by remember{mutableStateOf<Long?>(null)}
    var results by remember{mutableStateOf(emptyList<JSONObject>())}
    var context by remember{mutableStateOf<JSONObject?>(null)}
    val scope=rememberCoroutineScope()
    val keyboard=LocalSoftwareKeyboardController.current
    val focus=LocalFocusManager.current
    val resultsScroll=rememberLazyListState()
    val contextScroll=rememberLazyListState()
    fun search(more:Boolean=false){
        if(busy)return
        keyboard?.hide();focus.clearFocus()
        val filters=if(more)applied else obj("query" to query.trim(),"startDate" to start.trim(),"endDate" to end.trim())
        busy=true;error=""
        scope.launch{try{
            val args=JSONObject(source.toString());filters.keys().forEach{args.put(it,filters.get(it))};if(more)args.put("before",next)
            val page=read("$prefix.search",args)
            results=if(more)(results+page.rows("messages")).distinctBy{it.str("id")} else page.rows("messages")
            next=if(page.isNull("nextBefore"))null else page.optLong("nextBefore")
            applied=filters;searched=true
            if(!more)resultsScroll.scrollToItem(0)
        }catch(e:CancellationException){throw e}catch(e:Exception){error=e.message?:"搜索失败，请重试"}finally{busy=false}}
    }
    fun open(id:String){
        if(busy)return
        busy=true;error=""
        scope.launch{try{context=read("$prefix.context",JSONObject(source.toString()).put("messageId",id))}
        catch(e:CancellationException){throw e}catch(e:Exception){error=e.message?:"读取失败，请重试"}finally{busy=false}}
    }
    LaunchedEffect(context){context?.let{c->val index=c.rows("messages").indexOfFirst{it.str("id")==c.str("anchorId")};contextScroll.scrollToItem((index.coerceAtLeast(0)+if(c.optBoolean("hasOlder"))1 else 0))}}
    Dialog(onDismissRequest={if(context!=null){context=null;error=""}else onDismiss()},properties=DialogProperties(usePlatformDefaultWidth=false)){
        Surface(Modifier.fillMaxSize(),color=MaterialTheme.colorScheme.background){Column(Modifier.safeDrawingPadding().imePadding()){
            Row(Modifier.fillMaxWidth().padding(horizontal=8.dp),verticalAlignment=Alignment.CenterVertically){
                IconButton(onClick={if(context!=null){context=null;error=""}else onDismiss()}){Glyph("back",if(context==null)"关闭搜索" else "返回搜索结果")}
                Column(Modifier.weight(1f)){Text(if(context==null)"查找聊天记录" else "消息上下文",style=MaterialTheme.typography.titleLarge);Text(title,maxLines=1,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.labelMedium)}
                if(context!=null)TextButton(onClick=onDismiss){Text("关闭")}
            }
            if(context==null){
                Column(Modifier.padding(horizontal=16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
                    OutlinedTextField(query,{query=it.take(100)},Modifier.fillMaxWidth(),label={Text("关键词")},singleLine=true,keyboardOptions=KeyboardOptions(imeAction=ImeAction.Search),keyboardActions=KeyboardActions(onSearch={search()}))
                    Row(verticalAlignment=Alignment.CenterVertically){TextButton(onClick={dates=!dates}){Text(if(dates)"收起日期" else "按日期筛选")};Spacer(Modifier.weight(1f));Button(enabled=!busy,onClick={search()}){Text("搜索")}}
                    if(dates){Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
                        OutlinedTextField(start,{start=it.take(10)},Modifier.weight(1f),label={Text("开始日期")},placeholder={Text("YYYY-MM-DD")},singleLine=true)
                        OutlinedTextField(end,{end=it.take(10)},Modifier.weight(1f),label={Text("结束日期")},placeholder={Text("YYYY-MM-DD")},singleLine=true)
                    }}
                    Text(if(start.isNotBlank()||end.isNotBlank())"北京时间：${start.ifBlank{"不限"}} 至 ${end.ifBlank{"不限"}}" else "搜索本会话保留的文字 · 日期按北京时间",style=MaterialTheme.typography.bodySmall)
                }
            }
            if(busy)LinearProgressIndicator(Modifier.fillMaxWidth().padding(top=8.dp))
            if(error.isNotEmpty())Text(error,Modifier.padding(16.dp),color=MaterialTheme.colorScheme.error)
            val c=context
            if(c==null)LazyColumn(state=resultsScroll,modifier=Modifier.weight(1f),contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
                if(!searched)item{Text("输入关键词，或选择日期，查找以前聊过的内容。")}
                else if(results.isEmpty())item{Text(if(next!=null)"这批记录没有匹配，可继续搜索更早记录。" else "没有找到匹配的聊天记录。")}
                items(results,key={it.str("id")}){m->OutlinedCard(onClick={open(m.str("id"))},enabled=!busy,modifier=Modifier.fillMaxWidth()){
                    Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
                        Text(m.str("senderNickname",m.str("sender")),style=MaterialTheme.typography.titleSmall)
                        AccountTitleBadge(m.str("senderTitle"),style=m.optJSONObject("senderTitleStyle"))
                        Text(historyTime(m.str("at")),style=MaterialTheme.typography.labelSmall)
                        Text((m.str("text")+m.str("emoji")).ifBlank{if(m.optBoolean("hasImage"))"[图片]" else "[聊天记录]"},maxLines=4,overflow=TextOverflow.Ellipsis)
                        Text("查看上下文 →",color=MaterialTheme.colorScheme.primary,style=MaterialTheme.typography.labelMedium)
                    }
                }}
                if(next!=null)item{OutlinedButton(enabled=!busy,onClick={search(true)},modifier=Modifier.fillMaxWidth()){Text("继续搜索更早记录")}}
                else if(results.isNotEmpty())item{Text("已搜索完符合条件的保留记录",style=MaterialTheme.typography.bodySmall)}
            } else LazyColumn(state=contextScroll,modifier=Modifier.weight(1f),contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
                if(c.optBoolean("hasOlder"))item{TextButton(enabled=!busy,onClick={open(c.rows("messages").first().str("id"))}){Text("继续查看更早上下文")}}
                items(c.rows("messages"),key={it.str("id")}){m->Column{
                    if(m.str("id")==c.str("anchorId"))Text("定位消息",color=MaterialTheme.colorScheme.primary,style=MaterialTheme.typography.labelMedium)
                    Bubble(ui,m,if(owner)m.str("direction")=="human" else m.str("sender")==s.account.str(if(viewer)"botId" else "humanId"),selected=m.str("id")==c.str("anchorId"))
                }}
                if(c.optBoolean("hasNewer"))item{TextButton(enabled=!busy,onClick={open(c.rows("messages").last().str("id"))}){Text("继续查看较新上下文")}}
            }
        }}
    }
}

internal fun historyTime(value:String):String=runCatching{
    java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(java.time.ZoneId.of("Asia/Shanghai")).format(java.time.Instant.parse(value))
}.getOrDefault(value)
