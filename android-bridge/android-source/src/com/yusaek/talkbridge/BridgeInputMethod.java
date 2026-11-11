package com.yusaek.talkbridge;
import android.inputmethodservice.InputMethodService;
import android.view.inputmethod.InputConnection;
public final class BridgeInputMethod extends InputMethodService {
    static BridgeInputMethod active;
    @Override public void onCreate(){super.onCreate();active=this;}
    @Override public void onDestroy(){active=null;super.onDestroy();}
    static boolean ready(){return active!=null&&active.getCurrentInputConnection()!=null;}
    static boolean input(String value){InputConnection c=active==null?null:active.getCurrentInputConnection();if(c==null)return false;c.performContextMenuAction(android.R.id.selectAll);return c.commitText(value,1);}
}
