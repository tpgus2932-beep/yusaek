package com.yusaek.talkbridge;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
public final class InputReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context,Intent intent){
        if("com.yusaek.talkbridge.INPUT_READY".equals(intent.getAction())){setResultCode(BridgeInputMethod.ready()?1:0);return;}
        if(!"com.yusaek.talkbridge.INPUT_B64".equals(intent.getAction()))return;
        try{String input=intent.getStringExtra("msg");if(input==null||input.length()>60000){setResultCode(0);return;}boolean done=BridgeInputMethod.input(new String(Base64.decode(input,Base64.DEFAULT),StandardCharsets.UTF_8));setResultCode(done?1:0);}catch(Exception ignored){setResultCode(0);}
    }
}
