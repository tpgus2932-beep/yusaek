package com.yusaek.talkbridge;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Durable local outbox. Only an HTTP acknowledgement moves pending to sent. */
public final class NotificationJournal {
    public static final class Entry {
        public final String id,body;
        Entry(String id,String body){this.id=id;this.body=body;}
    }
    private final File root;
    public NotificationJournal(File root)throws IOException{
        this.root=root;
        if(!root.isDirectory()&&!root.mkdirs())throw new IOException("outbox_directory_unavailable");
    }
    private File file(String id,String suffix){
        if(!id.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("outbox_id_invalid");
        return new File(root,id+suffix);
    }
    private void move(File from,File to)throws IOException{
        try{Files.move(from.toPath(),to.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
        catch(AtomicMoveNotSupportedException e){Files.move(from.toPath(),to.toPath(),StandardCopyOption.REPLACE_EXISTING);}
    }
    private void write(File target,String body)throws IOException{
        File temp=new File(root,target.getName()+".tmp");
        try(FileOutputStream out=new FileOutputStream(temp)){
            out.write(body.getBytes(StandardCharsets.UTF_8));out.getFD().sync();
        }
        move(temp,target);
    }
    public synchronized void enqueue(String id,String body)throws IOException{
        File pending=file(id,".pending");
        if(pending.exists()||file(id,".sent").exists())return;
        write(pending,body);
    }
    public synchronized void markSeen(String id)throws IOException{
        if(!file(id,".pending").exists()&&!file(id,".sent").exists())write(file(id,".sent"),"");
    }
    public synchronized List<Entry> batch(int limit)throws IOException{
        File[] files=root.listFiles((dir,name)->name.matches("[a-f0-9]{64}\\.pending"));
        if(files==null)throw new IOException("outbox_read_failed");
        Arrays.sort(files,Comparator.comparingLong(File::lastModified).thenComparing(File::getName));
        List<Entry> entries=new ArrayList<>();
        for(File f:files){if(entries.size()>=limit)break;entries.add(new Entry(f.getName().substring(0,64),new String(Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8)));}
        return entries;
    }
    public synchronized void acknowledge(Collection<String> ids)throws IOException{
        for(String id:ids){File pending=file(id,".pending");if(pending.exists())move(pending,file(id,".sent"));}
        File[] sent=root.listFiles((dir,name)->name.matches("[a-f0-9]{64}\\.sent"));
        if(sent==null)throw new IOException("outbox_read_failed");
        Arrays.sort(sent,Comparator.comparingLong(File::lastModified).thenComparing(File::getName));
        for(int i=0;i<sent.length-4000;i++)Files.deleteIfExists(sent[i].toPath());
    }
}
