package com.yusaek.talkbridge;
import android.content.*;
import android.util.Base64;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
public final class ConfigReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context,Intent intent){
    try {
      if("com.yusaek.talkbridge.HELLO".equals(intent.getAction())){TalkNotifications.hello(context);setResultCode(1);return;}
      if(!"com.yusaek.talkbridge.CONFIGURE".equals(intent.getAction())){setResultCode(0);return;}
      String encoded=intent.getStringExtra("config");if(encoded==null||encoded.length()>12000)throw new Exception();
      JSONObject data=new JSONObject(new String(Base64.decode(encoded,Base64.DEFAULT),StandardCharsets.UTF_8));
      String server=data.getString("server"),token=data.getString("token"),account=data.getString("account");URI uri=new URI(server);
      if(!"http".equals(uri.getScheme())||uri.getHost()==null||!MainActivity.privateHost(uri.getHost())||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||!(uri.getPath().isEmpty()||"/".equals(uri.getPath()))||!token.matches("[a-f0-9]{64}")||!account.matches("[a-f0-9]{64}"))throw new Exception();
      SharedPreferences p=context.getSharedPreferences("talk",Context.MODE_PRIVATE);SharedPreferences.Editor edit=p.edit();
      TalkNotifications.migrateLegacy(context,p);
      if(!edit.putString("server",server.replaceAll("/+$","")).putString("token",token).putString("account",account).putString("status","웹에서 자동 등록됨").commit())throw new Exception();
      setResultCode(1);
    }catch(Exception ignored){setResultCode(0);}
  }
}
