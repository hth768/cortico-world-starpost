package io.starpost.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// The package installer replaces (and kills) this process. Record the user's intent *before* handing it the APK.
internal object UpdateRestart {
    private const val channel="app-updated"
    internal const val notificationId=7411
    private fun prefs(ctx:Context)=ctx.getSharedPreferences("update-restart",Context.MODE_PRIVATE)
    fun expect(ctx:Context,code:Long):Boolean = prefs(ctx).edit()
        .putBoolean("modernUpdater",true).putLong("target",code).putLong("requested",System.currentTimeMillis()).commit()
    fun cancel(ctx:Context){
        val p=prefs(ctx)
        if(p.getLong("target",0)>BuildConfig.VERSION_CODE)p.edit().remove("target").remove("requested").commit()
    }
    private fun consume(ctx:Context):Boolean {
        val p=prefs(ctx)
        val installed=BuildConfig.VERSION_CODE.toLong()
        if(p.getLong("handled",0)==installed)return false
        val target=p.getLong("target",0)
        val eligible=if(target!=0L) {
            target==installed && System.currentTimeMillis()-p.getLong("requested",0) in 0..3_600_000L
        } else {
            // 1.10.1 saved the selected download and cleared autoInstall when handing it to Android.
            val old=ctx.getSharedPreferences("app_updates",Context.MODE_PRIVATE)
            !p.getBoolean("modernUpdater",false) && old.getLong("downloadId",0)>0 && !old.getBoolean("autoInstall",true) &&
                runCatching { AndroidRelease.parse(old.getString("release",null)!!).code==installed }.getOrDefault(false)
        }
        if(!eligible)return false
        return p.edit().remove("target").remove("requested").putLong("handled",installed).commit()
    }
    fun visible(ctx:Context){
        consume(ctx)
        ctx.getSystemService(NotificationManager::class.java).cancel(notificationId)
    }
    fun replaced(ctx:Context){
        if(!consume(ctx))return
        val open=Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .setClass(ctx,MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        // A background activity start can be silently blocked. Leave a normal tap target until MainActivity is visible.
        val manager=ctx.getSystemService(NotificationManager::class.java)
        if(manager.areNotificationsEnabled())runCatching {
            manager.createNotificationChannel(NotificationChannel(channel,"应用更新",NotificationManager.IMPORTANCE_DEFAULT))
            val tap=PendingIntent.getActivity(ctx,notificationId,open,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            manager.notify(notificationId,Notification.Builder(ctx,channel).setSmallIcon(R.drawable.ic_owner_notice)
                .setContentTitle("星邮已更新至 "+BuildConfig.VERSION_NAME).setContentText("点此打开新版星邮")
                .setAutoCancel(true).setContentIntent(tap).build())
        }
        runCatching { ctx.startActivity(open) }
    }
}

class UpdateReplacedReceiver:BroadcastReceiver(){
    override fun onReceive(context:Context,intent:Intent){
        if(intent.action==Intent.ACTION_MY_PACKAGE_REPLACED)UpdateRestart.replaced(context)
    }
}
