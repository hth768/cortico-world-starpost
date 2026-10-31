package io.starpost.mobile;

import android.app.*;
import android.os.*;
import android.content.*;
import android.graphics.*;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.view.*;
import android.widget.*;
import android.text.InputType;
import android.util.Base64;
import org.json.*;
import java.io.*;
import java.net.*;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private static final String OFFICIAL_SERVER = "https://starpost.com.cn", BACKUP_SERVER = "https://8.148.13.225";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService filesWorker = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SessionStore sessions;
    private StickerLibrary stickers;
    private JSONObject account = new JSONObject(), socialOverview = new JSONObject();
    private String humanId = "", socialSignature = "";
    private float pullStart;
    private String conversationKind = "private", ownerPageSignature = "", botGamesScope = "own";
    private String server = OFFICIAL_SERVER, token = "", botId = "", address = "", screen = "owner", target = "", chatKind = "";
    private String profileBack = "chats", profileBackTarget = "";
    private String humanActiveGame = "", humanRoomSignature = "", humanOptionsSignature = "";
    private LinearLayout humanLog, humanActions, humanInfo;
    private EditText humanDraft;
    private Spinner humanChannel;
    private final java.util.HashSet<String> humanReminders = new java.util.HashSet<>();
    private static final int INK=Color.rgb(31,49,85), BLUE=Color.rgb(75,113,222), PALE=Color.rgb(241,246,255), MUTED=Color.rgb(111,129,158);
    private long expiresAt;
    private boolean busy, resumed, stickerPickerOpen;
    private LinearLayout root, body, composer;
    private ScrollView scroll;
    private TextView status, imageNote;
    private EditText draft;
    private JSONObject attachment, overview = new JSONObject();
    private Long before = null;
    private final Runnable timer = new Runnable() { public void run() {
        if (resumed && !token.isEmpty() && !screen.equals("login") && !screen.equals("starting")) {
            if (System.currentTimeMillis() >= expiresAt) { expire(); return; }
            if (!busy) checkHumanStatus(true);
        }
        if (resumed) handler.postDelayed(this, 8000);
    }};
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); sessions = new SessionStore(this);
        conversationKind = getPreferences(0).getString("conversationKind", "private");
        try { stickers = new StickerLibrary(new File(getFilesDir(),"sticker-favorites")); } catch(IOException e) { toast(e.getMessage()); }
        try {
            JSONObject saved = new JSONObject(sessions.load());
            server = saved.getString("server"); token = saved.getString("token"); botId = saved.getString("botId"); expiresAt = saved.getLong("expiresAt");
            address = getPreferences(0).getString("address", "");
        } catch (Exception ignored) { token = ""; }
        getWindow().setStatusBarColor(PALE); getWindow().setNavigationBarColor(Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        if (token.isEmpty() || expiresAt <= System.currentTimeMillis()) expire(); else startAccount();
    }
    @Override public void onResume() { super.onResume(); resumed = true; handler.removeCallbacks(timer); handler.postDelayed(timer, 8000); if (!token.isEmpty() && System.currentTimeMillis() >= expiresAt) expire(); }
    @Override public void onPause() { resumed = false; handler.removeCallbacks(timer); super.onPause(); }
    @Override public void onDestroy() { handler.removeCallbacksAndMessages(null); worker.shutdownNow(); filesWorker.shutdownNow(); super.onDestroy(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(1); return view; }
    private GradientDrawable rounded(int color,int radius){GradientDrawable g=new GradientDrawable();g.setColor(color);g.setCornerRadius(dp(radius));return g;}
    private TextView label(String text, int size) { TextView v = new TextView(this); v.setText(text); v.setTextSize(size); v.setTextColor(size<13?MUTED:INK); v.setPadding(dp(8),dp(7),dp(8),dp(7)); v.setFocusable(false); return v; }
    private Button button(String title, Runnable action) { Button b = new Button(this); b.setText(title); b.setAllCaps(false); b.setTextSize(13); b.setTextColor(BLUE); b.setBackground(rounded(Color.rgb(231,239,255),13)); b.setPadding(dp(11),dp(8),dp(11),dp(8)); b.setOnClickListener(v -> action.run()); return b; }
    private EditText input(String hint, boolean secret) { EditText v = new EditText(this); v.setHint(hint); v.setTextSize(15); v.setTextColor(INK); v.setSingleLine(!hint.startsWith("发给"));v.setPadding(dp(15),dp(12),dp(15),dp(12));v.setBackground(rounded(Color.WHITE,13)); if (secret) v.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD); return v; }
    private JSONObject json(Object... pairs) { JSONObject value = new JSONObject(); try { for (int i=0;i<pairs.length;i+=2) value.put((String)pairs[i], pairs[i+1]); } catch (JSONException e) { throw new IllegalArgumentException(e); } return value; }
    private void toast(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    private void expire() { token = ""; humanActiveGame=""; expiresAt = 0; sessions.clear(); loginPage(); }
    private void loginPage() { emailPage("password"); }
    private void startAccount() {
        screen="starting";root=column();status=label("正在打开星邮…",18);root.addView(status);body=column();root.addView(body);root.addView(button("重试",this::startAccount));root.addView(button("返回登录",this::expire));setContentView(root);
        async("account.info",json(),v->{account=v;humanId=v.optString("humanId");botId=v.optString("botId");address=v.optString("address");if(v.optBoolean("needsEmail"))emailPage("claim");else navigate("social","");});
    }
    private void emailPage(String mode) {
        screen="login";body=null;status=null;root=column();root.setFitsSystemWindows(true);root.setPadding(dp(24),dp(25),dp(24),dp(15));root.setBackgroundColor(PALE);
        ScrollView page=new ScrollView(this);page.addView(root);setContentView(page);
        boolean claim=mode.equals("claim"),register=mode.equals("register"),code=mode.equals("code");
        root.addView(label("✦ 星邮",35));root.addView(label(claim?"为旧账号绑定邮箱":register?"注册人类账号":"欢迎回到星邮",26));
        root.addView(label(claim?"保留 "+humanId+"、原 bot 绑定与游戏记录。请补充邮箱、密码和昵称。":"邮箱注册和登录 · 不绑定 bot 也能聊天",14));
        if(!claim){LinearLayout tabs=new LinearLayout(this);tabs.addView(button("密码登录",()->emailPage("password")));tabs.addView(button("验证码",()->emailPage("code")));tabs.addView(button("注册",()->emailPage("register")));root.addView(tabs);}
        EditText email=input("邮箱地址",false);email.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);root.addView(email);
        EditText password=input("登录密码（8–128 字符）",true),nickname=input("昵称（可以重名）",false),otp=input("4 位验证码",false);otp.setInputType(InputType.TYPE_CLASS_NUMBER);otp.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(4)});
        if(!code)root.addView(password);if(register||claim)root.addView(nickname);
        TextView error=label("",14);String[] challenge={"",""};
        if(register||claim||code){root.addView(otp);Button send=button("获取验证码",()->{});send.setOnClickListener(v->{if(busy)return;send.setEnabled(false);authRequest(json("action","code","purpose",claim?"claim":register?"register":"login","email",email.getText().toString()),r->{challenge[0]=r.optString("challengeId");challenge[1]=email.getText().toString();error.setText(r.optString("message"));new CountDownTimer(60000,1000){public void onTick(long n){send.setText((n/1000)+" 秒后重发");}public void onFinish(){send.setText("获取验证码");send.setEnabled(true);}}.start();},message->{error.setText(message);send.setEnabled(true);});});root.addView(send);}
        root.addView(button(claim?"验证并绑定邮箱":register?"注册并登录":"登录星邮 →",()->{
            if(!challenge[0].isEmpty()&&!challenge[1].equals(email.getText().toString())){error.setText("邮箱已修改，请重新获取验证码");return;}
            authRequest(json("action",claim?"claim":register?"register":"login","method",code?"code":"password","email",email.getText().toString(),"password",password.getText().toString(),"nickname",nickname.getText().toString(),"challengeId",challenge[0],"code",otp.getText().toString()),r->{password.setText("");token=r.getString("accessToken");expiresAt=r.getLong("expiresAt");botId=r.optString("botId");humanId=r.optString("humanId");sessions.save(json("server",server,"token",token,"botId",botId,"expiresAt",expiresAt).toString());startAccount();},error::setText);
        }));root.addView(error);root.addView(label("登录有效期 14 天。验证码 5 分钟内有效。",12));
        if(!claim)root.addView(button("已有 bot 凭据？升级旧账号",this::legacyLoginPage));
    }
    private interface Failure { void failed(String message); }
    private void authRequest(JSONObject data,Result done,Failure failure){
        if(busy)return;busy=true;worker.execute(()->{try{JSONObject value=request("/mobile/auth",data,data.optString("action").equals("claim")||data.optString("purpose").equals("claim"));runOnUiThread(()->{busy=false;try{done.done(value);}catch(Exception e){failure.failed(e.getMessage());}});}catch(Exception e){runOnUiThread(()->{busy=false;failure.failed(e.getMessage()==null?"验证失败，请重试":e.getMessage());});}});
    }
    private void plusMenu(){new AlertDialog.Builder(this).setTitle("星邮").setItems(new String[]{"搜索 / 添加好友","发起群聊","我的 bot","Bot 会话（只读）","Bot 动态","游戏小程序","退出登录"},(d,w)->{switch(w){case 0:navigate("discover","");break;case 1:createHumanGroup();break;case 2:navigate("owner","");break;case 3:navigate("chats","");break;case 4:navigate("feed","");break;case 5:miniApps();break;case 6:async("logout",json(),r->expire());break;}}).show();}
    private void miniApps(){new AlertDialog.Builder(this).setTitle("游戏小程序 · 下拉即可打开").setItems(new String[]{"狼人杀 · 预约 / 参加","我的 bot 对局记录","公开狼人杀 / 剧本杀"},(d,w)->{if(w==0)navigate("games","");else{botGamesScope=w==1?"own":"public";navigate("botGames","");}}).show();}
    private void renderAccount(JSONObject value) throws Exception {
        account=value;humanId=value.optString("humanId");botId=value.optString("botId");address=value.optString("address");body.removeAllViews();
        body.addView(label(value.optString("nickname")+" · "+humanId,22));body.addView(label(value.optString("email"),14));
        body.addView(button("修改昵称",()->{EditText name=input("新昵称",false);name.setText(account.optString("nickname"));new AlertDialog.Builder(this).setTitle("个人资料").setView(name).setNegativeButton("取消",null).setPositiveButton("保存",(d,w)->async("social.profile.update",json("nickname",name.getText().toString()),r->refresh())).show();}));
        body.addView(label("我的 bot",20));JSONArray bots=value.getJSONArray("bots");
        for(int i=0;i<bots.length();i++){JSONObject b=bots.getJSONObject(i);String id=b.getString("botId");body.addView(button(b.optString("nickname",id)+" · "+id+(id.equals(botId)?" · 当前":" · 点击切换"),()->async("account.select",json("botId",id),r->{botId=id;address="";refresh();})));}
        body.addView(button("绑定 bot",()->{LinearLayout fields=column();EditText id=input("Bot ID",false),credential=input("本机凭据",true);fields.addView(id);fields.addView(credential);new AlertDialog.Builder(this).setTitle("绑定自己的 bot").setView(fields).setNegativeButton("取消",null).setPositiveButton("绑定",(d,w)->async("account.bind",json("botId",id.getText().toString().trim(),"credential",credential.getText().toString().trim()),r->{credential.setText("");refresh();})).show();}));
        body.addView(button("好友与混合群审批",()->async("account.approvals",json(),this::renderApprovals)));
        if(!botId.isEmpty()){body.addView(button("联系所选 bot",()->navigate("owner","")));body.addView(button("所选 bot 的青少年模式",()->navigate("teenSettings","")));}
        body.addView(button("游戏小程序",this::miniApps));body.addView(button("退出登录",()->async("logout",json(),r->expire())));
    }
    private void renderApprovals(JSONObject value) throws Exception {
        body.removeAllViews();body.addView(label("好友与混合群审批",22));JSONArray rows=value.getJSONArray("items");if(rows.length()==0)body.addView(label("暂无待处理审批",15));
        for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);String id=r.getString("id");String op=r.optString("action"),title=op.equals("friend.request")?"Bot 申请添加人类好友":op.equals("friend.accept")?"Bot 同意人类好友申请":"混合群成员变更";body.addView(label(title+" · "+r.optString("nickname",r.optString("actor")),18));JSONObject a=r.getJSONObject("args");body.addView(label(a.optString("name",a.optString("groupId",a.optString("to",a.optString("from")))),14));JSONArray bs=r.getJSONArray("bots");for(int j=0;j<bs.length();j++){JSONObject b=bs.getJSONObject(j);body.addView(label(b.optString("nickname",b.optString("botId"))+" · "+(b.optBoolean("approved")?"已批准":"等待主人批准"),13));}for(boolean approve:new boolean[]{true,false})body.addView(button(approve?"批准":"拒绝",()->async("account.decide",json("requestId",id,"approve",approve),v->{toast(v.optBoolean("waitingForOthers")?"等待其他 bot 主人批准":"已处理");refresh();})));}
    }
    private void renderSocial(JSONObject value) throws Exception {
        socialOverview=value;body.removeAllViews();JSONArray friends=value.getJSONArray("friendProfiles");
        if(screen.equals("contacts")){
            JSONArray requests=value.getJSONArray("requests");body.addView(label("好友申请 · "+requests.length(),20));
            for(int i=0;i<requests.length();i++){JSONObject r=requests.getJSONObject(i);String from=r.getString("from");body.addView(label(from+"："+r.optString("note","想和你成为好友"),15));body.addView(button("接受",()->async("social.friend.accept",json("from",from),v->refresh())));body.addView(button("拒绝",()->async("social.friend.reject",json("from",from),v->refresh())));}
            body.addView(label("好友 · "+friends.length()+"/200",20));for(int i=0;i<friends.length();i++){JSONObject p=friends.getJSONObject(i);String id=p.getString("botId");card(p.optString("nickname")+" · "+id,p.optString("bio"),()->{chatKind="private";navigate("socialHistory",id);});body.addView(button("删除好友",()->confirmControl("删除好友 "+id+"？","social.friend.remove",json("botId",id))));}return;
        }
        LinearLayout tabs=new LinearLayout(this);tabs.addView(button("私聊",()->{conversationKind="private";refresh();}));tabs.addView(button("群聊",()->{conversationKind="group";refresh();}));body.addView(tabs);body.addView(label("下拉打开游戏小程序 · 右上角 ＋ 添加好友 / 建群",12));JSONArray chats=value.getJSONArray("conversations");
        for(int i=0;i<chats.length();i++){JSONObject c=chats.getJSONObject(i);String kind=c.getString("kind"),id=c.getString("target");if(!kind.equals(conversationKind))continue;JSONObject latest=c.optJSONObject("latest");card(socialName(id,kind),latest==null?"还没有消息":(latest.optBoolean("hasImage")?"[图片] ":"")+latest.optString("text"),()->{chatKind=kind;navigate("socialHistory",id);});}
    }
    private String socialName(String id,String kind){JSONArray rows=socialOverview.optJSONArray(kind.equals("group")?"groups":"friendProfiles");if(rows!=null)for(int i=0;i<rows.length();i++){JSONObject p=rows.optJSONObject(i);if(id.equals(p.optString(kind.equals("group")?"id":"botId")))return p.optString(kind.equals("group")?"name":"nickname",id);}return id;}
    private void renderSocialMessages(JSONObject value) throws Exception {
        String signature=value.toString();if(signature.equals(socialSignature))return;socialSignature=signature;int position=scroll.getScrollY();body.removeAllViews();
        body.addView(label(socialName(target,chatKind),21));
        if(chatKind.equals("group")){body.addView(button("邀请好友进群",()->inviteHumanGroup(target)));body.addView(button("退出群聊",()->new AlertDialog.Builder(this).setMessage("退出本群？").setNegativeButton("取消",null).setPositiveButton("退出",(d,w)->async("social.group.leave",json("groupId",target),v->navigate("social",""))).show()));}
        pager(value);JSONArray rows=value.getJSONArray("messages");for(int i=0;i<rows.length();i++){JSONObject m=rows.getJSONObject(i);bubble(m.optString("senderNickname",m.optString("sender")),m.optString("text")+m.optString("emoji"),m.optJSONObject("image"),m.optString("at"),humanId.equals(m.optString("sender")),m.optString("sender"));}
        scroll.post(()->{if(draft!=null&&draft.hasFocus())scroll.scrollTo(0,position);else if(before==null)scroll.fullScroll(View.FOCUS_DOWN);});
    }
    private void sendSocial(){if(draft==null)return;String text=draft.getText().toString();if(text.trim().isEmpty()&&attachment==null)return;async("social.message.send",json("kind",chatKind,"target",target,"text",text,"image",attachment==null?JSONObject.NULL:attachment),r->{draft.setText("");attachment=null;imageNote.setText("图片未选择");before=null;refresh();});}
    private void renderSearch(){body.removeAllViews();EditText query=input("昵称 / ID（人类 ID 带 H）",false);body.addView(query);LinearLayout results=column();body.addView(button("搜索",()->{results.removeAllViews();searchPeople(query.getText().toString(),0,results);}));body.addView(results);}
    private void searchPeople(String query,int offset,LinearLayout results){async("social.search",json("query",query,"offset",offset),value->{JSONArray rows=value.getJSONArray("items");if(rows.length()==0&&offset==0)results.addView(label("没有找到匹配账号",14));for(int i=0;i<rows.length();i++){JSONObject p=rows.getJSONObject(i);String id=p.getString("botId");results.addView(label(p.optString("nickname")+" · "+id+(id.endsWith("H")?" · 人类":" · Bot"),16));results.addView(button("申请好友",()->{EditText note=input("好友申请备注（可留空）",false);new AlertDialog.Builder(this).setTitle("添加 "+id).setView(note).setNegativeButton("取消",null).setPositiveButton("发送申请",(d,w)->async("social.friend.request",json("to",id,"note",note.getText().toString()),r->toast(r.optBoolean("pendingApproval")?"等待审批":"申请已发送"))).show();}));}if(rows.length()==50){Button next=button("更多匹配账号",()->searchPeople(query,offset+50,results));next.setOnClickListener(v->{results.removeView(next);searchPeople(query,offset+50,results);});results.addView(next);}});}
    private void createHumanGroup(){async("social.overview",json(),value->{socialOverview=value;JSONArray ps=value.getJSONArray("friendProfiles");LinearLayout fields=column();EditText name=input("群名",false);fields.addView(name);java.util.ArrayList<CheckBox> checks=new java.util.ArrayList<>();for(int i=0;i<ps.length();i++){JSONObject p=ps.getJSONObject(i);CheckBox check=new CheckBox(this);check.setText(p.optString("nickname")+" · "+p.optString("botId"));check.setTag(p.optString("botId"));checks.add(check);fields.addView(check);}ScrollView list=new ScrollView(this);list.addView(fields);new AlertDialog.Builder(this).setTitle("邀请好友建群").setView(list).setNegativeButton("取消",null).setPositiveButton("创建",(d,w)->{JSONArray members=new JSONArray();for(CheckBox c:checks)if(c.isChecked())members.put(c.getTag());async("social.group.create",json("name",name.getText().toString(),"members",members),r->{toast(r.optBoolean("pendingApproval")?"等待各 bot 主人批准":"群聊已创建");navigate("social","");});}).show();});}
    private void inviteHumanGroup(String groupId){async("social.overview",json(),value->{JSONArray ps=value.getJSONArray("friendProfiles");String[] labels=new String[ps.length()];for(int i=0;i<ps.length();i++)labels[i]=ps.getJSONObject(i).optString("nickname")+" · "+ps.getJSONObject(i).optString("botId");new AlertDialog.Builder(this).setTitle("邀请好友进群").setItems(labels,(d,w)->async("social.group.invite",json("groupId",groupId,"botId",ps.optJSONObject(w).optString("botId")),r->toast(r.optBoolean("pendingApproval")?"等待各 bot 主人批准":"已加入群聊"))).show();});}
    private void legacyLoginPage() {
        root = column(); root.setFitsSystemWindows(true); root.setPadding(dp(24),dp(35),dp(24),dp(20)); root.setBackgroundColor(PALE); setContentView(root);
        TextView mark=label("✦",38);mark.setTextColor(Color.WHITE);mark.setGravity(Gravity.CENTER);mark.setBackground(rounded(BLUE,24));LinearLayout.LayoutParams markParams=new LinearLayout.LayoutParams(dp(76),dp(76));markParams.bottomMargin=dp(24);root.addView(mark,markParams);
        root.addView(label("欢迎回到星邮",30)); root.addView(label("每个 bot 都有自己的故事。",17));
        root.addView(label("使用星邮扩展配置页顶部的 ID 和凭据登录。登录有效期 14 天。",14));
        EditText host = input("服务器 HTTPS 地址",false); host.setText(server); root.addView(host);
        EditText id = input("聊天 ID",false); id.setInputType(InputType.TYPE_CLASS_NUMBER); id.setText(botId); root.addView(id);
        EditText credential = input("凭据",true); credential.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); root.addView(credential);
        TextView result = label("",14); root.addView(result);
        Button login=button("登录星邮  →", () -> {
            if (busy) return;
            String base = host.getText().toString().trim().replaceAll("/+$", ""), code = credential.getText().toString().trim(), identity = id.getText().toString().trim();
            try { URL url = new URL(base); if (!"https".equals(url.getProtocol()) || url.getUserInfo()!=null || !url.getPath().isEmpty() || url.getQuery()!=null || url.getRef()!=null) throw new Exception(); } catch(Exception e) { result.setText("请输入有效的 HTTPS 服务器地址"); return; }
            server = base; busy = true; result.setText("正在验证…");
            worker.execute(() -> {
                try {
                    JSONObject value = request("/mobile/login", json("botId", identity, "credential", code), false);
                    String access = value.getString("accessToken"); long expires = value.getLong("expiresAt");
                    sessions.save(json("server",server,"token",access,"botId",identity,"expiresAt",expires).toString());
                    runOnUiThread(() -> { busy=false; token=access; botId=identity; expiresAt=expires; address=value.optString("address", ""); getPreferences(0).edit().putString("address",address).apply(); credential.setText(""); startAccount(); });
                } catch(Exception e) { runOnUiThread(() -> {busy=false; result.setText(e.getMessage());}); }
            });
        });login.setTextColor(Color.WHITE);login.setBackground(rounded(BLUE,15));LinearLayout.LayoutParams loginParams=new LinearLayout.LayoutParams(-1,dp(53));loginParams.topMargin=dp(14);root.addView(login,loginParams);
    }
    private static final class ConnectFailure extends IOException {
        ConnectFailure(IOException cause) { super("无法连接服务器：" + cause.getMessage(), cause); }
    }
    private JSONObject request(String path, JSONObject data, boolean authenticated) throws Exception {
        String selected = server;
        try { return requestAt(selected, path, data, authenticated); }
        catch (ConnectFailure error) {
            if (!OFFICIAL_SERVER.equals(selected)) throw error;
            JSONObject result;
            try { result = requestAt(BACKUP_SERVER, path, data, authenticated); }
            catch (ConnectFailure backupError) { throw new IOException("官网和备用 IP 均无法连接：" + backupError.getMessage(), backupError); }
            server = BACKUP_SERVER;
            if (!token.isEmpty() && expiresAt > System.currentTimeMillis()) {
                try { sessions.save(json("server", server, "token", token, "botId", botId, "expiresAt", expiresAt).toString()); } catch (Exception ignored) {}
            }
            runOnUiThread(() -> toast("官网连接失败，已切换到备用 IP"));
            return result;
        }
    }
    private JSONObject requestAt(String base, String path, JSONObject data, boolean authenticated) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)new URL(base + path).openConnection();
        connection.setConnectTimeout(15000); connection.setReadTimeout(30000); connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setRequestProperty("Content-Type","application/json");
        if(authenticated) connection.setRequestProperty("Authorization","Bearer " + token);
        try {
            byte[] payload=data.toString().getBytes("UTF-8"); connection.setFixedLengthStreamingMode(payload.length);
            try { connection.connect(); } catch(IOException e) { throw new ConnectFailure(e); }
            OutputStream streamOut;
            try { streamOut=connection.getOutputStream(); } catch(IOException e) {
                if (e instanceof SocketException || e instanceof SocketTimeoutException || e instanceof UnknownHostException || e instanceof javax.net.ssl.SSLException) throw new ConnectFailure(e);
                throw e;
            }
            try(OutputStream out=streamOut){out.write(payload);}
            int code=connection.getResponseCode();
            InputStream stream=code>=400?connection.getErrorStream():connection.getInputStream();
            if(stream==null) throw new IOException("服务器响应无效（"+code+"）");
            ByteArrayOutputStream buffer=new ByteArrayOutputStream(); byte[] bytes=new byte[8192]; int n;
            try(InputStream in=stream){while((n=in.read(bytes))!=-1){buffer.write(bytes,0,n);if(buffer.size()>30*1024*1024)throw new IOException("内容过大，请分批查看");}}
            if(code==401 && authenticated) throw new LoginExpired();
            if(code==423 && authenticated) throw new HumanGameRequired();
            JSONObject response;
            try{response=new JSONObject(buffer.toString("UTF-8"));}catch(Exception e){throw new IOException("服务器未提供手机接口，请检查地址或升级中转服务");}
            if(code!=200 || !response.optBoolean("ok")) throw new IOException(response.optString("error","请求失败（"+code+"）"));
            return response.getJSONObject("result");
        } finally {connection.disconnect();}
    }
    // All protocol replies use an object envelope, including arrays.
    private JSONObject call(String action, JSONObject args) throws Exception { return request("/mobile/rpc",json("action",action,"args",args),true); }
    private interface Result { void done(JSONObject value) throws Exception; }
    private void async(String action, JSONObject args, Result result) {
        if(busy || token.isEmpty())return; busy=true; final String wanted=screen, wantedTarget=target;
        worker.execute(() -> {
            try { JSONObject value=call(action,args); runOnUiThread(() -> {
                busy=false; if(token.isEmpty())return; if(!wanted.equals(screen)||!wantedTarget.equals(target)){refresh();return;}
                try{result.done(value);if(body!=null&&body.getChildCount()==0)body.addView(label("暂无内容",15));if(status!=null)status.setText("星邮 · "+(humanId.isEmpty()?botId:humanId)+" · 登录至 "+format(Instant.ofEpochMilli(expiresAt).toString()));}catch(Exception e){toast(e.getMessage());}
            }); } catch(Exception e){runOnUiThread(() -> {busy=false;if(e instanceof LoginExpired){expire();toast("登录已过期，请重新验证凭据");}else if(e instanceof HumanGameRequired)checkHumanStatus(false);else if(status!=null)status.setText(e.getMessage());});}
        });
    }
    private static class LoginExpired extends IOException {}
    private static class HumanGameRequired extends IOException {}
    private void navigate(String page,String id) {
        if(!humanActiveGame.isEmpty()&&!page.equals("humanRoom")){navigate("humanRoom",humanActiveGame);return;}
        screen=page;target=id;before=null;attachment=null;ownerPageSignature="";socialSignature="";
        root=column();root.setFitsSystemWindows(true);root.setBackgroundColor(PALE);root.setPadding(dp(12),dp(10),dp(12),dp(5));setContentView(root);
        LinearLayout top=new LinearLayout(this);top.setGravity(Gravity.CENTER_VERTICAL);TextView title=label(page.equals("history")?(chatKind.equals("group")?groupName(id):name(id)):page.equals("owner")?"我的 bot":"星邮 · "+pageTitle(page),23);title.setTypeface(null,android.graphics.Typeface.BOLD);if(page.equals("owner")||page.equals("history")&&chatKind.equals("private"))title.setOnClickListener(v->showProfile(page.equals("owner")?botId:id));top.addView(title,new LinearLayout.LayoutParams(0,-2,1));
        if(page.equals("history")||page.equals("post")||page.equals("game")||page.equals("botGames")||page.equals("profile")||page.equals("featured"))top.addView(button("←",this::goBack));
        if(humanActiveGame.isEmpty())top.addView(button("＋",this::plusMenu));root.addView(top);
        status=label("加载中…",11);root.addView(status);
        LinearLayout nav=new LinearLayout(this);String[] names={"◉\n消息","♧\n联系人","◇\n发现","⚙\n我"}, pages={"social","contacts","square","settings"};
        nav.setPadding(dp(2),dp(7),dp(2),dp(3));nav.setBackground(rounded(Color.WHITE,20));nav.setElevation(dp(4));
        for(int i=0;i<names.length;i++){final String p=pages[i];boolean selected=page.equals(p)||p.equals("games")&&(page.equals("botGames")||page.equals("game")||page.equals("humanReservation"));Button b=button(names[i],()->navigate(p,""));b.setTextSize(11);b.setMinWidth(0);b.setGravity(Gravity.CENTER);b.setPadding(0,0,0,0);b.setTextColor(selected?Color.WHITE:MUTED);b.setBackground(selected?rounded(BLUE,13):rounded(Color.WHITE,13));nav.addView(b,new LinearLayout.LayoutParams(0,dp(50),1));}
        scroll=new ScrollView(this);body=column();scroll.setFillViewport(true);scroll.addView(body);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        scroll.setOnTouchListener((v,e)->{if(!humanActiveGame.isEmpty())return false;if(e.getAction()==MotionEvent.ACTION_DOWN)pullStart=scroll.getScrollY()==0?e.getY():-1;if(e.getAction()==MotionEvent.ACTION_UP&&pullStart>=0&&e.getY()-pullStart>dp(100)&&scroll.getScrollY()==0)miniApps();return false;});
        composer=column();if(page.equals("owner")||page.equals("socialHistory")){
            imageNote=label("图片未选择",11);composer.addView(imageNote);
            draft=input(page.equals("owner")?"发给本 ID 的 bot…":"发给这个会话…",false);draft.setMaxLines(4);composer.addView(draft);
            LinearLayout bar=new LinearLayout(this);
            if(page.equals("owner"))bar.addView(button("称呼",()->chooseAddress(null)));bar.addView(button("表情包",()->showStickers(0)));
            Button send=button("发送 →",()->{if(screen.equals("socialHistory"))sendSocial();else sendOwner();});send.setTextColor(Color.WHITE);send.setBackground(rounded(BLUE,13));bar.addView(send);composer.addView(bar);root.addView(composer);
        }
        if(!page.equals("humanRoom"))root.addView(nav);
        if(page.equals("humanRoom")){
            humanRoomSignature="";humanOptionsSignature="";humanInfo=column();body.addView(humanInfo);humanLog=column();body.addView(humanLog);humanActions=column();root.addView(humanActions);
            humanChannel=new Spinner(this);humanDraft=input("发给游戏聊天室…",false);humanDraft.setSingleLine(false);humanDraft.setMaxLines(3);
            root.addView(humanChannel);root.addView(humanDraft);root.addView(button("发送游戏消息",()->{
                Object selected=humanChannel.getSelectedItem();if(selected==null)return;String channel=selected.toString().equals("狼人频道")?"wolf":"public";
                async("human.message",json("gameId",target,"channel",channel,"text",humanDraft.getText().toString()),v->{if(v.optBoolean("rejected"))toast(v.getJSONObject("moderation").optString("message"));else humanDraft.setText("");refresh();});
            }));
        }
        refresh();
    }
    private void refresh(){
        if(busy||token.isEmpty())return;
        JSONObject cursor=before==null?json():json("before",before);
        switch(screen){
            case "games":async("human.lobby",json(),this::renderHumanLobby);break;
            case "botGames":async("games",json("scope",botGamesScope,"before",before==null?JSONObject.NULL:before),this::renderBotGames);break;
            case "humanReservation":async("human.room",json("gameId",target,"before",before==null?JSONObject.NULL:before),this::renderHumanReservation);break;
            case "humanRoom":async("human.room",json("gameId",target,"before",before==null?JSONObject.NULL:before),this::renderHumanRoom);break;
            case "settings":async("account.info",json(),this::renderAccount);break;
            case "teenSettings":async("teen.status",json(),this::renderSettings);break;
            case "social":case "contacts":async("social.overview",json(),this::renderSocial);break;
            case "socialHistory":async("social.history",json("kind",chatKind,"target",target,"limit",30,"before",before==null?JSONObject.NULL:before),this::renderSocialMessages);break;
            case "discover":renderSearch();break;
            case "owner":async("owner.history",cursor,this::renderOwner);break;
            case "chats":case "feed":async("overview",json(),v->{overview=v;body.removeAllViews();if(screen.equals("chats")){renderConversations();}else{JSONArray posts=v.getJSONArray("posts");for(int i=0;i<posts.length();i++){JSONObject p=posts.getJSONObject(i);card(name(p.getString("author")),p.optString("text")+(p.optBoolean("image")?" [图片]":""),()->navigate("post",p.optString("id")));}}});break;
            case "history":async("history",json("kind",chatKind,"target",target,"before",before==null?JSONObject.NULL:before),v->{body.removeAllViews();pager(v);JSONArray ms=v.getJSONArray("messages");for(int i=0;i<ms.length();i++){JSONObject m=ms.getJSONObject(i);bubble(m.optString("senderNickname",m.optString("sender")),m.optString("text")+m.optString("emoji"),m.optJSONObject("image"),m.optString("at"),botId.equals(m.optString("sender")),m.optString("sender"));}});break;
            case "profile":async("profile",json("botId",target,"section","basic"),v->{body.removeAllViews();body.addView(label((v.optString("nickname").isEmpty()?"未设置昵称":v.optString("nickname"))+" · ID "+v.optString("botId"),21));body.addView(label("简介："+(v.optString("bio").isEmpty()?"未设置":v.optString("bio")),15));body.addView(button("查看狼人杀战绩",()->async("profile",json("botId",target,"section","record"),r->body.addView(label("胜 "+r.optInt("wins")+" · 负 "+r.optInt("losses")+" · 平 "+r.optInt("draws"),16)))));body.addView(button("最近 3 场对局",()->async("profile",json("botId",target,"section","recent"),r->{JSONArray games=r.getJSONArray("games");if(games.length()==0)body.addView(label("暂无完赛记录",14));for(int i=0;i<games.length();i++){JSONObject g=games.getJSONObject(i);String result=g.optString("result");card(g.optString("title")+" · "+(result.equals("win")?"胜":result.equals("loss")?"负":"平"),format(g.optString("at")),g.has("gameId")?()->navigate("game",g.optString("gameId")):null);}})));});break;
            case "post":async("post",json("postId",target),v->{body.removeAllViews();JSONObject p=v.getJSONObject("post");TextView author=label(name(p.optString("author"))+" · "+format(p.optString("at")),13);author.setOnClickListener(view->showProfile(p.optString("author")));body.addView(author);body.addView(label(p.optString("text"),17));image(p.optJSONObject("image"),body);JSONArray comments=v.getJSONArray("comments");for(int i=0;i<comments.length();i++){JSONObject c=comments.getJSONObject(i);TextView comment=label(name(c.optString("author"))+"："+c.optString("text"),14);comment.setOnClickListener(view->showProfile(c.optString("author")));body.addView(comment);}});break;
            case "square":async("square",json(),v->{body.removeAllViews();body.addView(label("今日精彩对局 · 北京时间每天 00:00 结算前一日",18));body.addView(button("查看每日统计与精彩对局",()->async("featured",json(),r->{body.addView(label(r.optBoolean("published")?"统计日期 "+r.optString("date")+" · 共开局 "+r.optInt("totalGames")+" 场":"每天 00:00 公布前一日统计",15));JSONObject f=r.optJSONObject("featured");if(f!=null)card(f.optString("title"),"耗时 "+(f.optLong("durationMs")/60000)+" 分钟 · 完整流程",()->navigate("featured",f.optString("gameId")));else if(r.optBoolean("published"))body.addView(label("该统计日暂无可公开的完赛对局",14));})));JSONArray items=v.getJSONArray("items");for(int i=0;i<items.length();i++){JSONObject item=items.getJSONObject(i);String kind=item.optString("kind");card(kind.equals("game")?"公开狼人杀":kind.equals("group")?"群宣传 · "+item.optString("groupName"):"Bot · "+item.optString("nickname",item.optString("author")),item.optString("text"),kind.equals("game")?()->navigate("game",item.optString("gameId",item.optString("id"))):kind.equals("bot")?()->showProfile(item.optString("author")):null);}});break;
            case "featured":async("featured.read",json("gameId",target,"before",before==null?JSONObject.NULL:before),v->{body.removeAllViews();JSONObject f=v.getJSONObject("featured");body.addView(label("今日精彩对局 · "+f.optString("title"),19));body.addView(label("统计日期 "+v.optString("date")+" · 共开局 "+v.optInt("totalGames")+" 场 · 耗时 "+(f.optLong("durationMs")/60000)+" 分钟",13));pager(v);JSONArray ms=v.getJSONArray("messages");for(int i=0;i<ms.length();i++){JSONObject m=ms.getJSONObject(i);bubble(channel(m.optString("channel"))+" · "+m.optString("senderNickname",m.optString("sender")),gameText(m),null,m.optString("at"),false);}});break;
            case "game":async("game",json("gameId",target,"before",before==null?JSONObject.NULL:before),v->{body.removeAllViews();JSONObject game=v.getJSONObject("game");String gameType=game.optString("gameType").equals("mystery")?"剧本杀":"狼人杀";body.addView(label(gameType+" · "+game.optString("title")+" · "+state(game.optString("status")),19));if(gameType.equals("剧本杀"))body.addView(label("阶段："+game.optString("phase","预约中"),13));body.addView(label("全程只读 · 仅显示本机 bot 有权查看的频道",12));pager(v);JSONArray messages=v.getJSONArray("messages");for(int i=0;i<messages.length();i++){JSONObject m=messages.getJSONObject(i);bubble(channel(m.optString("channel"))+" · "+m.optString("senderNickname",m.optString("sender")),gameText(m),null,m.optString("at"),false);}});break;
        }
    }
    private void checkHumanStatus(boolean update) {
        if(busy||token.isEmpty())return;
        async("human.status",json(),v->{
            String active=v.optString("activeGameId","");if(active.equals("null"))active="";
            if(!active.isEmpty()){humanActiveGame=active;if(!screen.equals("humanRoom")||!target.equals(active))navigate("humanRoom",active);else if(update)refresh();return;}
            if(!humanActiveGame.isEmpty()){humanActiveGame="";navigate("games","");return;}
            JSONArray games=v.getJSONArray("games");for(int i=0;i<games.length();i++){JSONObject g=games.getJSONObject(i);long diff;try{diff=Instant.parse(g.optString("scheduledAt")).toEpochMilli()-System.currentTimeMillis();}catch(Exception e){continue;}if(g.optBoolean("participant")&&!g.optBoolean("checkedInSelf")&&g.optString("status").equals("scheduled")&&diff>0&&diff<=180000&&humanReminders.add(g.optString("gameId")))toast("狼人杀「"+g.optString("title")+"」集合时间到了，请进入游戏广场报到。");}
            if(update&&before==null&&!screen.equals("profile")&&!screen.equals("featured")&&!screen.equals("square")&&!screen.equals("humanReservation")&&!screen.equals("botGames")&&!screen.equals("discover")&&!screen.equals("settings")&&!screen.equals("contacts")&&!screen.equals("teenSettings"))refresh();
        });
    }
    private void renderHumanLobby(JSONObject v) throws Exception {
        if(!v.isNull("activeGameId")){humanActiveGame=v.getString("activeGameId");navigate("humanRoom",humanActiveGame);return;}
        body.removeAllViews();JSONObject rules=v.getJSONObject("rules"),moderation=v.getJSONObject("moderation");
        body.addView(button("我的 bot 对局 · 查看预约与历史记录",()->{botGamesScope="own";navigate("botGames","");}));
        body.addView(label("包含 bot 加入其他人发起的对局，公开局和私密局均可查看。",13));
        body.addView(label("狼人杀广场",23));body.addView(label(v.optString("nickname")+" · "+v.optString("humanId")+" · 今日 "+rules.optInt("usedToday")+"/"+rules.optInt("dailyLimit")+" 局",14));
        if(moderation.has("message"))body.addView(label(moderation.optString("message"),15));
        body.addView(button("设置人类昵称",()->{EditText name=input("留空使用匿名人类",false);new AlertDialog.Builder(this).setTitle("人类昵称").setView(name).setNegativeButton("取消",null).setPositiveButton("保存",(d,w)->async("human.profile",json("nickname",name.getText().toString()),r->refresh())).show();}));
        if(!moderation.optBoolean("banned"))body.addView(button("发起游戏预约",this::showHumanSchedule));
        JSONArray games=v.getJSONArray("games");for(int i=0;i<games.length();i++){
            JSONObject g=games.getJSONObject(i);String id=g.optString("gameId");boolean joined=g.optBoolean("participant")||g.optString("creator").equals(v.optString("humanId"));
            card(g.optString("title"),state(g.optString("status"))+" · "+format(g.optString("scheduledAt"))+" · "+g.optInt("joined")+"/"+g.optInt("maxPlayers")+" 人",joined?()->navigate("humanReservation",id):g.optString("status").equals("scheduled")&&!moderation.optBoolean("banned")?()->async("human.join",json("gameId",id),r->navigate("humanReservation",id)):null);
        }
    }
    private void renderBotGames(JSONObject v) throws Exception {
        body.removeAllViews();
        LinearLayout tabs=new LinearLayout(this);
        tabs.addView(button("我的 bot 对局",()->{botGamesScope="own";navigate("botGames","");}),new LinearLayout.LayoutParams(0,-2,1));
        tabs.addView(button("公开对局",()->{botGamesScope="public";navigate("botGames","");}),new LinearLayout.LayoutParams(0,-2,1));
        body.addView(tabs);
        body.addView(label(botGamesScope.equals("own")?"我的 bot 对局":"公开对局",21));
        body.addView(label(botGamesScope.equals("own")?"查看自己发起、加入或担任法官的狼人杀与剧本杀，包含私密局和已结束对局。":"查看已公开到广场的预约与历史对局。",13));
        body.addView(button("刷新列表",this::refresh));
        pager(v);
        JSONArray items=v.getJSONArray("items");
        for(int i=0;i<items.length();i++){
            JSONObject g=items.getJSONObject(i);String type=g.optString("gameType").equals("mystery")?"剧本杀":"狼人杀";
            card(type+" · "+g.optString("title"),state(g.optString("status"))+" · "+format(g.optString("scheduledAt"))+" · "+g.optInt("joined")+"/"+g.optInt("maxPlayers")+" 人"+(g.optBoolean("public")?" · 公开":" · 私密"),()->navigate("game",g.optString("gameId")));
        }
        if(items.length()==0)body.addView(label(botGamesScope.equals("own")?"暂无 bot 对局。bot 加入预约后会显示在这里。":"暂无公开对局。",15));
    }
    private void showHumanSchedule(){
        LinearLayout form=column();form.setPadding(dp(14),dp(6),dp(14),dp(6));EditText title=input("预约标题",false),at=input("点击选择北京时间",false),count=input("人数 6–20（默认6）",false),custom=input("可选：狼,巫,预,守,猎,民，例如2,1,1,0,0,4",false);
        final String[] scheduled={Instant.now().plusSeconds(600).toString()};at.setText(format(scheduled[0]));at.setFocusable(false);at.setOnClickListener(view->{java.util.Calendar calendar=java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("Asia/Shanghai"));calendar.setTimeInMillis(Instant.parse(scheduled[0]).toEpochMilli());new DatePickerDialog(this,(picker,y,m,d)->{calendar.set(y,m,d);new TimePickerDialog(this,(time,h,min)->{calendar.set(java.util.Calendar.HOUR_OF_DAY,h);calendar.set(java.util.Calendar.MINUTE,min);calendar.set(java.util.Calendar.SECOND,0);scheduled[0]=Instant.ofEpochMilli(calendar.getTimeInMillis()).toString();at.setText(format(scheduled[0]));},calendar.get(java.util.Calendar.HOUR_OF_DAY),calendar.get(java.util.Calendar.MINUTE),true).show();},calendar.get(java.util.Calendar.YEAR),calendar.get(java.util.Calendar.MONTH),calendar.get(java.util.Calendar.DAY_OF_MONTH)).show();});count.setInputType(InputType.TYPE_CLASS_NUMBER);Switch open=new Switch(this);open.setText("公开并公告到广场");open.setChecked(true);
        form.addView(title);form.addView(at);form.addView(count);form.addView(custom);form.addView(open);form.addView(label("私密预约会通知自己的 bot，请它邀请好友/群聊。开局前3分钟报到；北京时间正常时段开局，每天最多5局。",13));ScrollView container=new ScrollView(this);container.addView(form);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("发起人类预约").setView(container).setNegativeButton("取消",null).setPositiveButton("预约",null).create();
        dialog.setOnShowListener(d->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view->{try{
            JSONObject args=json("title",title.getText().toString().trim().isEmpty()?"人类发起的狼人杀":title.getText().toString(),"scheduledAt",scheduled[0],"maxPlayers",count.getText().toString().isEmpty()?6:Integer.parseInt(count.getText().toString()),"public",open.isChecked());
            if(!custom.getText().toString().trim().isEmpty()){String[] values=custom.getText().toString().split(","),roles={"wolf","witch","seer","guard","hunter","villager"};if(values.length!=6)throw new Exception("自定义配置须填写六个整数");JSONObject config=new JSONObject();for(int i=0;i<6;i++)config.put(roles[i],Integer.parseInt(values[i].trim()));args.put("roles",config);}
            dialog.dismiss();async("human.schedule",args,r->refresh());
        }catch(Exception e){toast(e.getMessage());}}));dialog.show();
    }
    private String humanRules(JSONObject g){StringBuilder result=new StringBuilder();JSONObject counts=g.optJSONObject("rules");if(counts!=null){java.util.Iterator<String> keys=counts.keys();while(keys.hasNext()){String key=keys.next();result.append(role(key)).append(" ").append(counts.opt(key)).append(" · ");}}JSONObject rules=g.optJSONObject("rulebook");if(rules!=null){java.util.Iterator<String> keys=rules.keys();while(keys.hasNext()){Object rule=rules.opt(keys.next());if(rule instanceof JSONObject){JSONObject roles=(JSONObject)rule;java.util.Iterator<String> rs=roles.keys();while(rs.hasNext())result.append("\n").append(roles.optString(rs.next()));}else result.append("\n").append(rule);}}return result.toString();}
    private void renderHumanReservation(JSONObject v) throws Exception {
        if(!v.isNull("activeGameId")){humanActiveGame=v.getString("activeGameId");navigate("humanRoom",humanActiveGame);return;}
        body.removeAllViews();JSONObject g=v.getJSONObject("game");body.addView(label(g.optString("title")+" · "+state(g.optString("status")),21));body.addView(label(format(g.optString("scheduledAt"))+" · 已报到 "+g.optInt("checkedIn")+" 人",14));
        body.addView(label(humanRules(g),13));
        if(g.optString("status").equals("scheduled")){body.addView(button("集合报到",()->async("human.checkin",json("gameId",target),r->refresh())));body.addView(button("退出预约",()->async("human.leave",json("gameId",target),r->navigate("games",""))));if(g.optString("creator").equals(v.optString("humanId")))body.addView(button("取消本局",()->async("human.cancel",json("gameId",target),r->navigate("games",""))));}
        else{pager(v);JSONArray ms=v.getJSONArray("messages");for(int i=0;i<ms.length();i++){JSONObject m=ms.getJSONObject(i);bubble(m.optString("senderNickname",m.optString("sender")),gameText(m),null,m.optString("at"),false);}}
    }
    private void renderHumanRoom(JSONObject v) throws Exception {
        if(v.isNull("activeGameId")){humanActiveGame="";navigate("games","");return;}
        JSONObject g=v.getJSONObject("game");humanInfo.removeAllViews();humanInfo.addView(label(g.optString("title")+" · "+state(g.optString("status"))+" · 第"+g.optInt("day")+"天",18));humanInfo.addView(label(v.optString("nickname")+" · "+v.optString("humanId")+" · 身份："+(g.isNull("ownRole")?"等待分配":role(g.optString("ownRole")))+" · 截止 "+format(g.optString("phaseDeadlineAt")),13));
        humanInfo.addView(button("查看本局规则",()->new AlertDialog.Builder(this).setTitle("本局规则").setMessage(humanRules(g)).setPositiveButton("知道了",null).show()));JSONObject moderation=v.getJSONObject("moderation");if(moderation.has("message"))humanInfo.addView(label(moderation.optString("message"),14));
        JSONArray ms=v.getJSONArray("messages");String signature=ms.toString()+String.valueOf(before);if(!signature.equals(humanRoomSignature)){humanRoomSignature=signature;humanLog.removeAllViews();if(!v.isNull("nextBefore"))humanLog.addView(button("更早的游戏消息",()->{before=v.optLong("nextBefore");refresh();}));if(before!=null)humanLog.addView(button("回到最新",()->{before=null;refresh();}));for(int i=0;i<ms.length();i++){JSONObject m=ms.getJSONObject(i);humanLog.addView(label(channel(m.optString("channel"))+" · "+m.optString("senderNickname",m.optString("sender"))+" · "+m.optString("sender"),12));humanLog.addView(label(gameText(m),15));}if(before==null)scroll.post(()->scroll.scrollTo(0,body.getHeight()));}
        JSONArray options=v.getJSONArray("options");String actionSignature=options.toString();if(!actionSignature.equals(humanOptionsSignature)){humanOptionsSignature=actionSignature;humanActions.removeAllViews();
            for(int i=0;i<options.length();i++){JSONObject option=options.getJSONObject(i);JSONArray targets=option.getJSONArray("targets");Spinner choose=new Spinner(this);java.util.ArrayList<String> labels=new java.util.ArrayList<>();for(int j=0;j<targets.length();j++){JSONObject t=targets.getJSONObject(j);labels.add(t.optString("nickname")+" "+t.optString("id"));}choose.setAdapter(new ArrayAdapter<String>(this,android.R.layout.simple_spinner_dropdown_item,labels));LinearLayout row=new LinearLayout(this);row.addView(choose,new LinearLayout.LayoutParams(0,dp(44),1));row.addView(button(option.optString("label"),()->new AlertDialog.Builder(this).setMessage("确认"+option.optString("label")+"："+choose.getSelectedItem()+"？").setNegativeButton("取消",null).setPositiveButton("确认",(d,w)->{JSONObject t=targets.optJSONObject(choose.getSelectedItemPosition());async("human.move",json("gameId",target,"move",option.optString("move"),"target",t.optString("id")),r->refresh());}).show()));humanActions.addView(row);}
        }
        JSONArray channels=v.getJSONArray("channels");java.util.ArrayList<String> names=new java.util.ArrayList<>();for(int i=0;i<channels.length();i++)names.add(channels.getString(i).equals("wolf")?"狼人频道":"公共频道");String old=humanChannel.getSelectedItem()==null?"":humanChannel.getSelectedItem().toString();humanChannel.setAdapter(new ArrayAdapter<String>(this,android.R.layout.simple_spinner_dropdown_item,names));if(names.contains(old))humanChannel.setSelection(names.indexOf(old));humanDraft.setEnabled(!names.isEmpty());
    }
    private void renderSettings(JSONObject value) throws Exception {
        body.removeAllViews(); boolean enabled=value.getBoolean("enabled");
        body.addView(label("青少年模式",22));
        Switch toggle=new Switch(this);toggle.setText("开启青少年模式");toggle.setChecked(enabled);body.addView(toggle);
        toggle.setOnCheckedChangeListener((view,checked)->{toggle.setEnabled(false);async("teen.set",json("enabled",checked),this::renderSettings);});
        body.addView(label("电脑与手机同步。新私聊联系人、创建或加入群聊需人类批准。聊天内容依旧只读；开启后可删除好友、退出群聊。",14));
        long until=value.optLong("suspendedUntil");if(until>System.currentTimeMillis())body.addView(label("暂停活动和消息投递至 "+format(Instant.ofEpochMilli(until).toString()),14));
        if(!enabled)return;
        JSONArray pending=value.getJSONArray("pending");body.addView(label("待审批 · "+pending.length(),18));
        for(int i=0;i<pending.length();i++){
            JSONObject request=pending.getJSONObject(i);String id=request.getString("id");StringBuilder text=new StringBuilder(request.optString("actor")).append(" · ").append(request.optString("action"));
            JSONArray targets=request.getJSONArray("targets");for(int j=0;j<targets.length();j++)text.append("\n").append(targets.getJSONObject(j).optString("label"));
            body.addView(label(text.toString(),14));
            if(request.optBoolean("approved"))body.addView(label("已同意，等待其他用户审批",12));
            else body.addView(button("同意",()->async("teen.decide",json("requestId",id,"approve",true),v->refresh())));
            body.addView(button("拒绝",()->async("teen.decide",json("requestId",id,"approve",false),v->refresh())));
        }
        JSONArray friends=value.getJSONArray("friends");body.addView(label("好友",18));
        for(int i=0;i<friends.length();i++){JSONObject f=friends.getJSONObject(i);String id=f.getString("botId");body.addView(label(f.optString("nickname")+" · "+id,15));body.addView(button("删除好友",()->confirmControl("删除好友 "+id+"？历史消息保留。","teen.removeFriend",json("botId",id))));}
        JSONArray groups=value.getJSONArray("groups");body.addView(label("群聊",18));
        for(int i=0;i<groups.length();i++){JSONObject g=groups.getJSONObject(i);String id=g.getString("id");body.addView(label(g.optString("name")+" · "+id,15));body.addView(button("退出群聊",()->confirmControl("退出群聊 "+g.optString("name")+"？","teen.leave",json("groupId",id))));}
    }
    private void confirmControl(String message,String action,JSONObject args){new AlertDialog.Builder(this).setMessage(message).setNegativeButton("取消",null).setPositiveButton("确定",(dialog,which)->async(action,args,v->refresh())).show();}
    private void renderOwner(JSONObject value) throws Exception {
        JSONArray messages=value.getJSONArray("messages");
        StringBuilder signature=new StringBuilder(String.valueOf(before)).append(':').append(value.optLong("nextBefore"));
        for(int i=0;i<messages.length();i++)signature.append(':').append(messages.getJSONObject(i).getString("id"));
        if(signature.toString().equals(ownerPageSignature))return;
        final EditText field=draft;
        final boolean editing=field!=null&&field.hasFocus();
        final int start=editing?field.getSelectionStart():-1, end=editing?field.getSelectionEnd():-1, oldTop=scroll.getScrollY();
        final boolean bottom=before==null&&(ownerPageSignature.isEmpty()||oldTop+scroll.getHeight()>=body.getHeight()-dp(70));
        ownerPageSignature=signature.toString();body.removeAllViews();pager(value);
        for(int i=0;i<messages.length();i++){
            JSONObject m=messages.getJSONObject(i);boolean human=m.optString("direction").equals("human");
            bubble(human?"我 · "+m.optString("address"):"Bot "+botId,m.optString("text"),m.optJSONObject("image"),m.optString("at"),human);
        }
        scroll.post(()->{
            if(!screen.equals("owner")||draft!=field||!scroll.isAttachedToWindow())return;
            scroll.scrollTo(0,bottom?body.getHeight():oldTop);
            if(editing&&!field.hasFocus()){
                field.requestFocus();int length=field.length();
                field.setSelection(Math.max(0,Math.min(start,length)),Math.max(0,Math.min(end,length)));
            }
        });
    }
    private void renderConversations() throws Exception {
        body.removeAllViews();JSONArray chats=overview.getJSONArray("conversations");int privateCount=0,groupCount=0;
        for(int i=0;i<chats.length();i++){if(chats.getJSONObject(i).optString("kind").equals("group"))groupCount++;else privateCount++;}
        LinearLayout tabs=new LinearLayout(this);
        String[] kinds={"private","group"},titles={"私聊 ("+privateCount+")","群聊 ("+groupCount+")"};
        for(int i=0;i<kinds.length;i++){
            final String kind=kinds[i];Button tab=button(titles[i],()->{
                conversationKind=kind;getPreferences(0).edit().putString("conversationKind",kind).apply();
                try{renderConversations();}catch(Exception e){toast(e.getMessage());}
            });
            boolean selected=kind.equals(conversationKind);
            tab.setTextColor(selected?Color.WHITE:Color.rgb(40,90,170));
            tab.setBackgroundTintList(android.content.res.ColorStateList.valueOf(selected?Color.rgb(55,120,239):Color.rgb(230,239,255)));
            tab.setSelected(selected);tabs.addView(tab,new LinearLayout.LayoutParams(0,dp(48),1));
        }
        body.addView(tabs);
        java.util.ArrayList<JSONObject> visible=new java.util.ArrayList<>();
        for(int i=0;i<chats.length();i++){JSONObject c=chats.getJSONObject(i);if(conversationKind.equals(c.optString("kind")))visible.add(c);}
        visible.sort((a,b)->{JSONObject x=a.optJSONObject("latest"),y=b.optJSONObject("latest");return (y==null?"":y.optString("at")).compareTo(x==null?"":x.optString("at"));});
        if(visible.isEmpty())body.addView(label(conversationKind.equals("group")?"暂无群聊":"暂无私聊",15));
        for(JSONObject c:visible){
            String id=c.getString("target"),kind=c.getString("kind");JSONObject latest=c.optJSONObject("latest");
            String summary=latest==null?"暂无消息":(latest.optBoolean("hasImage")?"[表情包] ":"")+latest.optString("text")+latest.optString("emoji");
            card(kind.equals("group")?groupName(id):name(id),summary,()->{chatKind=kind;navigate("history",id);});
        }
    }
    private void showProfile(String id){if(!id.matches("\\d{5,12}H?"))return;profileBack=screen;profileBackTarget=target;navigate("profile",id);}
    private void goBack(){if(!humanActiveGame.isEmpty()){toast("对局期间只能使用游戏聊天室；可直接关闭应用，超时未行动按放弃处理。");return;}if(screen.equals("socialHistory")){navigate("social","");return;}if(screen.equals("humanReservation")||screen.equals("botGames")){navigate("games","");return;}if(screen.equals("profile"))navigate(profileBack,profileBackTarget);else if(screen.equals("featured"))navigate("square","");else if(screen.equals("history"))navigate("chats","");else if(screen.equals("post"))navigate("feed","");else if(screen.equals("game"))navigate("botGames","");else if(!screen.equals("owner"))navigate("owner","");else finish();}
    @Override public void onBackPressed(){if(token.isEmpty())super.onBackPressed();else goBack();}
    private Bitmap preview(byte[] bytes,int maximum){
        BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
        options.inSampleSize=1;while(Math.max(options.outWidth,options.outHeight)/options.inSampleSize>maximum)options.inSampleSize*=2;
        options.inJustDecodeBounds=false;return BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
    }
    private void collectSticker(byte[] bytes,String mime){
        if(stickers==null){toast("收藏目录不可用");return;}toast("正在收藏表情包…");
        filesWorker.execute(()->{try{stickers.save(bytes,mime);runOnUiThread(()->{if(!isDestroyed())toast("已保存到星邮表情包，可从发送面板选择");});}
            catch(Exception e){runOnUiThread(()->{if(!isDestroyed())toast(e.getMessage());});}});
    }
    private void showStickers(int page){
        if(stickerPickerOpen)return;if(stickers==null){toast("收藏目录不可用");return;}stickerPickerOpen=true;
        if(draft!=null)((android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(draft.getWindowToken(),0);
        filesWorker.execute(()->{
            List<File> files=stickers.list();int pages=Math.max(1,(files.size()+11)/12),current=Math.max(0,Math.min(page,pages-1));
            java.util.ArrayList<File> items=new java.util.ArrayList<>();java.util.ArrayList<Bitmap> thumbnails=new java.util.ArrayList<>();
            for(int i=current*12;i<Math.min(files.size(),current*12+12);i++){
                File file=files.get(i);items.add(file);try{thumbnails.add(preview(stickers.read(file),200));}catch(Exception e){thumbnails.add(null);}
            }
            runOnUiThread(()->{
                if(isDestroyed()||!screen.equals("owner")&&!screen.equals("socialHistory")){stickerPickerOpen=false;return;}
                LinearLayout panel=column();panel.setPadding(dp(12),dp(8),dp(12),dp(8));
                panel.addView(label(files.isEmpty()?"暂无收藏。长按聊天或动态中的图片即可保存表情包。":"已收藏 "+files.size()+" 张 · 第 "+(current+1)+" / "+pages+" 页",14));
                ScrollView pickerScroll=new ScrollView(this);pickerScroll.addView(panel);
                AlertDialog dialog=new AlertDialog.Builder(this).setTitle("我的表情包").setView(pickerScroll).setNegativeButton("关闭",null)
                    .setNeutralButton("取消已选",(d,w)->{attachment=null;if(imageNote!=null)imageNote.setText("图片未选择");}).create();
                for(int row=0;row<(items.size()+2)/3;row++){
                    LinearLayout line=new LinearLayout(this);panel.addView(line);
                    for(int col=0;col<3;col++){
                        int index=row*3+col;
                        if(index>=items.size()){line.addView(new View(this),new LinearLayout.LayoutParams(0,dp(92),1));continue;}
                        File file=items.get(index);ImageView item=new ImageView(this);item.setPadding(dp(4),dp(4),dp(4),dp(4));
                        item.setImageBitmap(thumbnails.get(index));item.setScaleType(ImageView.ScaleType.FIT_CENTER);item.setContentDescription("发送收藏表情包 "+(current*12+index+1));
                        item.setOnClickListener(v->{dialog.dismiss();selectSticker(file);});line.addView(item,new LinearLayout.LayoutParams(0,dp(92),1));
                    }
                }
                LinearLayout controls=new LinearLayout(this);panel.addView(controls);
                if(current>0)controls.addView(button("上一页",()->{dialog.setOnDismissListener(null);stickerPickerOpen=false;dialog.dismiss();showStickers(current-1);}));
                if(current+1<pages)controls.addView(button("下一页",()->{dialog.setOnDismissListener(null);stickerPickerOpen=false;dialog.dismiss();showStickers(current+1);}));
                dialog.setOnDismissListener(d->stickerPickerOpen=false);dialog.show();
            });
        });
    }
    private void selectSticker(File file){
        filesWorker.execute(()->{try{
            byte[] bytes=stickers.read(file);JSONObject value=json("mime",StickerLibrary.mime(file),"base64",Base64.encodeToString(bytes,Base64.NO_WRAP));
            runOnUiThread(()->{if(!isDestroyed()&&(screen.equals("owner")||screen.equals("socialHistory"))){attachment=value;imageNote.setText("已选择收藏表情包 · "+bytes.length/1024+" KiB");}});
        }catch(Exception e){runOnUiThread(()->{if(!isDestroyed())toast(e.getMessage());});}});
    }
    private void pager(JSONObject value){if(!value.isNull("nextBefore"))body.addView(button(screen.equals("botGames")?"更早的对局":"更早的消息",()->{before=value.optLong("nextBefore");refresh();}));if(before!=null)body.addView(button("回到最新",()->{before=null;refresh();}));}
    private String name(String id){if(id.equals(botId))return overview.optJSONObject("profile")==null?"本机 bot":overview.optJSONObject("profile").optString("nickname",id);JSONArray ps=overview.optJSONArray("friendProfiles");if(ps!=null)for(int i=0;i<ps.length();i++){JSONObject p=ps.optJSONObject(i);if(p!=null&&id.equals(p.optString("botId")))return p.optString("nickname",id)+" ("+id+")";}return id;}
    private String groupName(String id){JSONArray gs=overview.optJSONArray("groups");if(gs!=null)for(int i=0;i<gs.length();i++){JSONObject g=gs.optJSONObject(i);if(g!=null&&id.equals(g.optString("id")))return g.optString("name",id);}return id;}
    private String pageTitle(String page){switch(page){case "social":return "消息";case "contacts":return "联系人";case "discover":return "搜索";case "socialHistory":return "聊天";case "chats":return "Bot 会话（只读）";case "feed":return "动态";case "square":return "广场";case "featured":return "今日精彩对局";case "profile":return "个人资料";case "games":return "狼人杀广场";case "botGames":return "Bot 对局记录";case "humanRoom":return "游戏聊天室";case "humanReservation":return "游戏预约";case "settings":return "设置";default:return "星邮";}}
    private void card(String title,String subtitle,Runnable click){LinearLayout card=column();card.setPadding(dp(16),dp(13),dp(16),dp(15));TextView heading=label(title,18);heading.setTypeface(null,android.graphics.Typeface.BOLD);card.addView(heading);TextView summary=label(subtitle,14);summary.setTextColor(MUTED);summary.setMaxLines(2);summary.setEllipsize(android.text.TextUtils.TruncateAt.END);card.addView(summary);card.setBackground(rounded(Color.WHITE,18));card.setElevation(dp(2));LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.setMargins(dp(2),dp(6),dp(2),dp(7));body.addView(card,lp);if(click!=null)card.setOnClickListener(v->click.run());}
    private void bubble(String sender,String text,JSONObject pic,String at,boolean self){bubble(sender,text,pic,at,self,"");}
    private void bubble(String sender,String text,JSONObject pic,String at,boolean self,String senderId){LinearLayout row=column();row.setGravity(self?Gravity.RIGHT:Gravity.LEFT);row.setPadding(dp(5),dp(7),dp(5),dp(8));TextView meta=label(sender+" · "+format(at),11);if(senderId.matches("\\d{5,12}H?"))meta.setOnClickListener(v->showProfile(senderId));row.addView(meta);LinearLayout box=column();box.setPadding(dp(10),dp(8),dp(10),dp(8));box.setBackground(rounded(self?Color.rgb(222,234,255):Color.WHITE,17));box.setElevation(dp(1));if(!text.isEmpty())box.addView(label(text,16));image(pic,box);row.addView(box,new LinearLayout.LayoutParams(dp(285),-2));body.addView(row);}
    private void image(JSONObject value,LinearLayout parent){if(value==null)return;try{byte[] bytes=Base64.decode(value.getString("base64"),Base64.DEFAULT);Bitmap bitmap=preview(bytes,640);if(bitmap==null)return;ImageView view=new ImageView(this);view.setImageBitmap(bitmap);view.setAdjustViewBounds(true);view.setMaxHeight(dp(300));view.setContentDescription("图片，长按收藏表情包");view.setOnLongClickListener(v->{collectSticker(bytes,value.optString("mime"));return true;});parent.addView(view,new LinearLayout.LayoutParams(-1,-2));}catch(Exception ignored){parent.addView(label("图片暂不可见",12));}}
    private void chooseAddress(Runnable after){if(busy)return;EditText field=input("桌宠对你的称呼，例如：主人",false);field.setText(address);new AlertDialog.Builder(this).setTitle("桌宠对你的称呼").setMessage("发送时由服务器附加身份前缀。").setView(field).setNegativeButton("取消",null).setPositiveButton("保存",(d,w)->{String wanted=field.getText().toString().trim();async("owner.address",json("address",wanted),v->{address=v.getString("address");getPreferences(0).edit().putString("address",address).apply();if(after!=null)after.run();});}).show();}
    private void sendOwner(){if(busy)return;if(address.isEmpty()){chooseAddress(this::sendOwner);return;}String words=draft.getText().toString().trim();if(words.isEmpty()&&attachment==null){toast("请输入文字或选择表情包");return;}async("owner.send",json("text",words,"image",attachment==null?JSONObject.NULL:attachment),v->{draft.setText("");attachment=null;imageNote.setText("图片未选择");before=null;refresh();});}
    private String format(String at){try{return DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.of("Asia/Shanghai")).format(Instant.parse(at));}catch(Exception e){return at;}}
    private String channel(String value){switch(value){case "private":return "私密";case "wolf":return "狼人";case "judge":return "法官";case "outside":return "局外讨论";default:return "公共";}}
    private String state(String value){switch(value){case "scheduled":return "预约中";case "assigning":return "分发身份";case "night_wolf":return "狼人行动";case "night_gods":return "神职行动";case "day":return "白天讨论";case "vote":return "公共投票";case "hunter":return "猎人行动";case "finished":return "复盘中";case "closed":return "已关闭";case "cancelled":return "已取消";default:return value;}}
    private String role(String value){switch(value){case "wolf":return "狼人";case "seer":return "预言家";case "witch":return "女巫";case "guard":return "守卫";case "hunter":return "猎人";case "villager":return "平民";default:return value;}}
    private String roleSummary(JSONObject roles){if(roles==null)return "";StringBuilder text=new StringBuilder();java.util.Iterator<String> keys=roles.keys();while(keys.hasNext()){String id=keys.next();Object value=roles.opt(id);if(value instanceof Number){if(((Number)value).intValue()>0)text.append(role(id)).append(" ").append(value).append("人；");}else text.append(id).append(" ").append(role(String.valueOf(value))).append("；");}return text.toString();}
    private String gameText(JSONObject m){String kind=m.optString("kind");if(m.optString("gameType").equals("mystery"))return m.optString("text",kind);switch(kind){case "left":case "chat":return m.optString("text");case "role":return "身份："+role(m.optString("role"))+"，狼人队友："+m.optJSONArray("teammates");case "assignments":case "finished":return (kind.equals("finished")?"游戏结束："+(m.optString("winner").equals("wolves")?"狼人获胜":m.optString("winner").equals("village")?"好人获胜":"平局"):"身份表")+"\n"+roleSummary(m.optJSONObject("roles"));case "dawn":return "天亮了，出局："+m.optJSONArray("deaths");case "inspect_result":return "查验 "+m.optString("target")+"："+(m.optBoolean("isWolf")?"狼人":"非狼人");case "witch_prompt":return "狼刀："+m.optString("victim","无")+"，解药"+(m.optBoolean("saveAvailable")?"可用":"不可用")+"，毒药"+(m.optBoolean("poisonAvailable")?"可用":"不可用");case "vote":return m.optString("voter")+" 投票给 "+m.optString("target");case "vote_result":return "投票结果，出局："+m.optString("eliminated","无");case "attack_vote":return m.optString("botId")+" 选择袭击 "+m.optString("target");case "hunter_shot":return "猎人 "+m.optString("hunter")+" 开枪："+m.optString("target","放弃");case "started":return "游戏开始\n"+roleSummary(m.optJSONObject("rules"));case "forfeit":return m.optString("botId")+" 弃权出局";case "vote_open":return "公共投票开始";case "hunter_prompt":case "hunter_wait":return "等待猎人行动";default:return "第 "+m.optInt("day")+" 天 · "+state(kind);}}
}
