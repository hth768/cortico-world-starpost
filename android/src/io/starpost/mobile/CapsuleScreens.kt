package io.starpost.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

internal class CapsuleDraft {
    var text by mutableStateOf("")
    val images = mutableStateListOf<JSONObject>()
    var amount by mutableStateOf("1")
    var unit by mutableStateOf("weeks")
    var mode by mutableStateOf("relative")
    var date by mutableStateOf("")
    var requestId = UUID.randomUUID().toString()
    fun changed() { requestId = UUID.randomUUID().toString() }
    fun clear() { text = ""; images.clear(); changed() }
}
private fun capsuleDate(value:String) = runCatching { DateTimeFormatter.ofPattern("yyyy年M月d日 HH:mm").withZone(ZoneId.of("Asia/Shanghai")).format(Instant.parse(value)) }.getOrDefault(value)

@Composable internal fun CapsuleScreen(ui:UiActions,s:ClientState) {
    if(s.route.page == "newCapsule") { CapsuleComposer(ui,s); return }
    ContentList(ui) {
        if(s.route.page == "capsule") {
            val c=s.data
            if(c.str("id").isEmpty())return@ContentList
            SectionTitle("来自过去的自己", "${capsuleDate(c.str("createdAt"))} 写下")
            Panel {
                Text("约定在 ${capsuleDate(c.str("opensAt"))} 开启 · 北京时间",style=MaterialTheme.typography.labelLarge)
                Text(c.str("text"),style=MaterialTheme.typography.bodyLarge)
                c.rows("images").forEach { MessageImage(it,ui) }
            }
            TextButton(onClick={ui.go("capsules")}) { Text("返回时间胶囊") }
        } else {
            InfoCard("把此刻，寄给未来的自己", "一句期待，三张照片，留给下一次相遇。仅本人可见，到期后才能打开。", "mail")
            Button(onClick={ui.go("newCapsule")}) { Text("写给未来的我") }
            Text("${s.data.optInt("sealed")} 份封存中 · ${s.data.optInt("unread")} 份到期未读",style=MaterialTheme.typography.labelLarge)
            s.data.rows("items").forEach { c -> Panel {
                Text(if(c.optBoolean("ready"))if(c.str("openedAt").isEmpty())"等待你开启" else "已开启" else "封存中",color=MaterialTheme.colorScheme.primary)
                Text("${capsuleDate(c.str("opensAt"))} 开启",style=MaterialTheme.typography.titleMedium)
                Text("${capsuleDate(c.str("createdAt"))} 写下 · ${c.optInt("imageCount")} 张图片 · 北京时间",style=MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                    if(c.optBoolean("ready"))FilledTonalButton(onClick={ui.go("capsule",c.str("id"))}) { Text("打开时间胶囊") }
                    TextButton(enabled=!s.working,onClick={ui.confirm("删除时间胶囊","永久删除这份时间胶囊？删除后无法找回。") { ui.vm.perform("capsule.delete",obj("capsuleId" to c.str("id")),s.route) }}) { Text("删除",color=MaterialTheme.colorScheme.error) }
                }
            } }
            if(s.data.rows("items").isEmpty())EmptyState("这里还没有信", "给未来的自己留下一点今天吧。")
            Pager(ui,s)
        }
    }
}

@Composable private fun CapsuleComposer(ui:UiActions,s:ClientState) {
    val d=remember(s.account.str("humanId")){ui.vm.capsuleDraft()}
    ContentList(ui) {
        SectionTitle("写给未来的我", "封存后不能提前读取或修改；可以删除。")
        OutlinedTextField(d.text,{d.text=it;d.changed()},Modifier.fillMaxWidth(),enabled=!s.working,label={Text("时间胶囊留言")},minLines=4,maxLines=10,isError=d.text.codePointCount(0,d.text.length)>600,supportingText={Text("${d.text.codePointCount(0,d.text.length)} / 600 字 · ${d.images.size} / 3 张图片")})
        ChoiceTabs(listOf("weeks" to "1 周后","months" to "1 个月后","years" to "1 年后"),if(d.mode=="relative"&&d.amount=="1")d.unit else "") { d.unit=it;d.amount="1";d.mode="relative";d.changed() }
        ChoiceTabs(listOf("relative" to "多久之后","absolute" to "指定日期"),d.mode){d.mode=it;d.changed()}
        if(d.mode=="relative") {
            OutlinedTextField(d.amount,{d.amount=it.filter(Char::isDigit).take(10);d.changed()},Modifier.fillMaxWidth(),enabled=!s.working,label={Text("多久以后")},keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number),singleLine=true)
            ChoiceTabs(listOf("minutes" to "分钟","hours" to "小时","days" to "天","weeks" to "周","months" to "月","years" to "年"),d.unit){d.unit=it;d.changed()}
        } else OutlinedTextField(d.date,{d.date=it.take(16);d.changed()},Modifier.fillMaxWidth(),enabled=!s.working,label={Text("开启时间（北京时间）")},placeholder={Text("2027-01-01 09:00")},supportingText={Text("格式：年-月-日 时:分")},singleLine=true)
        Text("月、年按北京时间日历计算；月末自动取目标月最后一天。",style=MaterialTheme.typography.bodySmall)
        Row(verticalAlignment=Alignment.CenterVertically) {
            ChatPhotoButton(ui,!s.working&&d.images.size<3,"添加到时间胶囊") { if(d.images.size<3){d.images.add(it);d.changed()} }
            Text("添加图片（${d.images.size}/3）")
        }
        d.images.toList().forEachIndexed { i,image -> Panel { MessageImage(image,ui);TextButton(enabled=!s.working,onClick={d.images.removeAt(i);d.changed()}){Text("移除图片 ${i+1}")} } }
        Button(enabled=!s.working&&(d.text.isNotBlank()||d.images.isNotEmpty())&&d.text.codePointCount(0,d.text.length)<=600,onClick={
            try {
                val args=obj("text" to d.text,"images" to JSONArray(d.images.toList()),"requestId" to d.requestId)
                if(d.mode=="absolute") {
                    val at=LocalDateTime.parse(d.date,DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm").withResolverStyle(java.time.format.ResolverStyle.STRICT)).atOffset(ZoneOffset.ofHours(8))
                    args.put("opensAt",at.toString())
                } else { val amount=d.amount.toLongOrNull();require(amount!=null&&amount>0){"请填写正整数时长"};args.put("afterValue",amount);args.put("afterUnit",d.unit) }
                ui.vm.perform("capsule.create",args,Route("capsules")){c->d.clear();ui.vm.notice("已封存，${capsuleDate(c.str("opensAt"))} 开启")}
            }catch(e:Exception){ui.vm.notice(if(d.mode=="absolute")"请按 2027-01-01 09:00 格式填写有效日期" else e.message?:"请检查开启时间")}
        },modifier=Modifier.fillMaxWidth()) { Text("封存时间胶囊") }
        Text("每张图片最多 1 MiB，超大静态图片会压缩。未封存草稿保留到退出登录或应用结束。到期提醒在打开应用时显示。",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
