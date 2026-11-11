package com.yusaek.talkbridge;
import android.app.Notification;
import android.content.*;
import android.net.*;
import android.net.wifi.WifiManager;
import android.os.*;
import android.service.notification.*;
import org.json.*;
import java.io.File;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class TalkNotifications extends NotificationListenerService {
    private static final Object LOCK=new Object();
    private static final java.util.concurrent.ExecutorService NET=Executors.newSingleThreadExecutor();
    private static final java.util.concurrent.ExecutorService CAPTURE=Executors.newSingleThreadExecutor();
    private static final AtomicBoolean FLUSH_QUEUED=new AtomicBoolean();
    private final Handler timer=new Handler(Looper.getMainLooper());
    private ConnectivityManager.NetworkCallback network;
    private PowerManager.WakeLock cpu;
    private WifiManager.WifiLock wifi;
    private boolean connected;
    static String hash(String value)throws Exception{byte[] d=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));StringBuilder out=new StringBuilder();for(byte b:d)out.append(String.format("%02x",b&255));return out.toString();}
    private static NotificationJournal journal(Context context,String account)throws Exception{
        if(!account.matches("[a-f0-9]{64}"))throw new Exception("account_invalid");
        return new NotificationJournal(new File(context.getFilesDir(),"notification-outbox/"+account));
    }
    // Pending IDs are also in legacy seen. Import pending first, never discard it.
    static void migrateLegacy(Context context,SharedPreferences p)throws Exception{
        synchronized(LOCK){
            String account=p.getString("account","");if(account.isEmpty())return;
            if(!p.contains("queue")&&!p.contains("seen"))return;
            NotificationJournal q=journal(context,account);JSONArray pending=new JSONArray(p.getString("queue","[]")),seen=new JSONArray(p.getString("seen","[]"));
            for(int i=0;i<pending.length();i++){JSONObject message=pending.getJSONObject(i);q.enqueue(message.getString("event_id"),message.toString());}
            for(int i=0;i<seen.length();i++)q.markSeen(seen.getString(i));
            if(!p.edit().remove("queue").remove("seen").commit())throw new Exception("outbox_migration_failed");
        }
    }
    private void retainCpuAndWifi(){
        if(cpu==null){cpu=getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"YusaekTalk:NotificationDelivery");cpu.setReferenceCounted(false);}
        cpu.acquire(120000); // CPU stays ready while the screen stays locked.
        if(wifi==null){WifiManager manager=(WifiManager)getApplicationContext().getSystemService(Context.WIFI_SERVICE);if(manager!=null){wifi=manager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF,"YusaekTalk:NotificationWifi");wifi.setReferenceCounted(false);}}
        if(wifi!=null&&!wifi.isHeld())wifi.acquire();
    }
    private void releaseLocks(){if(cpu!=null&&cpu.isHeld())cpu.release();if(wifi!=null&&wifi.isHeld())wifi.release();}
    private final Runnable tick=new Runnable(){@Override public void run(){
        if(!connected)return;
        try{retainCpuAndWifi();StatusBarNotification[] active=getActiveNotifications();if(active!=null)for(StatusBarNotification n:active)capture(n);hello(TalkNotifications.this);}catch(Exception e){getSharedPreferences("talk",MODE_PRIVATE).edit().putString("status","알림 연결 유지 확인 필요").apply();}
        timer.postDelayed(this,30000);
    }};
    private final Runnable retry=new Runnable(){@Override public void run(){if(connected){flush(TalkNotifications.this);timer.postDelayed(this,5000);}}};
    static void hello(Context source){Context context=source.getApplicationContext();NET.execute(()->{
        SharedPreferences p=context.getSharedPreferences("talk",MODE_PRIVATE);HttpURLConnection connection=null;
        try{
            String server=p.getString("server",""),token=p.getString("token",""),account=p.getString("account","");if(server.isEmpty()||token.isEmpty())return;
            migrateLegacy(context,p);String listeners=android.provider.Settings.Secure.getString(context.getContentResolver(),"enabled_notification_listeners");
            JSONObject status=new JSONObject().put("account",account).put("version",5).put("notification_access",listeners!=null&&listeners.contains("com.yusaek.talkbridge/"))
                .put("last_delivery_at",p.getLong("last_delivery_at",0)).put("delivery_error",p.getString("delivery_error",""));
            synchronized(LOCK){status.put("pending_notifications",journal(context,account).batch(1001).size());}
            connection=open(server+"/api/talk/device/hello",token);post(connection,status);
            if(connection.getResponseCode()!=200)p.edit().putString("status","알림 서버 연결 확인 필요").apply();
        }catch(Exception e){p.edit().putString("status","알림 연결 재시도 중 · 휴대폰 원본 보관").apply();}finally{if(connection!=null)connection.disconnect();}
        flush(context);
    });}
    private static HttpURLConnection open(String url,String token)throws Exception{
        HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(5000);c.setReadTimeout(7000);c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");c.setRequestProperty("X-Talk-Device-Token",token);return c;
    }
    private static void post(HttpURLConnection c,JSONObject value)throws Exception{
        byte[] bytes=value.toString().getBytes(StandardCharsets.UTF_8);c.setFixedLengthStreamingMode(bytes.length);try(java.io.OutputStream out=c.getOutputStream()){out.write(bytes);}
    }
    @Override public void onListenerConnected(){
        super.onListenerConnected();connected=true;
        // Replay active notifications after disconnect; durable IDs prevent duplicates.
        try{StatusBarNotification[] active=getActiveNotifications();if(active!=null)for(StatusBarNotification n:active)capture(n);}catch(Exception ignored){}
        if(network==null){network=new ConnectivityManager.NetworkCallback(){@Override public void onAvailable(Network n){hello(getApplicationContext());}};getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(network);}
        timer.removeCallbacks(tick);timer.removeCallbacks(retry);timer.post(tick);timer.postDelayed(retry,5000);
    }
    @Override public void onListenerDisconnected(){
        super.onListenerDisconnected();connected=false;timer.removeCallbacks(tick);timer.removeCallbacks(retry);releaseLocks();requestRebind(new ComponentName(this,TalkNotifications.class));
    }
    @Override public void onDestroy(){connected=false;timer.removeCallbacksAndMessages(null);releaseLocks();if(network!=null)try{getSystemService(ConnectivityManager.class).unregisterNetworkCallback(network);}catch(Exception ignored){}super.onDestroy();}
    @Override public void onNotificationPosted(StatusBarNotification n){capture(n);flush(this);}
    private void capture(StatusBarNotification sbn){
        if(!"com.kakao.talk".equals(sbn.getPackageName())||(sbn.getNotification().flags&Notification.FLAG_GROUP_SUMMARY)!=0)return;
        CAPTURE.execute(()->{persist(sbn);flush(this);});
    }
    private void persist(StatusBarNotification sbn){
        synchronized(LOCK){try{
            SharedPreferences p=getSharedPreferences("talk",MODE_PRIVATE);String account=p.getString("account","");if(account.isEmpty())return;
            migrateLegacy(this,p);NotificationJournal q=journal(this,account);
            Notification n=sbn.getNotification();Parcelable[] bundles=n.extras.getParcelableArray(Notification.EXTRA_MESSAGES);
            List<Notification.MessagingStyle.Message> messages=bundles==null?Collections.emptyList():Notification.MessagingStyle.Message.getMessagesFromBundleArray(bundles);
            CharSequence conversation=n.extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE);
            String title=conversation!=null?conversation.toString():String.valueOf(n.extras.getCharSequence(Notification.EXTRA_TITLE,""));
            boolean group=n.extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION,false);
            if(messages.isEmpty()){
                String id=hash(account+"|uncertain|"+sbn.getKey()+"|"+sbn.getPostTime());
                CharSequence fallback=n.extras.getCharSequence(Notification.EXTRA_BIG_TEXT,n.extras.getCharSequence(Notification.EXTRA_TEXT,""));
                q.enqueue(id,new JSONObject().put("event_id",id).put("title",title).put("text",String.valueOf(fallback)).put("reliable",false).put("notification_key",sbn.getKey()).put("is_group_conversation",group).toString());
            }else{
                Map<String,Integer> occurrences=new HashMap<>();
                for(Notification.MessagingStyle.Message message:messages){
                    String sender=message.getSenderPerson()==null?"":String.valueOf(message.getSenderPerson().getName()),text=String.valueOf(message.getText());
                    String key=message.getTimestamp()+"|"+sender+"|"+text;int occurrence=occurrences.merge(key,1,Integer::sum);
                    String id=hash(account+"|"+title+"|"+key+(occurrence==1?"":"|"+occurrence));
                    q.enqueue(id,new JSONObject().put("event_id",id).put("title",title).put("sender",sender).put("text",text).put("timestamp",Instant.ofEpochMilli(message.getTimestamp()).toString()).put("reliable",message.getTimestamp()>0&&!sender.isEmpty()).put("notification_key",sbn.getKey()).put("is_group_conversation",group).toString());
                }
            }
        }catch(Exception e){getSharedPreferences("talk",MODE_PRIVATE).edit().putString("status","알림 저장 확인 필요 · TXT 원본 확인 필요").apply();}}
    }
    static void enqueueLive(Context source,String roomName,JSONArray messages){
        Context context=source.getApplicationContext();SharedPreferences p=context.getSharedPreferences("talk",MODE_PRIVATE);
        try{synchronized(LOCK){
            String account=p.getString("account","");if(account.isEmpty())return;
            migrateLegacy(context,p);
            for(int start=0;start<messages.length();start+=50){
                JSONArray page=new JSONArray();for(int i=start;i<Math.min(start+50,messages.length());i++)page.put(messages.get(i));
                String id=hash(account+"|live|"+roomName+"|"+page.toString());
                journal(context,account).enqueue(id,new JSONObject().put("event_id",id).put("_kind","live_scan").put("room_name",roomName).put("messages",page).put("observed_at",Instant.now().toString()).toString());
            }
        }flush(context);}catch(Exception e){p.edit().putString("status","받은 답장 저장 확인 필요 · TXT 원본 확인 필요").apply();}
    }
    static void flush(Context source){
        Context context=source.getApplicationContext();if(!FLUSH_QUEUED.compareAndSet(false,true))return;
        NET.execute(()->{SharedPreferences p=context.getSharedPreferences("talk",MODE_PRIVATE);
            try{
                String server=p.getString("server",""),token=p.getString("token",""),account=p.getString("account","");if(server.isEmpty()||token.isEmpty())return;
                migrateLegacy(context,p);
                for(int round=0;round<20;round++){
                    List<NotificationJournal.Entry> batch;synchronized(LOCK){batch=journal(context,account).batch(50);}if(batch.isEmpty())return;
                    boolean live="live_scan".equals(new JSONObject(batch.get(0).body).optString("_kind"));
                    JSONArray messages=new JSONArray();List<String> ids=new ArrayList<>();JSONObject payload=new JSONObject().put("account",account);
                    if(live){JSONObject snapshot=new JSONObject(batch.get(0).body);payload.put("room_name",snapshot.getString("room_name")).put("messages",snapshot.getJSONArray("messages")).put("observed_at",snapshot.optString("observed_at"));ids.add(batch.get(0).id);}
                    else{for(NotificationJournal.Entry e:batch){JSONObject message=new JSONObject(e.body);if("live_scan".equals(message.optString("_kind")))break;messages.put(message);ids.add(e.id);}payload.put("messages",messages);}
                    HttpURLConnection connection=null;
                    try{
                        connection=open(server+(live?"/api/talk/live-scan":"/api/talk/notifications"),token);post(connection,payload);
                        int code=connection.getResponseCode();if(code!=200)throw new java.io.IOException("http_"+code);
                        java.io.ByteArrayOutputStream reply=new java.io.ByteArrayOutputStream();
                        try(java.io.InputStream in=connection.getInputStream()){byte[] buffer=new byte[4096];int count;while((count=in.read(buffer))!=-1){if(reply.size()+count>65536)throw new java.io.IOException("ack_too_large");reply.write(buffer,0,count);}}
                        JSONObject ack=new JSONObject(new String(reply.toByteArray(),StandardCharsets.UTF_8));
                        if(!ack.optBoolean("ok")||(!live&&(ack.optJSONArray("results")==null||ack.getJSONArray("results").length()!=ids.size()))||(live&&!ack.has("inserted")))throw new java.io.IOException("ack_invalid");
                        synchronized(LOCK){journal(context,account).acknowledge(ids);}
                        p.edit().putLong("last_delivery_at",System.currentTimeMillis()).putString("delivery_error","").putString("status","알림 전달 정상").apply();
                    }finally{if(connection!=null)connection.disconnect();}
                }
            }catch(Exception e){p.edit().putString("delivery_error",e instanceof java.io.IOException?"network_or_server":"delivery_failed").putString("status","알림 재전송 대기 · 휴대폰 원본 보관").apply();}
            finally{FLUSH_QUEUED.set(false);}
        });
    }
}
