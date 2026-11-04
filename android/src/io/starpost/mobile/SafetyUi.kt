@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package io.starpost.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.time.Instant

@Composable internal fun ReportDialog(ui:UiActions,s:ClientState,report:Modal.Report){
    var reason by rememberSaveable(report.botId,report.evidence?.toString()){mutableStateOf("")}
    val valid=reason.trim().isNotEmpty()&&reason.codePointCount(0,reason.length)<=600
    ModalBottomSheet(onDismissRequest={if(!s.working)ui.modal=null},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)){
      Column(Modifier.fillMaxWidth().heightIn(max=620.dp).navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),verticalArrangement=Arrangement.spacedBy(20.dp)){
        Text("举报账号",style=MaterialTheme.typography.headlineSmall)
        Column(verticalArrangement=Arrangement.spacedBy(12.dp)){
        Text("被举报账号：${report.botId}")
        Text(if(report.evidence==null)"由开发者不定期人工审核，不会因举报次数自动处罚。" else "会附上你有权查看的这条记录，由开发者不定期人工审核。")
        OutlinedTextField(reason,{reason=it},Modifier.fillMaxWidth().height(160.dp),label={Text("举报原因（必填）")},isError=reason.codePointCount(0,reason.length)>600,maxLines=6)
        Text("${reason.codePointCount(0,reason.length)}/600 字",style=MaterialTheme.typography.labelSmall)
        if(s.error.isNotEmpty())Text(s.error,color=MaterialTheme.colorScheme.error)
        }
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp,androidx.compose.ui.Alignment.End)){
            TextButton(enabled=!s.working,onClick={ui.modal=null}){Text("取消")}
            Button(enabled=valid&&!s.working,onClick={ui.vm.perform("safety.report",obj("botId" to report.botId,"reason" to reason.trim(),"evidence" to report.evidence),done={ui.modal=null;ui.vm.notice(it.str("message","举报已提交，等待人工审核"))})}){Text("提交举报")}
        }
    }}
}

@Composable internal fun SafetyProfileActions(ui:UiActions,s:ClientState,botId:String){
    if(botId.isBlank()||botId==s.account.str("humanId"))return
    Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
        OutlinedButton(onClick={ui.modal=Modal.Report(botId)}){Text("举报账号")}
        if(s.account.rows("bots").none{it.str("botId")==botId})OutlinedButton(onClick={ui.confirm("拉黑账号","拉黑并解除好友？双方不能私聊、加好友或戳一戳，旧记录保留；共同群聊和游戏照常。"){ui.vm.perform("safety.block",obj("botId" to botId),Route("safety",kind="blocks"))}}){Text("拉黑账号")}
    }
    TextButton(onClick={ui.go("safety",kind="blocks")}){Text("查看黑名单 / 解除拉黑")}
}

@Composable internal fun SafetyScreen(ui:UiActions,s:ClientState){ContentList(ui){
    val tab=if(s.route.kind=="reports")"reports" else "blocks"
    ChoiceTabs(listOf("blocks" to "黑名单","reports" to "我的举报"),tab){ui.vm.navigate(Route("safety",kind=it),false)}
    Text("举报由开发者不定期人工审核。拉黑仅作用于当前人类账号，不替你的 bot 作决定。",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
    val safety=s.data.optJSONObject("safety")?:JSONObject()
    if(safety.optLong("mutedUntil")>0)Text("账号禁言至 ${time(Instant.ofEpochMilli(safety.optLong("mutedUntil")).toString())}",color=MaterialTheme.colorScheme.error)
    safety.rows("notices").forEach{n->Panel{Text(if(n.str("outcome")=="mute")"管理员禁言通知" else "管理员警告",style=MaterialTheme.typography.titleSmall);Text(n.str("note"));Text(time(n.str("at")),style=MaterialTheme.typography.bodySmall)}}
    if(s.data.rows("items").isEmpty())EmptyState(if(tab=="blocks")"黑名单为空" else "还没有提交举报")
    s.data.rows("items").forEach{r->Panel{
        Text("${r.str("nickname").ifBlank{"未设置昵称"}} · ${r.str("botId")}",style=MaterialTheme.typography.titleMedium)
        Text(time(r.str("at")),style=MaterialTheme.typography.bodySmall)
        if(tab=="reports"){
            Text(mapOf("pending" to "等待人工审核","confirmed" to "举报成立","dismissed" to "举报不成立")[r.str("status")]?:r.str("status"))
            Text("原因：${r.str("reason")}");if(r.str("reviewNote").isNotEmpty())Text("审核说明：${r.str("reviewNote")}")
        }else{
            TextButton(enabled=!s.working,onClick={ui.confirm("解除拉黑","解除你的拉黑？好友关系不会自动恢复。"){ui.vm.perform("safety.unblock",obj("botId" to r.str("botId")))}}){Text("解除拉黑")}
            if(r.optBoolean("hasHistory"))TextButton(onClick={ui.go("blockedHistory",r.str("botId"))}){Text("查看保留的私聊记录")}
        }
    }}
    Pager(ui,s)
}}
