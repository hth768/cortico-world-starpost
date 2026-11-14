package io.starpost.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.IBinder
import kotlinx.coroutines.*
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID
import kotlin.math.min

internal class OwnerAlerts(private val context: Context) {
    companion object {
        const val SERVICE_CHANNEL = "owner-connection"
        const val MESSAGE_CHANNEL = "owner-replies"
        const val OPEN = "io.starpost.mobile.OPEN_OWNER"
        const val OPEN_CHAT = "io.starpost.mobile.OPEN_CHAT"
        const val SERVICE_ID = 7410
        var visibleBot: String? = null
        var refreshVisible: (() -> Unit)? = null
    }
    val prefs = context.getSharedPreferences("owner-alerts", Context.MODE_PRIVATE)
    private val manager = context.getSystemService(NotificationManager::class.java)
    val subscription get() = prefs.getString("subscription", null)
    val shouldOffer get() = subscription == null && !prefs.getBoolean("offeredChats", false)
    val pendingEnable get() = prefs.getBoolean("pendingChatEnable", false)
    fun answerOffer(enable: Boolean) {
        prefs.edit().putBoolean("offeredChats", true).putBoolean("pendingChatEnable", enable).apply()
    }
    private fun fingerprint(token: String) = MessageDigest.getInstance("SHA-256")
        .digest(token.toByteArray()).joinToString("") { "%02x".format(it) }

    fun channels() {
        manager.createNotificationChannel(NotificationChannel(SERVICE_CHANNEL, "星邮后台连接", NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel(MESSAGE_CHANNEL, "聊天新消息", NotificationManager.IMPORTANCE_HIGH))
    }
    fun permitted() = manager.areNotificationsEnabled() &&
        manager.getNotificationChannel(MESSAGE_CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE

    fun matches(id: String, token: String) = id == subscription && token.isNotEmpty() &&
        fingerprint(token) == prefs.getString("session", null)

    fun enable(token: String, cursors: JSONObject, chatCursor:Long?=null) {
        channels()
        check(permitted()) { "请在系统设置中允许「聊天新消息」通知" }
        prefs.edit().putString("session", fingerprint(token)).putString("subscription", UUID.randomUUID().toString())
            .putString("cursors", cursors.toString()).putLong("chatCursor",chatCursor?:-1).commit()
        try { resume() } catch (e: Exception) { disable(); throw e }
        answerOffer(false)
    }
    fun resume() {
        if (subscription != null) context.startForegroundService(Intent(context, OwnerNoticeService::class.java))
    }
    fun clearMessages() {
        manager.activeNotifications.filter { it.notification.channelId == MESSAGE_CHANNEL }.forEach { manager.cancel(it.tag, it.id) }
    }
    fun disable() {
        prefs.edit().remove("subscription").remove("session").remove("cursors").remove("chatCursor").commit()
        clearMessages()
        context.stopService(Intent(context, OwnerNoticeService::class.java))
    }
    fun cursors() = JSONObject(prefs.getString("cursors", "{}") ?: "{}")
    fun pollArgs()=obj("includeChats" to true,"cursors" to cursors(),"waitMs" to 25000).apply{
        val cursor=prefs.getLong("chatCursor",-1);if(cursor>=0)put("chatCursor",cursor)
    }
    fun seen(bot: String, cursor: Long) {
        if (subscription == null || bot.isEmpty()) return
        manager.cancel(bot, 1)
        val saved = cursors()
        if (cursor > saved.optLong(bot)) prefs.edit().putString("cursors", saved.put(bot, cursor).toString()).apply()
    }
    private fun openIntent(bot: String? = null): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (bot != null) {
            intent.action = OPEN
            intent.data = Uri.Builder().scheme("starpost").authority("owner").appendPath(subscription).appendPath(bot).build()
        }
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    fun connection(text: String): Notification = Notification.Builder(context, SERVICE_CHANNEL)
        .setSmallIcon(R.drawable.ic_owner_notice).setContentTitle("星邮消息提醒").setContentText(text)
        .setContentIntent(openIntent()).setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false).build()

    // Notification id and channel are scoped to a bot. A retry replaces its existing row.
    fun deliver(id: String, batch: JSONObject) {
        if (subscription != id || !permitted()) return
        if(batch.has("cursor")){
            val after=prefs.getLong("chatCursor",-1)
            for(item in batch.rows("items")){
                if(item.getLong("cursor")<=after)continue
                val kind=item.str("kind");val target=item.str("target")
                if(kind !in setOf("group","private","owner")||target.isBlank())continue
                val tap=Intent(context,MainActivity::class.java).setAction(OPEN_CHAT)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .setData(Uri.Builder().scheme("starpost").authority("chat").appendPath(id).appendPath(kind).appendPath(target).build())
                val pending=PendingIntent.getActivity(context,0,tap,PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                val hidden=Notification.Builder(context,MESSAGE_CHANNEL).setSmallIcon(R.drawable.ic_owner_notice)
                    .setContentTitle("星邮").setContentText("收到新的聊天消息").build()
                val message=Notification.Builder(context,MESSAGE_CHANNEL).setSmallIcon(R.drawable.ic_owner_notice)
                    .setContentTitle(item.str("title")).setContentText(item.str("preview"))
                    .setCategory(Notification.CATEGORY_MESSAGE).setVisibility(Notification.VISIBILITY_PRIVATE)
                    .setPublicVersion(hidden).setAutoCancel(true).setContentIntent(pending).build()
                manager.notify("$kind:$target",1,message)
            }
            prefs.edit().putLong("chatCursor",maxOf(after,batch.getLong("cursor"))).apply()
            return
        }
        val previous = cursors()
        val next = batch.getJSONObject("cursors")
        previous.keys().forEach { bot ->
            if (!next.has(bot)) manager.cancel(bot, 1)
            else next.put(bot, maxOf(previous.getLong(bot), next.getLong(bot)))
        }
        for (item in batch.rows("items")) {
            val bot = item.getString("botId")
            if (item.getLong("cursor") <= previous.optLong(bot)) continue
            if (visibleBot == bot) { refreshVisible?.invoke(); continue }
            val hidden = Notification.Builder(context, MESSAGE_CHANNEL).setSmallIcon(R.drawable.ic_owner_notice)
                .setContentTitle("星邮").setContentText("你的 bot 发来新消息").build()
            val message = Notification.Builder(context, MESSAGE_CHANNEL).setSmallIcon(R.drawable.ic_owner_notice)
                .setContentTitle(item.str("nickname", bot)).setContentText(item.str("preview", "新消息"))
                .setCategory(Notification.CATEGORY_MESSAGE).setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(hidden).setAutoCancel(true).setContentIntent(openIntent(bot)).build()
            manager.notify(bot, 1, message)
        }
        prefs.edit().putString("cursors", next.toString()).commit()
    }
}

class OwnerNoticeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val alerts by lazy { OwnerAlerts(this) }
    private var job: Job? = null
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        alerts.channels()
        startForeground(OwnerAlerts.SERVICE_ID, alerts.connection("正在接收聊天消息"))
        val subscription = alerts.subscription
        if (subscription == null || !alerts.permitted()) { alerts.disable(); stopSelf(); return START_NOT_STICKY }
        if (job?.isActive != true) job = scope.launch { listen(subscription) }
        return START_STICKY
    }
    private suspend fun listen(subscription: String) {
        var retry = 2000L
        var lastStatus = ""
        fun showStatus(text: String) {
            if (text != lastStatus) {
                getSystemService(NotificationManager::class.java).notify(OwnerAlerts.SERVICE_ID, alerts.connection(text))
                lastStatus = text
            }
        }
        while (currentCoroutineContext().isActive && alerts.subscription == subscription) {
            val saved = withContext(Dispatchers.IO) { runCatching { JSONObject(SessionStore(this@OwnerNoticeService).load()) }.getOrNull() }
            if (alerts.subscription != subscription) return
            if (saved == null || !alerts.matches(subscription, saved.str("token")) ||
                saved.optLong("expiresAt") <= System.currentTimeMillis() || !alerts.permitted()) { alerts.disable(); return }
            val args = alerts.pollArgs()
            val body = obj("action" to "owner.notifications", "args" to args)
            try {
                val reply = withContext(Dispatchers.IO) {
                    try { mobileRequest(saved.str("server"), "/mobile/rpc", body, saved.getString("token")) }
                    catch (e: ConnectionFailure) {
                        if (saved.str("server") != "https://starpost.com.cn") throw e
                        mobileRequest("https://8.148.13.225", "/mobile/rpc", body, saved.getString("token"))
                    }
                }
                if (alerts.subscription != subscription) return
                alerts.deliver(subscription, reply)
                showStatus("正在接收聊天消息")
                retry = 2000L
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (alerts.subscription != subscription) return
                if (e is ApiError && e.status == 401) { alerts.disable(); return }
                val game = e is ApiError && e.status == 423
                if (game) alerts.clearMessages()
                showStatus(if (game) "参赛期间暂停接收" else "连接中断，正在重连")
                delay(if (game) 30000L else retry)
                retry = min(60000L, retry * 2)
            }
        }
    }
    override fun onDestroy() {
        scope.cancel()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
