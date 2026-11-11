package com.yusaek.talkbridge;

import android.app.Activity;
import android.content.Intent;
import android.content.ClipData;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import org.json.JSONArray;
import org.json.JSONObject;

/** adb-shell-only entry that hands one or several staged files to KakaoTalk's share sheet.
 *  extras: "item" = base64(JSON object) for one file, or "items" = base64(JSON array) for up to MAX files.
 *  Each item {id,name,mime,bytes,sha256} must already be at outgoing/<id>/data and match its hash. */
public final class ShareActivity extends Activity {
  private static final int MAX_ITEMS = 20;

  private static String hex(byte[] digest){StringBuilder out=new StringBuilder();for(byte b:digest)out.append(String.format("%02x",b&255));return out.toString();}

  @Override public void onCreate(Bundle state){super.onCreate(state);
    try{
      String rawItems=getIntent().getStringExtra("items"),rawOne=getIntent().getStringExtra("item");
      JSONArray items;
      if(rawItems!=null){
        if(rawItems.length()>24000)throw new Exception();
        items=new JSONArray(new String(Base64.decode(rawItems,Base64.DEFAULT),StandardCharsets.UTF_8));
      }else{
        if(rawOne==null||rawOne.length()>4096)throw new Exception();
        items=new JSONArray().put(new JSONObject(new String(Base64.decode(rawOne,Base64.DEFAULT),StandardCharsets.UTF_8)));
      }
      if(items.length()<1||items.length()>MAX_ITEMS)throw new Exception();
      ArrayList<Uri> uris=new ArrayList<>();
      String commonMime=null;boolean allImages=true;
      for(int i=0;i<items.length();i++){
        JSONObject item=items.getJSONObject(i);
        String id=item.getString("id"),name=item.getString("name"),mime=item.getString("mime"),expected=item.getString("sha256");
        if(!id.matches("[a-f0-9-]{36}")||name.length()>180||name.matches("(?s).*[\\\\/\\p{Cntrl}].*")||!expected.matches("[a-f0-9]{64}")||!mime.matches("image/(jpeg|png|webp|gif)|application/(pdf|zip|vnd\\.ms-excel|vnd\\.openxmlformats-officedocument\\.(spreadsheetml\\.sheet|wordprocessingml\\.document))|text/(plain|csv)"))throw new Exception();
        File directory=new File(getExternalFilesDir(null),"outgoing/"+id),file=new File(directory,"data");
        if(!file.isFile()||file.length()<1||file.length()>20L*1024*1024||file.length()!=item.getLong("bytes"))throw new Exception();
        if(!expected.equals(hex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file.toPath())))))throw new Exception();
        Files.write(new File(directory,"metadata.json").toPath(),item.toString().getBytes(StandardCharsets.UTF_8));
        uris.add(Uri.parse("content://com.yusaek.talkbridge.media/"+id));
        if(commonMime==null)commonMime=mime;else if(!commonMime.equals(mime))commonMime=null==commonMime?mime:"*/*";
        if(!mime.startsWith("image/"))allImages=false;
      }
      String type=uris.size()==1?commonMime:(allImages?"image/*":"*/*");
      Intent share=uris.size()==1
        ?new Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM,uris.get(0))
        :new Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM,uris);
      share.setPackage("com.kakao.talk").setType(type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      ClipData clip=ClipData.newUri(getContentResolver(),"media",uris.get(0));
      for(int i=1;i<uris.size();i++)clip.addItem(new ClipData.Item(uris.get(i)));
      share.setClipData(clip);
      startActivity(share);
    }catch(Exception ignored){}finally{finish();}
  }
}
