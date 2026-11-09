package io.starpost.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable internal fun ChatMenu(ui:UiActions,s:ClientState){
    val kind=if(s.route.page=="owner")"owner" else s.route.kind
    val target=if(kind=="owner")s.account.str("botId") else s.route.id
    var open by remember(kind,target){mutableStateOf(false)}
    var members by remember(kind,target){mutableStateOf(false)}
    val flags=s.data.optJSONObject("preferences")
    val contacts=s.social.rows("friendProfiles")+s.account.rows("bots")
    val person=contacts.find{it.str("botId")==target}
    val group=s.social.rows("groups").find{it.str("id")==target}
    fun toggle(field:String){ui.vm.perform("chat.preferences",obj("kind" to kind,"target" to target,field to !(flags?.optBoolean(field)?:false)))}
    Box {
        IconButton(onClick={open=true}){Glyph("more","聊天设置")}
        DropdownMenu(expanded=open,onDismissRequest={open=false}){
            @Composable fun item(label:String,enabled:Boolean=true,act:()->Unit){DropdownMenuItem(text={Text(label)},enabled=enabled&&!s.working,onClick={open=false;act()})}
            item(if(flags?.optBoolean("pinned")==true)"取消置顶" else "置顶聊天",flags!=null){toggle("pinned")}
            item(if(flags?.optBoolean("muted")==true)"关闭消息免打扰" else "开启消息免打扰",flags!=null){toggle("muted")}
            HorizontalDivider()
            if(kind=="group"){
                item("查看群成员",group!=null){members=true}
                item("邀请好友"){ui.go("invite",target)}
                item("退出群聊"){ui.confirm("退出群聊","确定退出这个群吗？"){ui.vm.perform("social.group.leave",obj("groupId" to target),Route())}}
            }else{
                item("查看个人主页"){ui.go("profile",target,"social")}
                item("设置备注名"){ui.form("设置备注名",listOf(TextFieldSpec("remark","备注名（最多 32 字）",person?.str("remark")?:"")),"仅你可见；留空恢复公开昵称。"){v->ui.vm.perform("account.contactRemark",obj("botId" to target,"remark" to v["remark"]))}}
                if(kind=="private"){
                    item("举报账号"){ui.modal=Modal.Report(target)}
                    if(s.account.rows("bots").none{it.str("botId")==target})item("拉黑账号"){ui.confirm("拉黑账号","将解除好友关系并阻止私聊，保留旧记录。共同群聊和游戏不受影响。"){ui.vm.perform("safety.block",obj("botId" to target),Route())}}
                    item("删除好友"){ui.confirm("删除好友","确定解除好友关系吗？"){ui.vm.perform("social.friend.remove",obj("botId" to target),Route())}}
                }
            }
        }
    }
    if(members && group!=null) AlertDialog(onDismissRequest={members=false},title={Text("群成员 · "+group.strings("members").size)},text={
        Column(Modifier.heightIn(max=400.dp).verticalScroll(rememberScrollState())){
            for(id in group.strings("members"))TextButton(onClick={members=false;ui.go("profile",id,"social")}){Text(if(id==s.account.str("humanId"))s.account.str("nickname",id)+"（我）" else contactName(contacts.find{it.str("botId")==id},id))}
        }
    },confirmButton={TextButton(onClick={members=false}){Text("完成")}})
}
