package com.yusaek.talkbridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

/** adb-shell-only trigger for the on-device read-only probe and send executor. */
public final class FastProbeReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if ("com.yusaek.talkbridge.FAST_PROBE".equals(action)) {
            try { setResultData(FastProbeAccessibilityService.probe().toString()); setResultCode(1); }
            catch (Exception ignored) { setResultCode(0); }
            return;
        }
        if (!"com.yusaek.talkbridge.SEND".equals(action)) { setResultCode(0); return; }
        // The send sequence waits on Kakao screen transitions; run it off the
        // main thread and keep the ordered-broadcast result pending until done.
        String encoded = intent.getStringExtra("payload");
        final PendingResult pending = goAsync();
        new Thread(() -> {
            JSONObject out;
            try {
                if (encoded == null || encoded.length() > 60000) throw new Exception();
                JSONObject payload = new JSONObject(new String(Base64.decode(encoded, Base64.DEFAULT), StandardCharsets.UTF_8));
                out = FastProbeAccessibilityService.run(payload);
            } catch (Exception e) {
                out = new JSONObject();
                try { out.put("state", "failed").put("error", "payload_invalid"); } catch (Exception ignored) {}
            }
            // Result is base64 so `am broadcast` prints one unambiguous token.
            String data = Base64.encodeToString(out.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            String state = out.optString("state", "");
            pending.setResultData(data);
            pending.setResultCode("verified".equals(state) ? 1 : 0);
            pending.finish();
        }).start();
    }
}
