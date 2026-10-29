package io.starpost.mobile;

import java.io.*;
import java.security.MessageDigest;
import java.util.*;

/** Local favorites retain the original bytes; content hashes prevent duplicate copies. */
final class StickerLibrary {
    private final File directory;
    StickerLibrary(File directory) throws IOException {
        this.directory = directory.getCanonicalFile();
        if (!this.directory.isDirectory() && !this.directory.mkdirs()) throw new IOException("无法创建表情包收藏目录");
    }
    static String mime(File file) throws IOException {
        String name = file.getName();
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg")) return "image/jpeg";
        if (name.endsWith(".gif")) return "image/gif";
        if (name.endsWith(".webp")) return "image/webp";
        throw new IOException("不支持的表情包格式");
    }
    synchronized File save(byte[] bytes, String mime) throws IOException {
        if (bytes.length == 0 || bytes.length > 1024 * 1024) throw new IOException("表情包须小于 1 MiB");
        String ext;
        if (mime.equals("image/png") && starts(bytes,new int[]{137,80,78,71,13,10,26,10})) ext="png";
        else if (mime.equals("image/jpeg") && starts(bytes,new int[]{255,216,255})) ext="jpg";
        else if (mime.equals("image/gif") && starts(bytes,new int[]{71,73,70,56})) ext="gif";
        else if (mime.equals("image/webp") && starts(bytes,new int[]{82,73,70,70}) && bytes.length>=12 && bytes[8]=='W' && bytes[9]=='E' && bytes[10]=='B' && bytes[11]=='P') ext="webp";
        else throw new IOException("图片内容和格式不匹配");
        StringBuilder hash = new StringBuilder();
        try { for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) hash.append(String.format(Locale.ROOT,"%02x",b & 255)); }
        catch (Exception e) { throw new IOException(e); }
        File output = new File(directory,hash+"."+ext);
        if (output.isFile()) { output.setLastModified(System.currentTimeMillis()); return output; }
        if (directory.getUsableSpace() < bytes.length * 2L + 10 * 1024 * 1024) throw new IOException("手机剩余空间不足");
        File temp = File.createTempFile("collect-", ".tmp", directory);
        try {
            try (FileOutputStream stream = new FileOutputStream(temp)) { stream.write(bytes); stream.getFD().sync(); }
            if (!temp.renameTo(output)) throw new IOException("保存表情包失败");
            return output;
        } finally { if (temp.exists()) temp.delete(); }
    }
    synchronized List<File> list() {
        File[] values = directory.listFiles(file -> file.isFile() && file.getName().matches("[a-f0-9]{64}\\.(png|jpg|gif|webp)"));
        List<File> files = values == null ? new ArrayList<>() : new ArrayList<>(Arrays.asList(values));
        files.sort((a,b) -> Long.compare(b.lastModified(),a.lastModified()));
        return files;
    }
    byte[] read(File file) throws IOException {
        File actual = file.getCanonicalFile();
        if (!directory.equals(actual.getParentFile()) || !actual.isFile() || actual.length()>1024*1024) throw new IOException("表情包文件无效");
        try (InputStream input = new FileInputStream(actual); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int n;
            while ((n=input.read(buffer))!=-1) { output.write(buffer,0,n); if (output.size()>1024*1024) throw new IOException("表情包过大"); }
            return output.toByteArray();
        }
    }
    private static boolean starts(byte[] bytes, int[] prefix) {
        if (bytes.length<prefix.length) return false;
        for (int i=0;i<prefix.length;i++) if ((bytes[i]&255)!=prefix[i]) return false;
        return true;
    }
}
