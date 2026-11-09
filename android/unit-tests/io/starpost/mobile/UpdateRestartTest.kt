package io.starpost.mobile

import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[35])
class UpdateRestartTest {
    private val app get()=ApplicationProvider.getApplicationContext<Application>()
    private val code=BuildConfig.VERSION_CODE.toLong()
    private fun replaced(action:String=Intent.ACTION_MY_PACKAGE_REPLACED)=UpdateReplacedReceiver().onReceive(app,Intent(action))
    @Before fun clear(){
        app.getSharedPreferences("update-restart",Context.MODE_PRIVATE).edit().clear().commit()
        app.getSharedPreferences("app_updates",Context.MODE_PRIVATE).edit().clear().commit()
        shadowOf(app.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(true)
    }
    @Test fun matchingCompletedInstallationReopensOnlyOnceAndProvidesATapFallback(){
        UpdateRestart.expect(app,code)
        replaced(Intent.ACTION_PACKAGE_ADDED);assertNull(shadowOf(app).nextStartedActivity)
        replaced()
        val open=shadowOf(app).nextStartedActivity
        assertEquals(MainActivity::class.java.name,open.component?.className)
        val manager=app.getSystemService(NotificationManager::class.java)
        val notice=shadowOf(manager).getNotification(UpdateRestart.notificationId)
        assertNotNull(notice.contentIntent)
        assertEquals(open.component,shadowOf(notice.contentIntent).savedIntent.component)
        replaced();assertNull(shadowOf(app).nextStartedActivity)
        UpdateRestart.visible(app);assertNull(shadowOf(manager).getNotification(UpdateRestart.notificationId))
    }
    @Test fun unrelatedInstallOrAppAlreadyReopenedDoesNotStealFocus(){
        replaced();assertNull(shadowOf(app).nextStartedActivity)
        UpdateRestart.expect(app,code+1);replaced();assertNull(shadowOf(app).nextStartedActivity)
        UpdateRestart.cancel(app);replaced();assertNull(shadowOf(app).nextStartedActivity)
        UpdateRestart.expect(app,code);UpdateRestart.visible(app);replaced();assertNull(shadowOf(app).nextStartedActivity)
    }
}
