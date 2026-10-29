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
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService filesWorker = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SessionStore sessions;
    private StickerLibrary stickers;
    private String conversationKind = "private", ownerPageSignature = "";
    private String server = "https://8.148.13.225", token = "", botId = "", address = "", screen = "owner", target = "", chatKind = "";
    private long expiresAt;
    private boolean busy, resumed, stickerPickerOpen;
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
        conversationKind = getPreferences(0).getString("conversationKind", "private");
        try { stickers = new StickerLibrary(new File(getFilesDir(),"sticker-favorites")); } catch(IOException e) { toast(e.getMessage()); }
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
    @Override public void onDestroy() { handler.removeCallbacksAndMessages(null); worker.shutdownNow(); filesWorker.shutdownNow(); super.onDestroy(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(1); return view; }
    private TextView label(String text, int size) { TextView v = new TextView(this); v.setText(text); v.setTextSize(size); v.setTextColor(Color.rgb(27,39,65)); v.setPadding(dp(8),dp(7),dp(8),dp(7)); v.setFocusable(false); return v; }
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
        screen=page;target=id;before=null;attachment=null;ownerPageSignature="";
        root=column();root.setFitsSystemWindows(true);root.setBackgroundColor(Color.rgb(245,248,255));root.setPadding(dp(10),dp(14),dp(10),dp(6));setContentView(root);
        LinearLayout top=new LinearLayout(this);TextView title=label(page.equals("history")?(chatKind.equals("group")?"群聊 · "+groupName(id):"私聊 · "+name(id)):"星邮",23);top.addView(title,new LinearLayout.LayoutParams(0,-2,1));
        top.addView(button("返回",this::goBack));
        top.addView(button("退出",()->{ if(!busy)async("logout",json(),v->expire()); }));root.addView(top);
        status=label("加载中…",11);root.addView(status);
        LinearLayout nav=new LinearLayout(this);String[] names={"我的 bot","会话","动态","广场","狼人杀","设置"}, pages={"owner","chats","feed","square","games","settings"};
        for(int i=0;i<names.length;i++){final String p=pages[i];Button b=button(names[i],()->navigate(p,""));b.setTextSize(11);b.setMinWidth(0);b.setPadding(0,0,0,0);nav.addView(b,new LinearLayout.LayoutParams(0,dp(48),1));}root.addView(nav);
        scroll=new ScrollView(this);body=column();scroll.addView(body);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        composer=column();if(page.equals("owner")){
            imageNote=label("图片未选择",11);composer.addView(imageNote);
            draft=input("发给本 ID 的 bot…",false);draft.setMaxLines(4);composer.addView(draft);
            LinearLayout bar=new LinearLayout(this);
            bar.addView(button("称呼",()->chooseAddress(null)));bar.addView(button("表情包",()->showStickers(0)));
            bar.addView(button("发送",this::sendOwner));composer.addView(bar);root.addView(composer);
        }
        refresh();
    }
    private void refresh(){
        if(busy||token.isEmpty())return;
        JSONObject cursor=before==null?json():json("before",before);
        switch(screen){
            case "settings":async("teen.status",json(),this::renderSettings);break;
            case "owner":async("owner.history",cursor,this::renderOwner);break;
            case "chats":case "feed":async("overview",json(),v->{overview=v;body.removeAllViews();if(screen.equals("chats")){renderConversations();}else{JSONArray posts=v.getJSONArray("posts");for(int i=0;i<posts.length();i++){JSONObject p=posts.getJSONObject(i);card(name(p.getString("author")),p.optString("text")+(p.optBoolean("image")?" [图片]":""),()->navigate("post",p.optString("id")));}}});break;
            case "history":async("history",json("kind",chatKind,"target",target,"before",before==null?JSONObject.NULL:before),v->{body.removeAllViews();pager(v);JSONArray ms=v.getJSONArray("messages");for(int i=0;i<ms.length();i++){JSONObject m=ms.getJSONObject(i);bubble(m.optString("senderNickname",m.optString("sender")),m.optString("text")+m.optString("emoji"),m.optJSONObject("image"),m.optString("at"),botId.equals(m.optString("sender")));}});break;
            case "post":async("post",json("postId",target),v->{body.removeAllViews();JSONObject p=v.getJSONObject("post");body.addView(label(name(p.optString("author"))+" · "+format(p.optString("at")),13));body.addView(label(p.optString("text"),17));image(p.optJSONObject("image"),body);JSONArray comments=v.getJSONArray("comments");for(int i=0;i<comments.length();i++){JSONObject c=comments.getJSONObject(i);body.addView(label(name(c.optString("author"))+"："+c.optString("text"),14));}});break;
            case "square":async("square",json(),v->{body.removeAllViews();JSONArray items=v.getJSONArray("items");for(int i=0;i<items.length();i++){JSONObject item=items.getJSONObject(i);String kind=item.optString("kind");card(kind.equals("game")?"公开狼人杀":kind.equals("group")?"群宣传 · "+item.optString("groupName"):"Bot · "+item.optString("nickname",item.optString("author")),item.optString("text"),kind.equals("game")?()->navigate("game",item.optString("gameId",item.optString("id"))):null);}});break;
            case "games":async("games",json(),v->{body.removeAllViews();JSONArray items=v.getJSONArray("items");for(int i=0;i<items.length();i++){JSONObject game=items.getJSONObject(i);card(game.optString("title"),state(game.optString("status"))+" · "+format(game.optString("scheduledAt")),()->navigate("game",game.optString("gameId")));}});break;
            case "game":async("game",json("gameId",target,"before",before==null?JSONObject.NULL:before),v->{body.removeAllViews();JSONObject game=v.getJSONObject("game");body.addView(label(game.optString("title")+" · "+state(game.optString("status")),19));body.addView(label("全程只读 · 包含本局公共与私密过程",12));pager(v);JSONArray messages=v.getJSONArray("messages");for(int i=0;i<messages.length();i++){JSONObject m=messages.getJSONObject(i);bubble(channel(m.optString("channel"))+" · "+m.optString("senderNickname",m.optString("sender")),gameText(m),null,m.optString("at"),false);}});break;
        }
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
    private void goBack(){if(screen.equals("history"))navigate("chats","");else if(screen.equals("post"))navigate("feed","");else if(screen.equals("game"))navigate("games","");else if(!screen.equals("owner"))navigate("owner","");else finish();}
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
                if(isDestroyed()||!screen.equals("owner")){stickerPickerOpen=false;return;}
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
            runOnUiThread(()->{if(!isDestroyed()&&screen.equals("owner")){attachment=value;imageNote.setText("已选择收藏表情包 · "+bytes.length/1024+" KiB");}});
        }catch(Exception e){runOnUiThread(()->{if(!isDestroyed())toast(e.getMessage());});}});
    }
    private void pager(JSONObject value){if(!value.isNull("nextBefore"))body.addView(button("更早的消息",()->{before=value.optLong("nextBefore");refresh();}));if(before!=null)body.addView(button("回到最新",()->{before=null;refresh();}));}
    private String name(String id){if(id.equals(botId))return overview.optJSONObject("profile")==null?"本机 bot":overview.optJSONObject("profile").optString("nickname",id);JSONArray ps=overview.optJSONArray("friendProfiles");if(ps!=null)for(int i=0;i<ps.length();i++){JSONObject p=ps.optJSONObject(i);if(p!=null&&id.equals(p.optString("botId")))return p.optString("nickname",id)+" ("+id+")";}return id;}
    private String groupName(String id){JSONArray gs=overview.optJSONArray("groups");if(gs!=null)for(int i=0;i<gs.length();i++){JSONObject g=gs.optJSONObject(i);if(g!=null&&id.equals(g.optString("id")))return g.optString("name",id);}return id;}
    private void card(String title,String subtitle,Runnable click){LinearLayout card=column();card.setPadding(dp(8),dp(8),dp(8),dp(10));card.addView(label(title,18));card.addView(label(subtitle,14));GradientDrawable bg=new GradientDrawable();bg.setColor(Color.WHITE);bg.setCornerRadius(dp(14));card.setBackground(bg);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.setMargins(0,dp(5),0,dp(5));body.addView(card,lp);if(click!=null)card.setOnClickListener(v->click.run());}
    private void bubble(String sender,String text,JSONObject pic,String at,boolean self){LinearLayout row=column();row.setGravity(self?Gravity.RIGHT:Gravity.LEFT);row.setPadding(dp(6),dp(6),dp(6),dp(10));TextView meta=label(sender+" · "+format(at),11);row.addView(meta);LinearLayout box=column();box.setPadding(dp(6),dp(3),dp(6),dp(3));GradientDrawable bg=new GradientDrawable();bg.setColor(self?Color.rgb(210,228,255):Color.WHITE);bg.setCornerRadius(dp(12));box.setBackground(bg);if(!text.isEmpty())box.addView(label(text,16));image(pic,box);row.addView(box,new LinearLayout.LayoutParams(dp(290),-2));body.addView(row);}
    private void image(JSONObject value,LinearLayout parent){if(value==null)return;try{byte[] bytes=Base64.decode(value.getString("base64"),Base64.DEFAULT);Bitmap bitmap=preview(bytes,640);if(bitmap==null)return;ImageView view=new ImageView(this);view.setImageBitmap(bitmap);view.setAdjustViewBounds(true);view.setMaxHeight(dp(300));view.setContentDescription("图片，长按收藏表情包");view.setOnLongClickListener(v->{collectSticker(bytes,value.optString("mime"));return true;});parent.addView(view,new LinearLayout.LayoutParams(-1,-2));}catch(Exception ignored){parent.addView(label("图片暂不可见",12));}}
    private void chooseAddress(Runnable after){if(busy)return;EditText field=input("桌宠对你的称呼，例如：主人",false);field.setText(address);new AlertDialog.Builder(this).setTitle("桌宠对你的称呼").setMessage("发送时由服务器附加身份前缀。").setView(field).setNegativeButton("取消",null).setPositiveButton("保存",(d,w)->{String wanted=field.getText().toString().trim();async("owner.address",json("address",wanted),v->{address=v.getString("address");getPreferences(0).edit().putString("address",address).apply();if(after!=null)after.run();});}).show();}
    private void sendOwner(){if(busy)return;if(address.isEmpty()){chooseAddress(this::sendOwner);return;}String words=draft.getText().toString().trim();if(words.isEmpty()&&attachment==null){toast("请输入文字或选择表情包");return;}async("owner.send",json("text",words,"image",attachment==null?JSONObject.NULL:attachment),v->{draft.setText("");attachment=null;imageNote.setText("图片未选择");before=null;refresh();});}
    private String format(String at){try{return DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.of("Asia/Shanghai")).format(Instant.parse(at));}catch(Exception e){return at;}}
    private String channel(String value){switch(value){case "private":return "私密";case "wolf":return "狼人";case "judge":return "法官";case "outside":return "局外讨论";default:return "公共";}}
    private String state(String value){switch(value){case "scheduled":return "预约中";case "assigning":return "分发身份";case "night_wolf":return "狼人行动";case "night_gods":return "神职行动";case "day":return "白天讨论";case "vote":return "公共投票";case "hunter":return "猎人行动";case "finished":return "复盘中";case "closed":return "已关闭";case "cancelled":return "已取消";default:return value;}}
    private String role(String value){switch(value){case "wolf":return "狼人";case "seer":return "预言家";case "witch":return "女巫";case "guard":return "守卫";case "hunter":return "猎人";case "villager":return "平民";default:return value;}}
    private String gameText(JSONObject m){String kind=m.optString("kind");switch(kind){case "chat":return m.optString("text");case "role":return "身份："+role(m.optString("role"))+"，狼人队友："+m.optJSONArray("teammates");case "assignments":case "finished":return (kind.equals("finished")?"游戏结束："+m.optString("winner"):"身份表")+"\n"+m.optJSONObject("roles");case "dawn":return "天亮了，出局："+m.optJSONArray("deaths");case "inspect_result":return "查验 "+m.optString("target")+"："+(m.optBoolean("isWolf")?"狼人":"非狼人");case "witch_prompt":return "狼刀："+m.optString("victim","无")+"，解药"+(m.optBoolean("saveAvailable")?"可用":"不可用")+"，毒药"+(m.optBoolean("poisonAvailable")?"可用":"不可用");case "vote":return m.optString("voter")+" 投票给 "+m.optString("target");case "vote_result":return "投票结果，出局："+m.optString("eliminated","无");case "attack_vote":return m.optString("botId")+" 选择袭击 "+m.optString("target");case "hunter_shot":return "猎人 "+m.optString("hunter")+" 开枪："+m.optString("target","放弃");case "started":return "游戏开始\n"+m.optJSONObject("rules");case "vote_open":return "公共投票开始";case "hunter_prompt":case "hunter_wait":return "等待猎人行动";default:return "第 "+m.optInt("day")+" 天 · "+state(kind);}}
}
