package com.yusaek.talkbridge;
import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.widget.*;
import java.net.URI;
public final class MainActivity extends Activity {
    @Override public void onCreate(Bundle b){
        super.onCreate(b);SharedPreferences p=getSharedPreferences("talk",MODE_PRIVATE);
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(28,50,28,28);setContentView(root);
        TextView title=new TextView(this);title.setText("YUSAEK TALK · 알림 연결\n이 앱은 알림 수집과 ADB 한글 입력만 담당합니다.");root.addView(title);
        EditText server=field(root,"메인 PC 주소 (http://192.168.x.x:8787)",p.getString("server",""),false);
        EditText token=field(root,"웹에서 발급한 등록키",p.getString("token",""),true);
        EditText account=field(root,"웹에서 확인한 계정 해시",p.getString("account",""),false);
        TextView status=new TextView(this);root.addView(status);
        Button save=new Button(this);save.setText("설정 저장 · 대기 알림 전송");root.addView(save);
        save.setOnClickListener(v->{try{
            String address=server.getText().toString().trim();URI u=new URI(address);
            String host=u.getHost();if(!"http".equals(u.getScheme())||host==null||!privateHost(host)||u.getUserInfo()!=null||u.getQuery()!=null||u.getFragment()!=null||!(u.getPath().isEmpty()||"/".equals(u.getPath())))throw new Exception();
            if(!token.getText().toString().matches("[a-f0-9]{64}")||!account.getText().toString().matches("[a-f0-9]{64}"))throw new Exception();
            TalkNotifications.migrateLegacy(this,p);
            String nextAccount=account.getText().toString();
            p.edit().putString("server",address.replaceAll("/+$","")).putString("token",token.getText().toString()).putString("account",nextAccount).apply();TalkNotifications.flush(getApplicationContext());status.setText("설정 저장됨. 아래에서 알림 접근을 허용해주세요.");
        }catch(Exception e){status.setText("LAN 서버 주소와 64자리 등록키/계정 해시를 확인해주세요.");}});
        Button access=new Button(this);access.setText("알림 접근 허용 설정 열기");root.addView(access);access.setOnClickListener(v->startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        Button fastProbe=new Button(this);fastProbe.setText("화면 속도 시험 권한 설정 (직접 허용)");root.addView(fastProbe);
        fastProbe.setOnClickListener(v->startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        status.setText(p.getString("status","알림 권한을 허용하면 새 알림부터 수집합니다. 이전 알림은 새 응답으로 계산하지 않습니다."));
    }
    static boolean privateHost(String host){return host.matches("10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")||host.matches("192\\.168\\.\\d{1,3}\\.\\d{1,3}")||host.matches("172\\.(1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}")||host.endsWith(".local");}
    private EditText field(LinearLayout root,String hint,String value,boolean secret){EditText e=new EditText(this);e.setHint(hint);e.setSingleLine(true);e.setText(value);if(secret)e.setInputType(129);root.addView(e);return e;}
}
