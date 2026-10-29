package io.starpost.mobile;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

public final class StickerLibraryTest {
    public static void main(String[] args) throws Exception {
        File build=new File("android/build").getCanonicalFile();
        File root=Files.createTempDirectory(build.toPath(),"stickers-test-").toFile().getCanonicalFile();
        if(!root.getPath().startsWith(build.getPath()+File.separator))throw new AssertionError("Unexpected test directory");
        try {
            File directory=new File(root,"favorites");StickerLibrary library=new StickerLibrary(directory);
            byte[] png=Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=");
            byte[] gif=Base64.getDecoder().decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
            File first=library.save(png,"image/png");
            if(!Arrays.equals(png,library.read(first)))throw new AssertionError("Original image changed");
            ExecutorService workers=Executors.newFixedThreadPool(4);
            try {
                List<Future<File>> results=new ArrayList<>();for(int i=0;i<20;i++)results.add(workers.submit(()->library.save(png,"image/png")));
                for(Future<File> result:results)if(!first.equals(result.get()))throw new AssertionError("Duplicate image");
            } finally { workers.shutdownNow(); }
            if(library.list().size()!=1)throw new AssertionError("Deduplication failed");
            File animated=library.save(gif,"image/gif");
            StickerLibrary restarted=new StickerLibrary(directory);
            if(restarted.list().size()!=2||!Arrays.equals(gif,restarted.read(animated)))throw new AssertionError("Favorites not retained across restart");
            try{library.save(png,"image/jpeg");throw new AssertionError("Wrong MIME accepted");}catch(IOException expected){}
            try{library.save(new byte[1024*1024+1],"image/png");throw new AssertionError("Oversized image accepted");}catch(IOException expected){}
            File outside=new File(root,"outside.png");Files.write(outside.toPath(),png);
            try{library.read(outside);throw new AssertionError("Outside file accepted");}catch(IOException expected){}
            Files.write(new File(directory,"not-a-favorite.txt").toPath(),png);
            if(library.list().size()!=2)throw new AssertionError("Unexpected files listed");
            System.out.println("STICKER_FAVORITES_PERSIST_DEDUP_MIME_PATH_OK");
        } finally {
            try(java.util.stream.Stream<Path> paths=Files.walk(root.toPath())){paths.sorted(Comparator.reverseOrder()).forEach(path->{try{Files.delete(path);}catch(IOException e){throw new UncheckedIOException(e);}});}
        }
    }
}
