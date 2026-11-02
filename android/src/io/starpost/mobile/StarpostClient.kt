package io.starpost.mobile

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

internal fun obj(vararg values: Pair<String, Any?>) = JSONObject().apply { values.forEach { (k,v) -> put(k, v ?: JSONObject.NULL) } }
internal fun JSONObject.rows(key: String) = optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } } ?: emptyList()
internal fun JSONObject.str(key: String, fallback: String = "") = if (isNull(key)) fallback else optString(key, fallback)
internal fun JSONObject.strings(key: String) = optJSONArray(key)?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
internal data class Route(val page: String = "social", val id: String = "", val kind: String = "private", val section: String = "basic", val before: Long? = null)
internal data class ClientState(
    val starting: Boolean = true, val signedIn: Boolean = false, val account: JSONObject = obj(),
    val route: Route = Route(), val data: JSONObject = obj(), val overview: JSONObject = obj(), val social: JSONObject = obj(),
    val loading: Boolean = false, val working: Boolean = false, val error: String = "", val notice: String = "",
    val theme: String = "system", val dynamicColor: Boolean = true, val activeGame: String = "", val expiresAt: Long = 0
)
internal class ApiError(val status: Int, message: String): IOException(message)
private class ConnectionFailure(cause: IOException): IOException(cause)

/** Keeps the existing encrypted session format, app ID and sticker directory for upgrades. */
internal class StarpostClient(app: Application): AndroidViewModel(app) {
    private val sessions = SessionStore(app)
    private val preferences = app.getSharedPreferences("appearance", 0)
    private val network = Mutex()
    private var server = "https://starpost.com.cn"
    private var token = ""
    private var sessionEpoch = 0
    private var pollJob: Job? = null
    private val reminded = mutableSetOf<String>()
    private val backStack = mutableListOf<Route>()
    private val mutable = MutableStateFlow(ClientState(theme = preferences.getString("theme", "system") ?: "system", dynamicColor = preferences.getBoolean("dynamic", true)))
    val state = mutable.asStateFlow()
    private val library = StickerLibrary(File(app.filesDir, "sticker-favorites"))
    private val draftMentions = mutableMapOf<String,Map<String,String>>()
    private val drafts = mutableMapOf<String, String>()
    internal var attachment: JSONObject? = null
    internal val draftKey get() = "${state.value.account.str("humanId")}:${state.value.account.str("botId")}:${state.value.route.page}:${state.value.route.kind}:${state.value.route.id}"
    fun draft() = drafts[draftKey] ?: ""
    fun draft(value: String) { drafts[draftKey] = value;draftMentions[draftKey]=draftMentions[draftKey].orEmpty().filterValues{value.contains("@$it ")} }
    fun mention(id:String,label:String) { draftMentions[draftKey]=draftMentions[draftKey].orEmpty()+(id to label) }
    fun mentionIds(text:String)=draftMentions[draftKey].orEmpty().filterValues{text.contains("@$it ")}.keys.toList()
    fun theme(value: String) { if (value !in listOf("system", "light", "dark")) return; preferences.edit().putString("theme",value).apply(); mutable.update { it.copy(theme=value) } }
    fun dynamic(value: Boolean) { preferences.edit().putBoolean("dynamic",value).apply(); mutable.update { it.copy(dynamicColor=value) } }
    fun notice(value: String) { mutable.update { it.copy(notice=value) } }
    fun clearNotice() { mutable.update { it.copy(notice="") } }
    init {
        viewModelScope.launch {
            val saved = withContext(Dispatchers.IO) { runCatching { JSONObject(sessions.load()) }.getOrNull() }
            if (saved != null && saved.optLong("expiresAt") > System.currentTimeMillis() && validServer(saved.str("server"))) {
                server=saved.str("server");token=saved.str("token")
                mutable.update { it.copy(expiresAt=saved.optLong("expiresAt"), signedIn=true) }
                start()
            } else expire()
        }
    }
    private fun validServer(value: String) = runCatching { val u=URL(value); u.protocol=="https" && u.host.isNotBlank() && u.userInfo==null && u.query==null && u.ref==null && u.path in listOf("", "/") }.getOrDefault(false)
    private suspend fun saveSession() = withContext(Dispatchers.IO) { sessions.save(obj("server" to server,"token" to token,"botId" to state.value.account.str("botId"),"expiresAt" to state.value.expiresAt).toString()) }
    private fun expire() {
        sessionEpoch++;avatarCache.clear();token="";sessions.clear();backStack.clear();drafts.clear();draftMentions.clear();attachment=null
        mutable.update { ClientState(starting=false,theme=it.theme,dynamicColor=it.dynamicColor) }
    }
    private suspend fun request(path: String, body: JSONObject, auth: Boolean = true): JSONObject = network.withLock {
        withContext(Dispatchers.IO) {
            if(auth && (token.isEmpty() || state.value.expiresAt <= System.currentTimeMillis())) throw ApiError(401,"登录已过期，请重新登录")
            val selected=server
            try { requestAt(selected,path,body,auth) }
            catch(e: ConnectionFailure) {
                if(selected!="https://starpost.com.cn") throw IOException("无法连接服务器，请检查网络")
                val result = requestAt("https://8.148.13.225",path,body,auth)
                server="https://8.148.13.225";if(token.isNotEmpty())saveSession()
                notice("已连接备用服务器")
                result
            }
        }
    }
    private fun requestAt(base: String,path: String,body: JSONObject,auth: Boolean): JSONObject {
        require(validServer(base)) { "服务器地址须为 HTTPS" }
        val c=URL(base+path).openConnection() as HttpURLConnection
        c.connectTimeout=15000;c.readTimeout=30000;c.instanceFollowRedirects=false;c.requestMethod="POST";c.doOutput=true;c.setRequestProperty("Content-Type","application/json")
        if(auth)c.setRequestProperty("Authorization","Bearer $token")
        try {
            val bytes=body.toString().toByteArray(Charsets.UTF_8);c.setFixedLengthStreamingMode(bytes.size)
            try { c.connect() } catch(e: IOException) { throw ConnectionFailure(e) }
            // Never retry a request after body transmission: sends must not be duplicated.
            c.outputStream.use { it.write(bytes) }
            val status=c.responseCode
            val stream=if(status>=400)c.errorStream else c.inputStream
            val raw=stream?.use { input -> val out=java.io.ByteArrayOutputStream();val block=ByteArray(8192);while(true){val n=input.read(block);if(n<0)break;out.write(block,0,n);if(out.size()>30*1024*1024)throw IOException("内容过大，请分批查看")};out.toString("UTF-8") } ?: ""
            val result=runCatching { JSONObject(raw) }.getOrElse { throw IOException("服务器响应异常，请稍后重试") }
            if(status!=200 || !result.optBoolean("ok"))throw ApiError(status,result.str("error","请求失败"))
            return result.optJSONObject("result") ?: obj("items" to result.optJSONArray("result"))
        } finally { c.disconnect() }
    }
    private val avatarCache = linkedMapOf<String, android.graphics.Bitmap?>()
    private val avatarLock = Mutex()
    internal suspend fun avatar(id:String,version:String):android.graphics.Bitmap? = avatarLock.withLock {
        val epoch=sessionEpoch;val key="$epoch:${state.value.account.str("botId")}:$id:$version"
        if(avatarCache.containsKey(key))return@withLock avatarCache[key]
        try {
            val args=obj("botId" to id,"section" to "avatar")
            val result=try{rpc("social.profile",args)}catch(e:ApiError){if(e.status==403)rpc("profile",args)else throw e}
            val image=result.optJSONObject("image")
            val bitmap=withContext(Dispatchers.Default){
                val data=image?.str("base64")?:""
                if(data.isEmpty()||data.length>174764||result.str("avatarVersion")!=version)null else {
                    val bytes=android.util.Base64.decode(data,android.util.Base64.DEFAULT)
                    val bounds=android.graphics.BitmapFactory.Options().apply{inJustDecodeBounds=true}
                    android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
                    if(bounds.outWidth !in 1..512||bounds.outHeight !in 1..512)null else android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size)
                }
            }
            if(epoch!=sessionEpoch)return@withLock null
            if(avatarCache.size>=64)avatarCache.remove(avatarCache.keys.first())
            avatarCache[key]=bitmap;bitmap
        }catch(e:CancellationException){throw e}catch(e:Exception){null}
    }
    private suspend fun rpc(action: String,args: JSONObject = obj())=request("/mobile/rpc",obj("action" to action,"args" to args))
    private suspend fun handle(error: Throwable,allowExpiry:Boolean=true) {
        if(error is CancellationException)throw error
        if(error is ApiError && error.status==401 && allowExpiry){expire();notice("登录已过期，请重新登录")}
        else if(error is ApiError && error.status==423){checkGame()}
        else mutable.update { it.copy(error=error.message ?: "暂时无法连接，请重试",starting=false,loading=false) }
    }
    private suspend fun start() {
        try {
            val account=rpc("account.info")
            mutable.update { it.copy(account=account,starting=false,signedIn=true,error="") }
            if(!account.optBoolean("needsEmail")){checkGame();refreshNow()}
        }catch(e:Exception){handle(e)}
    }
    fun retryStart() { viewModelScope.launch { mutable.update { it.copy(starting=true,error="") };start() } }
    fun login(mode: String,email: String,password: String,nickname: String,challenge: String,code: String,customServer: String,done: ()->Unit) {
        if(state.value.working)return
        mutable.update { it.copy(working=true,error="") }
        viewModelScope.launch {
            try {
                if(mode=="legacy") { val base=customServer.trim().trimEnd('/');require(validServer(base)){"请输入有效的 HTTPS 服务器地址"};server=base }
                val result=if(mode=="legacy")request("/mobile/login",obj("botId" to email.trim(),"credential" to password.trim()),false)
                    else request("/mobile/auth",obj("action" to if(mode in listOf("claim","register"))mode else "login","method" to if(mode=="code")"code" else "password","email" to email.trim(),"password" to password,"nickname" to nickname,"challengeId" to challenge,"code" to code),mode=="claim")
                token=result.getString("accessToken");sessionEpoch++
                mutable.update { it.copy(expiresAt=result.getLong("expiresAt"),account=result,signedIn=true) };saveSession();done();start()
            }catch(e:Exception){handle(e,mode=="claim")}finally{mutable.update{it.copy(working=false)}}
        }
    }
    fun sendCode(mode:String,email:String,done:(String,Int)->Unit) {
        if(state.value.working)return;mutable.update { it.copy(working=true,error="") }
        viewModelScope.launch { try {
            val v=request("/mobile/auth",obj("action" to "code","purpose" to if(mode in listOf("claim","register"))mode else "login","email" to email.trim()),mode=="claim")
            done(v.getString("challengeId"),v.optInt("retryAfter",60));notice(v.str("message","验证码已发送"))
        }catch(e:Exception){handle(e,mode=="claim")}finally{mutable.update{it.copy(working=false)}} }
    }
    fun navigate(route: Route,push:Boolean=true) {
        val active=state.value.activeGame
        if(active.isNotEmpty() && route.page!="humanRoom"){notice("对局期间请使用游戏聊天室");return}
        if(push && state.value.route!=route)backStack.add(state.value.route)
        attachment=null
        mutable.update { it.copy(route=route,data=obj(),loading=true,error="") }
        refresh()
    }
    fun back():Boolean {
        if(state.value.activeGame.isNotEmpty()){notice("对局期间仅能使用游戏聊天室");return true}
        if(backStack.isEmpty())return false
        navigate(backStack.removeAt(backStack.lastIndex),false);return true
    }
    fun refresh() { viewModelScope.launch { refreshNow() } }
    private suspend fun refreshNow(background:Boolean=false) {
        if(!state.value.signedIn||state.value.account.optBoolean("needsEmail"))return
        val route=state.value.route;val epoch=sessionEpoch
        if(!background)mutable.update{it.copy(loading=true,error="")}
        try {
            val cursor=obj("before" to route.before)
            val result=when(route.page){
                "social","contacts","groupCreate","invite"->rpc("social.overview").also { if(epoch==sessionEpoch)mutable.update { s->s.copy(social=it) } }
                "socialHistory"->rpc("social.history",obj("kind" to route.kind,"target" to route.id,"limit" to 30,"before" to route.before))
                "settings"->rpc("account.info").also { if(epoch==sessionEpoch)mutable.update { s->s.copy(account=it) } }
                "approvals"->rpc("account.approvals")
                "teen"->rpc("teen.status")
                "owner"->rpc("owner.history",cursor)
                "chats","feed"->rpc("overview").also { if(epoch==sessionEpoch)mutable.update { s->s.copy(overview=it) } }
                "history"->rpc("history",obj("kind" to route.kind,"target" to route.id,"before" to route.before))
                "post"->rpc("post",obj("postId" to route.id))
                "profile"->rpc(if(route.kind=="social")"social.profile" else "profile",obj("botId" to route.id,"section" to route.section))
                "square"->rpc("square")
                "featuredSummary"->rpc("featured")
                "featured"->rpc("featured.read",obj("gameId" to route.id,"before" to route.before))
                "games"->rpc("human.lobby")
                "botGames"->rpc("games",obj("scope" to route.kind,"before" to route.before))
                "game"->rpc("game",obj("gameId" to route.id,"before" to route.before))
                "humanReservation","humanRoom"->rpc("human.room",obj("gameId" to route.id,"before" to route.before))
                "gameInvite"->{val room=rpc("human.room",obj("gameId" to route.id));if(room.optJSONObject("game")?.optBoolean("canInvite")!=true)throw IOException("当前不能邀请，请确认已加入预约且尚未开局");rpc("social.overview")}
                else->obj()
            }
            if(epoch==sessionEpoch && route==state.value.route)mutable.update { it.copy(data=result,loading=false,error="") }
        }catch(e:Exception){if(epoch==sessionEpoch && route==state.value.route)handle(e)}
    }
    fun perform(action:String,args:JSONObject=obj(),next:Route?=null,done:(JSONObject)->Unit={}) {
        if(state.value.working)return;val epoch=sessionEpoch
        mutable.update { it.copy(working=true,error="") }
        viewModelScope.launch {
            try {
                val result=rpc(action,args)
                if(epoch!=sessionEpoch)return@launch
                if(action=="logout"){expire();return@launch}
                done(result)
                if(action in listOf("account.select","account.bind","account.botAvatar","account.botPokeText","account.contactRemark","owner.address","human.profile","social.profile.update")){val info=rpc("account.info");mutable.update{it.copy(account=info)};saveSession()}
                if(action=="account.contactRemark"){val contacts=rpc("social.overview");if(epoch==sessionEpoch)mutable.update{it.copy(social=contacts)}}
                if(result.optBoolean("pendingApproval"))notice("已提交，等待相关用户审批")
                else if(result.optBoolean("waitingForOthers"))notice("已批准，等待其他 bot 主人审批")
                if(next!=null)navigate(next)else refreshNow()
            }catch(e:Exception){handle(e)}finally{mutable.update{it.copy(working=false)}}
        }
    }
    fun search(query:String,offset:Int,done:(List<JSONObject>)->Unit) {
        if(state.value.working)return;val epoch=sessionEpoch
        mutable.update{it.copy(working=true,error="")}
        viewModelScope.launch{try{val result=rpc("social.search",obj("query" to query,"offset" to offset));if(epoch==sessionEpoch)done(result.rows("items"))}catch(e:Exception){handle(e)}finally{mutable.update{it.copy(working=false)}}}
    }
    fun foreground(active:Boolean) {
        pollJob?.cancel();pollJob=null
        if(active)pollJob=viewModelScope.launch { while(isActive){delay(8000);if(!state.value.signedIn || state.value.working || state.value.account.optBoolean("needsEmail"))continue
            try { checkGame();if(state.value.route.before==null && state.value.route.page in listOf("social","socialHistory","owner","humanRoom"))refreshNow(true) }catch(e:Exception){handle(e)}
        } }
    }
    private suspend fun checkGame() {
        val v=rpc("human.status");val active=v.str("activeGameId")
        if(active!=state.value.activeGame){mutable.update{it.copy(activeGame=active)};navigate(if(active.isEmpty())Route("games")else Route("humanRoom",active),false)}
        for(g in v.rows("games")){val delta=runCatching { Instant.parse(g.str("scheduledAt")).toEpochMilli()-System.currentTimeMillis() }.getOrDefault(-1)
            if(g.optBoolean("participant")&&!g.optBoolean("checkedInSelf")&&g.str("status")=="scheduled"&&delta in 1..180000&&reminded.add(g.str("gameId")))notice("「${g.str("title")}」已到集合时间，请进入游戏报到")}
    }
    suspend fun favorites():List<File> = withContext(Dispatchers.IO){library.list()}
    suspend fun sticker(file:File):JSONObject=withContext(Dispatchers.IO){obj("mime" to StickerLibrary.mime(file),"base64" to android.util.Base64.encodeToString(library.read(file),android.util.Base64.NO_WRAP))}
    fun collect(image:JSONObject){viewModelScope.launch{try{withContext(Dispatchers.IO){library.save(android.util.Base64.decode(image.getString("base64"),android.util.Base64.DEFAULT),image.getString("mime"))};notice("已收藏到表情包")}catch(e:Exception){notice(e.message?:"收藏失败")}}}
}
