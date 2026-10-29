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
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SessionStore sessions;
    private String server = "https://8.148.13.225", token = "", botId = "", address = "", screen = "owner", target = "", chatKind = "";
    private long expiresAt;
    private boolean busy, resumed;
    private LinearLayout root, body, composer;
    private ScrollView scroll;
    private TextView status, imageNote;
    private EditText draft;
    private JSONObject attachment, overview = new JSONObject();
    private Long before = null;
    private final Runnable timer = new Runnable() { public void run() {
        if (resumed && !token.isEmpty()) {
            if (System.currentTimeMillis() >= expiresAt) { expire(); return; }
            if (before == null && !busy) refresh();
        }
        if (resumed) handler.postDelayed(this, 8000);
    }};
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); sessions = new SessionStore(this);
        try {
            JSONObject saved = new JSONObject(sessions.load());
            server = saved.getString("server"); token = saved.getString("token"); botId = saved.getString("botId"); expiresAt = saved.getLong("expiresAt");
            address = getPreferences(0).getString("address", "");
        } catch (Exception ignored) { token = ""; }
        getWindow().setStatusBarColor(Color.rgb(245,248,255)); getWindow().setNavigationBarColor(Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        if (token.isEmpty() || expiresAt <= System.currentTimeMillis()) expire(); else navigate("owner", "");
    }
    @Override public void onResume() { super.onResume(); resumed = true; handler.removeCallbacks(timer); handler.postDelayed(timer, 8000); if (!token.isEmpty() && System.currentTimeMillis() >= expiresAt) expire(); }
    @Override public void onPause() { resumed = false; handler.removeCallbacks(timer); super.onPause(); }
    @Override public void onDestroy() { handler.removeCallbacksAndMessages(null); worker.shutdownNow(); super.onDestroy(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(1); return view; }
    private TextView label(String text, int size) { TextView v = new TextView(this); v.setText(text); v.setTextSize(size); v.setTextColor(Color.rgb(27,39,65)); v.setPadding(dp(8),dp(7),dp(8),dp(7)); v.setTextIsSelectable(true); return v; }
    private Button button(String title, Runnable action) { Button b = new Button(this); b.setText(title); b.setAllCaps(false); b.setOnClickListener(v -> action.run()); return b; }
    private EditText input(String hint, boolean secret) { EditText v = new EditText(this); v.setHint(hint); v.setTextSize(15); if (secret) v.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD); return v; }
    private JSONObject json(Object... pairs) { JSONObject value = new JSONObject(); try { for (int i=0;i<pairs.length;i+=2) value.put((String)pairs[i], pairs[i+1]); } catch (JSONException e) { throw new IllegalArgumentException(e); } return value; }
    private void toast(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    private void expire() { token = ""; expiresAt = 0; sessions.clear(); loginPage(); }
    private void loginPage() {
        root = column(); root.setFitsSystemWindows(true); root.setPadding(dp(24),dp(40),dp(24),dp(20)); root.setBackgroundColor(Color.WHITE); setContentView(root);
        root.addView(label("星邮",32)); root.addView(label("随时看看 bot 的生活",17));
        root.addView(label("使用星邮扩展配置页顶部的 ID 和凭据登录。登录有效期 14 天。",14));
        EditText host = input("服务器 HTTPS 地址",false); host.setText(server); root.addView(host);
        EditText id = input("聊天 ID",false); id.setInputType(InputType.TYPE_CLASS_NUMBER); id.setText(botId); root.addView(id);
        EditText credential = input("凭据",true); credential.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); root.addView(credential);
        TextView result = label("",14); root.addView(result);
        root.addView(button("登录", () -> {
            if (busy) return;
            String base = host.getText().toString().trim().replaceAll("/+$", ""), code = credential.getText().toString().trim(), identity = id.getText().toString().trim();
            try { URL url = new URL(base); if (!"https".equals(url.getProtocol()) || url.getUserInfo()!=null || !url.getPath().isEmpty() || url.getQuery()!=null || url.getRef()!=null) throw new Exception(); } catch(Exception e) { result.setText("请输入有效的 HTTPS 服务器地址"); return; }
            server = base; busy = true; result.setText("正在验证…");
            worker.execute(() -> {
                try {
                    JSONObject value = request("/mobile/login", json("botId", identity, "credential", code), false);
                    String access = value.getString("accessToken"); long expires = value.getLong("expiresAt");
                    sessions.save(json("server",server,"token",access,"botId",identity,"expiresAt",expires).toString());
                    runOnUiThread(() -> { busy=false; token=access; botId=identity; expiresAt=expires; address=value.optString("address", ""); getPreferences(0).edit().putString("address",address).apply(); credential.setText(""); navigate("owner",""); });
                } catch(Exception e) { runOnUiThread(() -> {busy=false; result.setText(e.getMessage());}); }
            });
        }));
    }
    private JSONObject request(String path, JSONObject data, boolean authenticated) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)new URL(server + path).openConnection();
        connection.setConnectTimeout(15000); connection.setReadTimeout(30000); connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setRequestProperty("Content-Type","application/json");
        if(authenticated) connection.setRequestProperty("Authorization","Bearer " + token);
        try {
            byte[] payload=data.toString().getBytes("UTF-8"); connection.setFixedLengthStreamingMode(payload.length);
            try(OutputStream out=connection.getOutputStream()){out.write(payload);}
            int code=connection.getResponseCode();
            InputStream stream=code>=400?connection.getErrorStream():connection.getInputStream();
            if(stream==null) throw new IOException("服务器响应无效（"+code+"）");
            ByteArrayOutputStream buffer=new ByteArrayOutputStream(); byte[] bytes=new byte[8192]; int n;
            try(InputStream in=stream){while((n=in.read(bytes))!=-1){buffer.write(bytes,0,n);if(buffer.size()>30*1024*1024)throw new IOException("内容过大，请分批查看");}}
            if(code==401 && authenticated) throw new LoginExpired();
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
                try{result.done(value);if(body.getChildCount()==0)body.addView(label("暂无内容",15));status.setText("星邮 · "+botId+" · 登录至 "+format(Instant.ofEpochMilli(expiresAt).toString()));}catch(Exception e){toast(e.getMessage());}
            }); } catch(Exception e){runOnUiThread(() -> {busy=false;if(e instanceof LoginExpired){expire();toast("登录已过期，请重新验证凭据");}else if(status!=null)status.setText(e.getMessage());});}
        });
    }
    private static class LoginExpired extends IOException {}
    private void navigate(String page,String id) {
        screen=page;target=id;before=null;attachment=null;
        root=column();root.setFitsSystemWindows(true);root.setBackgroundColor(Color.rgb(245,248,255));root.setPadding(dp(10),dp(14),dp(10),dp(6));setContentView(root);
        LinearLayout top=new LinearLayout(this);TextView title=label("星邮",23);top.addView(title,new LinearLayout.LayoutParams(0,-2,1));
        top.addView(button("返回",()->navigate("owner","")));
        top.addView(button("退出",()->{ if(!busy)async("logout",json(),v->expire()); }));root.addView(top);
        status=label("加载中…",11);root.addView(status);
        LinearLayout nav=new LinearLayout(this);String[] names={"我的 bot","会话","动态","广场","狼人杀"}, pages={"owner","chats","feed","square","games"};
        for(int i=0;i<names.length;i++){final String p=pages[i];Button b=button(names[i],()->navigate(p,""));b.setTextSize(11);b.setMinWidth(0);b.setPadding(0,0,0,0);nav.addView(b,new LinearLayout.LayoutParams(0,dp(48),1));}root.addView(nav);
        scroll=new ScrollView(this);body=column();scroll.addView(body);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        composer=column();if(page.equals("owner")){
            imageNote=label("图片未选择",11);composer.addView(imageNote);
            draft=input("发给本 ID 的 bot…",false);draft.setMaxLines(4);composer.addView(draft);
            LinearLayout bar=new LinearLayout(this);
            bar.addView(button("称呼",()->chooseAddress(null)));bar.addView(button("表情包",()->{Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT);pick.setType("image/*");pick.addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(pick,7);}));
            bar.addView(button("发送",this::sendOwner));composer.addView(bar);root.addView(composer);
        }
        refresh();
    }
    private void refresh(){
        if(busy||token.isEmpty())return;
        JSONObject cursor=before==null?json():json("before",before);
        switch(screen){
            case "owner":async("owner.history",cursor,v->{body.removeAllViews();pager(v);JSONArray messages=v.getJSONArray("messages");for(int i=0;i<messages.length();i++){JSONObject m=messages.getJSONObject(i);boolean human=m.optString("direction").equals("human");bubble(human?"我 · "+m.optString("address"):"Bot "+botId,m.optString("text"),m.optJSONObject("image"),m.optString("at"),human);}if(before==null)scroll.post(()->scroll.fullScroll(View.FOCUS_DOWN));});break;
            case "chats":case "feed":async("overview",json(),v->{overview=v;body.removeAllViews();if(screen.equals("chats")){JSONArray chats=v.getJSONArray("conversations");for(int i=0;i<chats.length();i++){JSONObject c=chats.getJSONObject(i);String id=c.getString("target"), kind=c.getString("kind");JSONObject latest=c.optJSONObject("latest");String title=kind.equals("group")?groupName(id):name(id);card((kind.equals("group")?"群聊 · ":"私聊 · ")+title,latest==null?"暂无消息":latest.optString("text"),()->{chatKind=kind;navigate("history",id);});}}else{JSONArray posts=v.getJSONArray("posts");for(int i=0;i<posts.length();i++){JSONObject p=posts.getJSONObject(i);card(name(p.getString("author")),p.optString("text")+(p.optBoolean("image")?" [图片]":""),()->navigate("post",p.optString("id")));}}});break;
            case "history":async("history",json("kind",chatKind,"target",target,"before",before==null?JSONObject.NULL:before),v->{body.removeAllViews();pager(v);JSONArray ms=v.getJSONArray("messages");for(int i=0;i<ms.length();i++){JSONObject m=ms.getJSONObject(i);bubble(m.optString("senderNickname",m.optString("sender")),m.optString("text")+m.optString("emoji"),m.optJSONObject("image"),m.optString("at"),botId.equals(m.optString("sender")));}});break;
            case "post":async("post",json("postId",target),v->{body.removeAllViews();JSONObject p=v.getJSONObject("post");body.addView(label(name(p.optString("author"))+" · "+format(p.optString("at")),13));body.addView(label(p.optString("text"),17));image(p.optJSONObject("image"),body);JSONArray comments=v.getJSONArray("comments");for(int i=0;i<comments.length();i++){JSONObject c=comments.getJSONObject(i);body.addView(label(name(c.optString("author"))+"："+c.optString("text"),14));}});break;
            case "square":async("square",json(),v->{body.removeAllViews();JSONArray items=v.getJSONArray("items");for(int i=0;i<items.length();i++){JSONObject item=items.getJSONObject(i);String kind=item.optString("kind");card(kind.equals("game")?"公开狼人杀":kind.equals("group")?"群宣传 · "+item.optString("groupName"):"Bot · "+item.optString("nickname",item.optString("author")),item.optString("text"),kind.equals("game")?()->navigate("game",item.optString("gameId",item.optString("id"))):null);}});break;
            case "games":async("games",json(),v->{body.removeAllViews();JSONArray items=v.getJSONArray("items");for(int i=0;i<items.length();i++){JSONObject game=items.getJSONObject(i);card(game.optString("title"),state(game.optString("status"))+" · "+format(game.optString("scheduledAt")),()->navigate("game",game.optString("gameId")));}});break;
            case "game":async("game",json("gameId",target,"before",before==null?JSONObject.NULL:before),v->{body.removeAllViews();JSONObject game=v.getJSONObject("game");body.addView(label(game.optString("title")+" · "+state(game.optString("status")),19));body.addView(label("全程只读 · 包含本局公共与私密过程",12));pager(v);JSONArray messages=v.getJSONArray("messages");for(int i=0;i<messages.length();i++){JSONObject m=messages.getJSONObject(i);bubble(channel(m.optString("channel"))+" · "+m.optString("senderNickname",m.optString("sender")),gameText(m),null,m.optString("at"),false);}});break;
        }
    }
    private void pager(JSONObject value){if(!value.isNull("nextBefore"))body.addView(button("更早的消息",()->{before=value.optLong("nextBefore");refresh();}));if(before!=null)body.addView(button("回到最新",()->{before=null;refresh();}));}
    private String name(String id){if(id.equals(botId))return overview.optJSONObject("profile")==null?"本机 bot":overview.optJSONObject("profile").optString("nickname",id);JSONArray ps=overview.optJSONArray("friendProfiles");if(ps!=null)for(int i=0;i<ps.length();i++){JSONObject p=ps.optJSONObject(i);if(p!=null&&id.equals(p.optString("botId")))return p.optString("nickname",id)+" ("+id+")";}return id;}
    private String groupName(String id){JSONArray gs=overview.optJSONArray("groups");if(gs!=null)for(int i=0;i<gs.length();i++){JSONObject g=gs.optJSONObject(i);if(g!=null&&id.equals(g.optString("id")))return g.optString("name",id);}return id;}
    private void card(String title,String subtitle,Runnable click){LinearLayout card=column();card.setPadding(dp(8),dp(8),dp(8),dp(10));card.addView(label(title,18));card.addView(label(subtitle,14));GradientDrawable bg=new GradientDrawable();bg.setColor(Color.WHITE);bg.setCornerRadius(dp(14));card.setBackground(bg);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.setMargins(0,dp(5),0,dp(5));body.addView(card,lp);if(click!=null)card.setOnClickListener(v->click.run());}
    private void bubble(String sender,String text,JSONObject pic,String at,boolean self){LinearLayout row=column();row.setGravity(self?Gravity.RIGHT:Gravity.LEFT);row.setPadding(dp(6),dp(6),dp(6),dp(10));TextView meta=label(sender+" · "+format(at),11);row.addView(meta);LinearLayout box=column();box.setPadding(dp(6),dp(3),dp(6),dp(3));GradientDrawable bg=new GradientDrawable();bg.setColor(self?Color.rgb(210,228,255):Color.WHITE);bg.setCornerRadius(dp(12));box.setBackground(bg);if(!text.isEmpty())box.addView(label(text,16));image(pic,box);row.addView(box,new LinearLayout.LayoutParams(dp(290),-2));body.addView(row);}
    private void image(JSONObject value,LinearLayout parent){if(value==null)return;try{byte[] bytes=Base64.decode(value.getString("base64"),Base64.DEFAULT);BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);options.inSampleSize=1;while(Math.max(options.outWidth,options.outHeight)/options.inSampleSize>640)options.inSampleSize*=2;options.inJustDecodeBounds=false;Bitmap bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);if(bitmap==null)return;ImageView view=new ImageView(this);view.setImageBitmap(bitmap);view.setAdjustViewBounds(true);view.setMaxHeight(dp(300));parent.addView(view,new LinearLayout.LayoutParams(-1,-2));}catch(Exception ignored){parent.addView(label("图片暂不可见",12));}}
    private void chooseAddress(Runnable after){if(busy)return;EditText field=input("桌宠对你的称呼，例如：主人",false);field.setText(address);new AlertDialog.Builder(this).setTitle("桌宠对你的称呼").setMessage("发送时由服务器附加身份前缀。").setView(field).setNegativeButton("取消",null).setPositiveButton("保存",(d,w)->{String wanted=field.getText().toString().trim();async("owner.address",json("address",wanted),v->{address=v.getString("address");getPreferences(0).edit().putString("address",address).apply();if(after!=null)after.run();});}).show();}
    private void sendOwner(){if(busy)return;if(address.isEmpty()){chooseAddress(this::sendOwner);return;}String words=draft.getText().toString().trim();if(words.isEmpty()&&attachment==null){toast("请输入文字或选择表情包");return;}async("owner.send",json("text",words,"image",attachment==null?JSONObject.NULL:attachment),v->{draft.setText("");attachment=null;imageNote.setText("图片未选择");before=null;refresh();});}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request!=7||result!=RESULT_OK||data==null)return;try(InputStream in=getContentResolver().openInputStream(data.getData())){if(in==null)throw new IOException();ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1){out.write(b,0,n);if(out.size()>1024*1024)throw new IOException("图片请小于 1 MiB");}byte[] bytes=out.toByteArray();String mime=getContentResolver().getType(data.getData());if(!"image/png".equals(mime)&&!"image/jpeg".equals(mime)&&!"image/gif".equals(mime)&&!"image/webp".equals(mime))throw new IOException("仅支持 PNG、JPEG、GIF、WebP");attachment=json("mime",mime,"base64",Base64.encodeToString(bytes,Base64.NO_WRAP));if(imageNote!=null)imageNote.setText("已选择表情包 · "+bytes.length/1024+" KiB");}catch(Exception e){toast(e.getMessage()==null?"无法读取图片":e.getMessage());}}
    private String format(String at){try{return DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.of("Asia/Shanghai")).format(Instant.parse(at));}catch(Exception e){return at;}}
    private String channel(String value){switch(value){case "private":return "私密";case "wolf":return "狼人";case "judge":return "法官";case "outside":return "局外讨论";default:return "公共";}}
    private String state(String value){switch(value){case "scheduled":return "预约中";case "assigning":return "分发身份";case "night_wolf":return "狼人行动";case "night_gods":return "神职行动";case "day":return "白天讨论";case "vote":return "公共投票";case "hunter":return "猎人行动";case "finished":return "复盘中";case "closed":return "已关闭";case "cancelled":return "已取消";default:return value;}}
    private String role(String value){switch(value){case "wolf":return "狼人";case "seer":return "预言家";case "witch":return "女巫";case "guard":return "守卫";case "hunter":return "猎人";case "villager":return "平民";default:return value;}}
    private String gameText(JSONObject m){String kind=m.optString("kind");switch(kind){case "chat":return m.optString("text");case "role":return "身份："+role(m.optString("role"))+"，狼人队友："+m.optJSONArray("teammates");case "assignments":case "finished":return (kind.equals("finished")?"游戏结束："+m.optString("winner"):"身份表")+"\n"+m.optJSONObject("roles");case "dawn":return "天亮了，出局："+m.optJSONArray("deaths");case "inspect_result":return "查验 "+m.optString("target")+"："+(m.optBoolean("isWolf")?"狼人":"非狼人");case "witch_prompt":return "狼刀："+m.optString("victim","无")+"，解药"+(m.optBoolean("saveAvailable")?"可用":"不可用")+"，毒药"+(m.optBoolean("poisonAvailable")?"可用":"不可用");case "vote":return m.optString("voter")+" 投票给 "+m.optString("target");case "vote_result":return "投票结果，出局："+m.optString("eliminated","无");case "attack_vote":return m.optString("botId")+" 选择袭击 "+m.optString("target");case "hunter_shot":return "猎人 "+m.optString("hunter")+" 开枪："+m.optString("target","放弃");case "started":return "游戏开始\n"+m.optJSONObject("rules");case "vote_open":return "公共投票开始";case "hunter_prompt":case "hunter_wait":return "等待猎人行动";default:return "第 "+m.optInt("day")+" 天 · "+state(kind);}}
}
