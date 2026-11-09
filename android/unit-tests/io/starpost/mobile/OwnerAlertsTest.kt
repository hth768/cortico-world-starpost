package io.starpost.mobile

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OwnerAlertsTest {
    @Test fun socialPrivateGroupAndOwnerNotificationsKeepSeparateTapTargetsAndResumeWithoutRepeats(){
        val app=ApplicationProvider.getApplicationContext<Application>();val alerts=OwnerAlerts(app)
        val manager=app.getSystemService(NotificationManager::class.java);alerts.enable("chat-token",obj(),100)
        val sub=alerts.subscription!!
        val items=org.json.JSONArray().apply {listOf("private" to "10001","group" to "room-1","owner" to "10001").forEachIndexed{i,(kind,target)->
            put(obj("kind" to kind,"target" to target,"title" to "朋友","cursor" to 101+i,"preview" to (if(kind=="group")"[有人 @ 你] 新消息" else "新消息")))} }
        val batch=obj("cursor" to 103,"items" to items);alerts.deliver(sub,batch)
        assertEquals(setOf("private:10001","owner:10001","group:room-1"),manager.activeNotifications.map{it.tag}.toSet())
        for(n in manager.activeNotifications){
            val tap=shadowOf(n.notification.contentIntent).savedIntent
            assertEquals(OwnerAlerts.OPEN_CHAT,tap.action)
            assertEquals(listOf(sub)+n.tag.split(":"),tap.data!!.pathSegments)
            assertEquals("收到新的聊天消息",n.notification.publicVersion.extras.getString(Notification.EXTRA_TEXT))
        }
        assertEquals(NotificationManager.IMPORTANCE_HIGH,manager.getNotificationChannel(OwnerAlerts.MESSAGE_CHANNEL).importance)
        alerts.clearMessages()
        OwnerAlerts(app).deliver(sub,batch);assertTrue(manager.activeNotifications.isEmpty())
        assertEquals(103L,OwnerAlerts(app).pollArgs().getLong("chatCursor"));alerts.disable()
    }
    @Test fun repliesOpenTheirOwnChatHideLockScreenTextAndSurviveReconnect() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val alerts = OwnerAlerts(app)
        val manager = app.getSystemService(NotificationManager::class.java)
        alerts.channels()
        alerts.enable("session-a", obj("10001" to 0, "10002" to 0))
        val subscription = alerts.subscription!!
        assertFalse(alerts.matches(subscription, "session-b"))
        val cursors = obj("10001" to 11, "10002" to 12)
        val batch = obj("cursors" to cursors, "items" to org.json.JSONArray(listOf(
            obj("botId" to "10001", "nickname" to "一号", "cursor" to 11, "preview" to "第一条回复"),
            obj("botId" to "10002", "nickname" to "二号", "cursor" to 12, "preview" to "第二条回复")
        )))
        OwnerAlerts.visibleBot = "10001"
        try { alerts.deliver(subscription, batch) } finally { OwnerAlerts.visibleBot = null }
        val notice = manager.activeNotifications.single()
        assertEquals("10002", notice.tag)
        assertEquals("第二条回复", notice.notification.extras.getString(Notification.EXTRA_TEXT))
        assertEquals("你的 bot 发来新消息", notice.notification.publicVersion.extras.getString(Notification.EXTRA_TEXT))
        val intent = shadowOf(notice.notification.contentIntent).savedIntent
        assertEquals(OwnerAlerts.OPEN, intent.action)
        assertEquals(listOf(subscription, "10002"), intent.data!!.pathSegments)
        alerts.seen("10002", 12)
        OwnerAlerts(app).deliver(subscription, batch)
        assertTrue(manager.activeNotifications.isEmpty())
        alerts.disable()
        alerts.deliver(subscription, batch)
        assertTrue(manager.activeNotifications.isEmpty())
        assertFalse(alerts.matches(subscription, "session-a"))
    }
}
