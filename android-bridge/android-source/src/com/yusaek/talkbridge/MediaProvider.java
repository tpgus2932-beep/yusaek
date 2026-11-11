package com.yusaek.talkbridge;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;

public final class MediaProvider extends ContentProvider {
  public boolean onCreate(){return true;}
  private File directory(Uri uri)throws FileNotFoundException {
    String id=uri.getLastPathSegment();
    if(!"com.yusaek.talkbridge.media".equals(uri.getAuthority())||id==null||!id.matches("[a-f0-9-]{36}")||uri.getPathSegments().size()!=1)throw new FileNotFoundException("media_uri_invalid");
    File root=getContext().getExternalFilesDir(null);if(root==null)throw new FileNotFoundException("media_storage_missing");
    return new File(root,"outgoing/"+id);
  }
  private JSONObject metadata(Uri uri){try{return new JSONObject(new String(Files.readAllBytes(new File(directory(uri),"metadata.json").toPath()),StandardCharsets.UTF_8));}catch(Exception e){return new JSONObject();}}
  public String getType(Uri uri){return metadata(uri).optString("mime","application/octet-stream");}
  public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort){
    JSONObject meta=metadata(uri);String[] cols=projection==null?new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE}:projection;
    MatrixCursor cursor=new MatrixCursor(cols);Object[] row=new Object[cols.length];for(int i=0;i<cols.length;i++)row[i]=OpenableColumns.DISPLAY_NAME.equals(cols[i])?meta.optString("name","attachment"):OpenableColumns.SIZE.equals(cols[i])?meta.optLong("bytes",0):null;cursor.addRow(row);return cursor;
  }
  public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException {if(!"r".equals(mode))throw new FileNotFoundException("read_only");return ParcelFileDescriptor.open(new File(directory(uri),"data"),ParcelFileDescriptor.MODE_READ_ONLY);}
  public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
  public int update(Uri uri,ContentValues values,String where,String[] args){throw new UnsupportedOperationException();}
  public int delete(Uri uri,String where,String[] args){throw new UnsupportedOperationException();}
}
