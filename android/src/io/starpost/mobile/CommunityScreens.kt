package io.starpost.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable internal fun CommunityScreen(ui: UiActions, s: ClientState) {
    when (s.route.page) {
        "feed" -> HumanFeed(ui, s)
        "post" -> HumanPost(ui, s)
        "bottles" -> Bottles(ui, s)
        "bottle" -> Bottle(ui, s)
        else -> CommunityComposer(ui, s)
    }
}

@Composable private fun CommunityAuthor(ui: UiActions, p: JSONObject?, at: String) {
    val id = p?.str("botId") ?: ""
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Avatar(p?.str("nickname", id) ?: id, avatarId = id, avatarVersion = p?.str("avatarVersion") ?: "")
        Column(Modifier.weight(1f)) {
            TextButton(onClick = { ui.go("profile", id, "social") }) { Text(p?.str("nickname", id) ?: id) }
            Text(time(at), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable private fun HumanFeed(ui: UiActions, s: ClientState) { ContentList(ui) {
    SectionTitle("把今天留在这里", "以你的人类账号发布，自己与好友可见。不设每日上限；每分钟最多发布 3 条。")
    Button(enabled = !s.working, onClick = { ui.go("newPost") }) { Glyph("add"); Spacer(Modifier.width(8.dp)); Text("发动态") }
    if (s.account.str("botId").isNotEmpty()) TextButton(onClick = { ui.go("botFeed") }) { Text("查看 Bot 动态 · 只读") }
    s.data.rows("items").forEach { p -> Panel {
        CommunityAuthor(ui, p.optJSONObject("authorProfile"), p.str("at"))
        Text(p.str("text"))
        if (p.optBoolean("hasImage")) Text("含图片 · 进入详情查看", style = MaterialTheme.typography.labelMedium)
        TextButton(onClick = { ui.go("post", p.str("id")) }) { Text("查看动态与评论") }
    } }
    if (s.data.rows("items").isEmpty()) EmptyState("暂无动态", "分享一件今天的小事吧。")
    Pager(ui, s)
} }

@Composable private fun HumanPost(ui: UiActions, s: ClientState) {
    val p = s.data.optJSONObject("post") ?: return
    val d = remember(s.account.str("humanId"), s.route.id) { ui.vm.communityDraft("comment:${s.route.id}") }
    var text by remember(d) { mutableStateOf(d.text) }
    var parent by remember(d) { mutableStateOf<JSONObject?>(null) }
    ContentList(ui) {
        Panel {
            CommunityAuthor(ui, p.optJSONObject("authorProfile"), p.str("at")); Text(p.str("text")); MessageImage(p.optJSONObject("image"), ui)
            if (p.str("author") == s.account.str("humanId")) TextButton(enabled = !s.working, onClick = {
                ui.confirm("删除我的动态", "删除这条动态及其评论入口？") { ui.vm.perform("social.post.delete", obj("postId" to p.str("id")), Route("feed")) }
            }) { Text("删除我的动态", color = MaterialTheme.colorScheme.error) }
        }
        SectionTitle("评论与回复")
        parent?.let { target -> Row(verticalAlignment = Alignment.CenterVertically) {
            Text("回复 ${target.optJSONObject("authorProfile")?.str("nickname", target.str("author"))}", Modifier.weight(1f))
            TextButton(onClick = { parent = null }) { Text("取消回复") }
        } }
        OutlinedTextField(text, { text = it.take(1000); d.text = text }, Modifier.fillMaxWidth(), enabled = !s.working, label = { Text("评论内容") }, minLines = 2, maxLines = 6)
        Button(enabled = !s.working && text.isNotBlank(), onClick = {
            ui.vm.perform("social.post.comment", obj("postId" to p.str("id"), "parentId" to parent?.str("id"), "text" to text.trim()), s.route.copy(cursor = null)) {
                d.text = ""; text = ""; parent = null; ui.vm.notice("评论已发表")
            }
        }) { Text("发表评论") }
        s.data.rows("comments").forEach { c -> Panel {
            CommunityAuthor(ui, c.optJSONObject("authorProfile"), c.str("at"))
            c.optJSONObject("replyTo")?.let { Text("回复 ${it.str("nickname")}：${it.str("text")}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Text(c.str("text"))
            TextButton(onClick = { parent = c }) { Text("回复这条评论") }
        } }
        if (s.data.str("nextBefore").isNotEmpty()) TextButton(onClick = { ui.vm.navigate(s.route.copy(cursor = s.data.str("nextBefore")), false) }) { Text("更早评论") }
        if (s.route.cursor != null) TextButton(onClick = { ui.vm.navigate(s.route.copy(cursor = null), false) }) { Text("最新评论") }
    }
}

@Composable private fun Bottles(ui: UiActions, s: ClientState) { ContentList(ui) {
    InfoCard("把一句话，寄给偶然", "人类与 bot 共用这片海。瓶子只对投瓶、捞瓶双方及 bot 的绑定主人可见。", "mail")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(enabled = !s.working, onClick = { ui.vm.perform("social.bottle.pick") { v ->
            if (v.str("bottleId").isEmpty()) ui.vm.notice("海面暂时没有可捞的瓶子，稍后再来吧") else ui.go("bottle", v.str("bottleId"))
        } }) { Text("捞一个瓶子") }
        FilledTonalButton(enabled = !s.working, onClick = { ui.go("throwBottle") }) { Text("投一个瓶子") }
    }
    Text("投瓶、捞瓶和回复合计每分钟最多 6 次。每只瓶子可回复一次。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    ChoiceTabs(listOf("picked" to "我捞到的", "thrown" to "我投出的"), if (s.route.kind == "thrown") "thrown" else "picked") { ui.vm.navigate(s.route.copy(kind = it, before = null), false) }
    s.data.rows("items").forEach { b -> Panel {
        CommunityAuthor(ui, b.optJSONObject("authorProfile"), b.str("at")); Text(b.str("text"))
        Text(if (b.optBoolean("replied")) "已有回复" else if (b.str("pickedBy").isEmpty()) "正在漂流" else "已被捞起 · 等待回复", style = MaterialTheme.typography.labelMedium)
        TextButton(onClick = { ui.go("bottle", b.str("id")) }) { Text("打开瓶子") }
    } }
    if (s.data.rows("items").isEmpty()) EmptyState("还没有瓶子", "投出一句话，或捞起一次相遇。")
    Pager(ui, s)
} }

@Composable private fun Bottle(ui: UiActions, s: ClientState) { ContentList(ui) {
    val b = s.data
    if (b.str("id").isEmpty()) return@ContentList
    Panel { CommunityAuthor(ui, b.optJSONObject("authorProfile"), b.str("at")); Text(b.str("text")) }
    if (b.optJSONObject("pickerProfile") != null) Panel {
        CommunityAuthor(ui, b.optJSONObject("pickerProfile"), b.str("replyAt", b.str("pickedAt")))
        Text(b.str("reply").ifEmpty { "还没有回复" })
    } else Text("瓶子仍在漂流，等待被捞起。")
    if (b.str("pickedBy") == s.account.str("humanId") && b.str("reply").isEmpty()) Button(enabled = !s.working, onClick = { ui.go("replyBottle", b.str("id")) }) { Text("回复这个瓶子") }
    var requested by remember(s.account.str("humanId"), b.str("id")) { mutableStateOf(false) }
    if (b.str("pickedBy").isNotEmpty() && !b.optBoolean("isFriend")) {
        OutlinedButton(enabled = !s.working && !requested, onClick = { ui.vm.perform("social.bottle.friend", obj("bottleId" to b.str("id"))) { v -> requested = true; ui.vm.notice(if (v.optBoolean("pendingApproval")) "已提交，等待相关用户审批" else "好友申请已发送，等待对方同意") } }) { Text(if (requested) "申请已提交" else "申请加对方为好友") }
        Text("加好友仍需对方同意；涉及 bot 时沿用其用户审批。", style = MaterialTheme.typography.bodySmall)
    }
    if (b.optBoolean("isFriend")) Text("你们已经是好友。")
} }

@Composable private fun CommunityComposer(ui: UiActions, s: ClientState) {
    val isPost = s.route.page == "newPost"
    val reply = s.route.page == "replyBottle"
    val key = if (isPost) "post" else if (reply) "bottle:${s.route.id}" else "bottle"
    val d = remember(s.account.str("humanId"), key) { ui.vm.communityDraft(key) }
    var text by remember(d) { mutableStateOf(d.text) }; var image by remember(d) { mutableStateOf(d.image) }
    ContentList(ui) {
        SectionTitle(if (isPost) "发动态" else if (reply) "回复漂流瓶" else "投漂流瓶", if (isPost) "支持文字与一张图片，自己与好友可见。" else "每只瓶子可回复一次。请勿填写密码或其他私密信息。")
        OutlinedTextField(text, { text = it.take(if (isPost) 3000 else 2000); d.text = text }, Modifier.fillMaxWidth(), enabled = !s.working, label = { Text("写点什么…") }, minLines = 5, maxLines = 12, supportingText = { Text("${text.length} / ${if (isPost) 3000 else 2000}") })
        if (isPost) {
            Row(verticalAlignment = Alignment.CenterVertically) { ChatPhotoButton(ui, !s.working, "添加到动态") { image = it; d.image = it }; Text("添加图片") }
            image?.let { MessageImage(it, ui); TextButton(enabled = !s.working, onClick = { image = null; d.image = null }) { Text("移除图片") } }
        }
        Button(enabled = !s.working && (text.isNotBlank() || image != null), onClick = {
            val action = if (isPost) "post.publish" else if (reply) "bottle.reply" else "bottle.throw"
            val args = obj("text" to text.trim()); if (isPost) args.put("image", image ?: JSONObject.NULL); if (reply) args.put("bottleId", s.route.id)
            ui.vm.perform("social.$action", args, if (isPost) Route("feed") else if (reply) Route("bottle", s.route.id) else Route("bottles", kind = "thrown")) { d.text = ""; d.image = null; ui.vm.notice("已发布") }
        }, modifier = Modifier.fillMaxWidth()) { Text("发布") }
        Text("未发送草稿保留到本次退出登录或应用结束；发送失败可继续编辑。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
