package io.starpost.mobile

import android.app.DownloadManager
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId

internal const val UPDATE_REPO = "https://github.com/hth768/cortico-world-starpost/releases/"
internal const val UPDATE_MANIFEST = "${UPDATE_REPO}latest/download/android-update.json"
internal const val MAX_APK_BYTES = 150L * 1024 * 1024
internal const val APK_MIME = "application/vnd.android.package-archive"

internal data class AndroidRelease(val code:Long, val name:String, val minSdk:Int, val bytes:Long, val sha256:String, val url:String, val notes:String) {
    fun json() = JSONObject().put("schema",1).put("packageName",BuildConfig.APPLICATION_ID)
        .put("versionCode",code).put("versionName",name).put("minSdk",minSdk).put("bytes",bytes)
        .put("sha256",sha256).put("apkUrl",url).put("notes",notes)
    companion object {
        fun parse(raw:String):AndroidRelease {
            require(raw.length <= 32_768) { "更新信息过大" }
            val p=JSONObject(raw)
            require(p.getInt("schema")==1 && p.getString("packageName")==BuildConfig.APPLICATION_ID) { "更新信息不属于星邮" }
            val code=p.getLong("versionCode"); val name=p.getString("versionName"); val sdk=p.getInt("minSdk")
            val size=p.getLong("bytes"); val hash=p.getString("sha256").lowercase(); val url=p.getString("apkUrl")
            require(code in 1..2_100_000_000 && name.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+"))) { "更新版本信息无效" }
            require(sdk in 26..100 && size in 1..MAX_APK_BYTES && hash.matches(Regex("[a-f0-9]{64}"))) { "更新文件信息无效" }
            // Pin downloads to an immutable release in our repository, never an account-provided URL.
            require(url.matches(Regex(Regex.escape(UPDATE_REPO)+"download/v[0-9]+\\.[0-9]+\\.[0-9]+/starpost-android\\.apk"))) { "更新下载地址无效" }
            return AndroidRelease(code,name,sdk,size,hash,url,p.optString("notes").take(6000))
        }
    }
}

internal fun updateDay(at:Long):String = Instant.ofEpochMilli(at).atZone(ZoneId.of("Asia/Shanghai")).toLocalDate().toString()
internal fun checkUpdateAllowed(now:Long,last:Long,ignoredDay:String,manual:Boolean):Boolean =
    manual || (ignoredDay!=updateDay(now) && (last==0L || now<last || now-last>=6*60*60*1000L))

internal fun verifyUpdateIdentity(release:AndroidRelease, packageName:String?, code:Long, name:String?, currentCode:Long, installedSigners:Set<String>, archiveSigners:Set<String>) {
    require(packageName==BuildConfig.APPLICATION_ID && code==release.code && name==release.name && code>currentCode) { "安装包版本或包名不匹配" }
    require(installedSigners.isNotEmpty() && archiveSigners==installedSigners) { "安装包签名与当前星邮不一致，请勿安装" }
}

internal data class UpdateDownload(val status:Int,val downloaded:Long=0,val reason:Int=0)
internal interface UpdateBackend {
    fun latest():AndroidRelease
    fun enqueue(release:AndroidRelease):Long
    fun query(id:Long):UpdateDownload
    fun remove(id:Long)
    fun verify(release:AndroidRelease):File
    fun clean()
}

internal class AndroidUpdateBackend(private val context:Context):UpdateBackend {
    private val downloads get()=context.getSystemService(DownloadManager::class.java)
    private fun source()=File(requireNotNull(context.getExternalFilesDir("updates")){"更新存储目录不可用"},"download.apk")
    private val staging get()=File(context.cacheDir,"updates").apply{mkdirs()}
    override fun latest():AndroidRelease {
        var address=URI(UPDATE_MANIFEST)
        repeat(6) {
            require(address.scheme=="https" && address.userInfo==null && address.port in listOf(-1,443) && address.host in setOf("github.com","release-assets.githubusercontent.com","objects.githubusercontent.com")) { "更新服务跳转地址不受信任" }
            val connection=address.toURL().openConnection() as HttpURLConnection
            try {
                connection.instanceFollowRedirects=false; connection.connectTimeout=15_000; connection.readTimeout=15_000
                connection.setRequestProperty("User-Agent","Starpost-Android/${BuildConfig.VERSION_NAME}")
                connection.setRequestProperty("Cache-Control","no-cache")
                val status=connection.responseCode
                if(status in listOf(301,302,303,307,308)) {
                    address=address.resolve(requireNotNull(connection.getHeaderField("Location"))); return@repeat
                }
                require(status==200){"暂时无法获取更新（HTTP $status），请稍后重试"}
                val data=connection.inputStream.use{input->
                    val result=ByteArrayOutputStream();val buffer=ByteArray(4096)
                    while(result.size()<=32_768){val count=input.read(buffer);if(count<0)break;result.write(buffer,0,count)}
                    result.toByteArray()
                }
                require(data.size<=32_768){"更新信息过大"}
                return AndroidRelease.parse(data.toString(Charsets.UTF_8))
            } finally { connection.disconnect() }
        }
        error("更新服务跳转次数过多")
    }
    override fun enqueue(release:AndroidRelease):Long {
        clean()
        require(source().parentFile!!.usableSpace>release.bytes*2+10*1024*1024) { "存储空间不足，请清理后重试" }
        require(context.cacheDir.usableSpace>release.bytes+10*1024*1024) { "内部存储空间不足，请清理后重试" }
        return downloads.enqueue(DownloadManager.Request(Uri.parse(release.url))
            .setTitle("星邮 ${release.name}").setDescription("正在下载更新，完成后返回星邮安装")
            .setMimeType(APK_MIME).setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalFilesDir(context,"updates","download.apk"))
    }
    override fun query(id:Long):UpdateDownload = downloads.query(DownloadManager.Query().setFilterById(id)).use { c ->
        if(c==null || !c.moveToFirst()) UpdateDownload(DownloadManager.STATUS_FAILED,reason=DownloadManager.ERROR_FILE_ERROR)
        else UpdateDownload(c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)),c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)),c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)))
    }
    override fun remove(id:Long) { if(id>0)downloads.remove(id); clean() }
    override fun clean() { source().delete(); File(staging,"update.apk").delete(); File(staging,"update.part").delete() }
    @Suppress("DEPRECATION")
    override fun verify(release:AndroidRelease):File {
        // Copy into internal storage before checking; only this narrowly scoped copy is shared with the installer.
        val apk=File(staging,"update.apk"); val partial=File(staging,"update.part")
        try {
            if(!apk.exists()) {
                val input=source(); require(input.length()==release.bytes){"安装包大小不匹配，请重新下载"}
                input.inputStream().use{from->partial.outputStream().use{to->
                    val buffer=ByteArray(64*1024); var count=0L
                    while(true){val n=from.read(buffer);if(n<0)break;count+=n;require(count<=release.bytes){"安装包大小不匹配"};to.write(buffer,0,n)}
                }}
            }
            val candidate=if(apk.exists())apk else partial
            require(candidate.length()==release.bytes){"安装包下载不完整，请重新下载"}
            val hash=MessageDigest.getInstance("SHA-256")
            candidate.inputStream().use { stream -> val buffer=ByteArray(64*1024); while(true){val n=stream.read(buffer);if(n<0)break;hash.update(buffer,0,n)} }
            require(hash.digest().joinToString(""){"%02x".format(it)}==release.sha256){"安装包完整性校验失败，请重新下载"}
            val pm=context.packageManager
            val flags=if(Build.VERSION.SDK_INT>=28)PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
            val installed=pm.getPackageInfo(context.packageName,flags)
            val archive=requireNotNull(pm.getPackageArchiveInfo(candidate.path,flags)){"安装包无法读取"}
            fun version(info:PackageInfo)=if(Build.VERSION.SDK_INT>=28)info.longVersionCode else info.versionCode.toLong()
            fun signers(info:PackageInfo):Set<String> = (if(Build.VERSION.SDK_INT>=28)info.signingInfo?.apkContentsSigners else info.signatures)
                ?.map{it.toCharsString()}?.toSet()?:emptySet()
            verifyUpdateIdentity(release,archive.packageName,version(archive),archive.versionName,version(installed),signers(installed),signers(archive))
            require(release.minSdk<=Build.VERSION.SDK_INT && (archive.applicationInfo?.minSdkVersion?:release.minSdk)<=Build.VERSION.SDK_INT){"此版本不支持当前 Android 系统"}
            if(candidate==partial)require(partial.renameTo(apk)){"无法保存安装包"}
            return apk
        } catch(error:Exception) { apk.delete(); partial.delete(); throw error }
    }
}
