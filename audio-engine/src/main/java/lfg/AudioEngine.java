package lfg;

import com.sedmelluq.discord.lavaplayer.player.*;
import com.sedmelluq.discord.lavaplayer.player.event.AudioEventAdapter;
import com.sedmelluq.discord.lavaplayer.source.AudioSourceManagers;
import com.sedmelluq.discord.lavaplayer.source.soundcloud.SoundCloudAudioSourceManager;
import com.sedmelluq.discord.lavaplayer.format.StandardAudioDataFormats;
import com.sedmelluq.discord.lavaplayer.track.*;
import com.sedmelluq.discord.lavaplayer.track.playback.AudioFrame;
import com.sedmelluq.discord.lavaplayer.tools.FriendlyException;
import dev.lavalink.youtube.YoutubeAudioSourceManager;
import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Small loopback audio adapter, using the same source libraries as jagrosh/MusicBot. */
public final class AudioEngine {
  private final DefaultAudioPlayerManager manager = new DefaultAudioPlayerManager();
  private final Map<String, Entry> tracks = Collections.synchronizedMap(new LinkedHashMap<String, Entry>(16, .75f, true) {
    protected boolean removeEldestEntry(Map.Entry<String, Entry> entry) { return size() > 64; }
  });
  private record Entry(AudioTrack track, long expires) {}
  private final Semaphore streams = new Semaphore(Integer.parseInt(System.getenv().getOrDefault("MUSIC_ENGINE_MAX_STREAMS", "1")));
  private final String key = System.getenv("MUSIC_ENGINE_KEY");
  private final String testFile = System.getenv("MUSIC_ENGINE_TEST_FILE");
  private final HttpServer server;
  private AudioEngine() throws Exception {
    if (key == null || key.length() < 32) throw new IllegalArgumentException("MUSIC_ENGINE_KEY is required (at least 32 characters)");
    manager.getConfiguration().setOutputFormat(StandardAudioDataFormats.DISCORD_PCM_S16_LE);
    manager.setFrameBufferDuration(1000);
    manager.setPlayerCleanupThreshold(30000);
    manager.registerSourceManager(new YoutubeAudioSourceManager(true));
    manager.registerSourceManager(SoundCloudAudioSourceManager.createDefault());
    if (testFile != null && !testFile.isBlank()) AudioSourceManagers.registerLocalSource(manager);
    int port = Integer.parseInt(System.getenv().getOrDefault("MUSIC_ENGINE_PORT", "2334"));
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 8);
    server.setExecutor(Executors.newFixedThreadPool(4, runnable -> { Thread t = new Thread(runnable); t.setDaemon(true); return t; }));
    server.createContext("/", this::handle);
    Runtime.getRuntime().addShutdownHook(new Thread(() -> { server.stop(0); manager.shutdown(); }));
    server.start();
    System.out.println("[audio-engine] loopback service ready, port=" + port + ", format=s16le/48000/stereo");
  }
  private void handle(HttpExchange exchange) throws IOException {
    try {
      if (!"GET".equals(exchange.getRequestMethod())) { json(exchange, 405, "{\"error\":\"method_not_allowed\"}"); return; }
      String auth = exchange.getRequestHeaders().getFirst("X-Engine-Key");
      if (auth == null || !MessageDigest.isEqual(key.getBytes(StandardCharsets.UTF_8), auth.getBytes(StandardCharsets.UTF_8))) { json(exchange, 401, "{\"error\":\"unauthorized\"}"); return; }
      if (exchange.getRequestURI().toString().length() > 4096) { json(exchange, 414, "{\"error\":\"request_too_long\"}"); return; }
      Map<String,String> q = query(exchange.getRequestURI().getRawQuery());
      switch (exchange.getRequestURI().getPath()) {
        case "/health" -> json(exchange, 200, "{\"ok\":true,\"format\":\"s16le\",\"sampleRate\":48000,\"channels\":2}");
        case "/search" -> {
          String text = q.getOrDefault("query", "").strip();
          if (text.isEmpty() || text.length() > 400) { json(exchange, 400, "{\"error\":\"invalid_query\"}"); return; }
          String source = q.getOrDefault("source", "youtube");
          if (!List.of("youtube", "soundcloud").contains(source)) { json(exchange, 400, "{\"error\":\"unsupported_source\"}"); return; }
          respondTracks(exchange, load((source.equals("youtube") ? "ytsearch:" : "scsearch:") + text, true));
        }
        case "/load" -> {
          String url = q.getOrDefault("url", "");
          URI u = URI.create(url);
          if (!"https".equals(u.getScheme()) || u.getUserInfo() != null || u.getPort() != -1 ||
              !List.of("youtube.com", "www.youtube.com", "music.youtube.com", "m.youtube.com", "youtu.be", "soundcloud.com", "www.soundcloud.com").contains(u.getHost())) {
            json(exchange, 400, "{\"error\":\"unsupported_url\"}"); return;
          }
          respondTracks(exchange, load(url, false));
        }
        case "/test" -> {
          if (testFile == null || testFile.isBlank()) { json(exchange, 404, "{\"error\":\"not_found\"}"); return; }
          respondTracks(exchange, load(testFile, false));
        }
        case "/stream" -> stream(exchange, q);
        default -> json(exchange, 404, "{\"error\":\"not_found\"}");
      }
    } catch (TimeoutException e) { json(exchange, 504, "{\"error\":\"source_timeout\"}"); }
      catch (Exception e) { if (exchange.getResponseCode() == -1) json(exchange, 502, "{\"error\":" + quote(failureCode(e)) + "}"); else exchange.close(); }
  }
  private List<AudioTrack> load(String identifier, boolean search) throws Exception {
    CompletableFuture<List<AudioTrack>> future = new CompletableFuture<>();
    manager.loadItem(identifier, new AudioLoadResultHandler() {
      public void trackLoaded(AudioTrack track) { future.complete(List.of(track)); }
      public void playlistLoaded(AudioPlaylist playlist) {
        if (!search || !playlist.isSearchResult()) future.completeExceptionally(new IllegalArgumentException("Playlists are not supported"));
        else future.complete(playlist.getTracks().stream().limit(4).toList());
      }
      public void noMatches() { future.complete(List.of()); }
      public void loadFailed(FriendlyException error) { future.completeExceptionally(new IOException("Source could not load track", error)); }
    });
    return future.get(18, TimeUnit.SECONDS);
  }
  private void respondTracks(HttpExchange exchange, List<AudioTrack> found) throws IOException {
    List<String> items = new ArrayList<>();
    for (AudioTrack track : found) {
      if (track.getInfo().isStream || track.getDuration() <= 0 || track.getDuration() > 7200000) continue;
      String id = UUID.randomUUID().toString(); tracks.put(id, new Entry(track, System.currentTimeMillis() + 900000));
      AudioTrackInfo info = track.getInfo();
      items.add("{\"id\":" + quote(id) + ",\"title\":" + quote(info.title) + ",\"artist\":" + quote(info.author) + ",\"durationMs\":" + track.getDuration() + ",\"url\":" + quote(info.uri) + "}");
    }
    json(exchange, 200, "{\"candidates\":[" + String.join(",", items) + "]}");
  }
  private void stream(HttpExchange exchange, Map<String,String> q) throws Exception {
    Entry entry = tracks.get(q.getOrDefault("id", ""));
    if (entry == null || entry.expires < System.currentTimeMillis()) { json(exchange, 404, "{\"error\":\"track_expired\"}"); return; }
    long position = Long.parseLong(q.getOrDefault("position", "0"));
    if (position < 0 || position >= entry.track.getDuration()) { json(exchange, 400, "{\"error\":\"invalid_position\"}"); return; }
    if (!streams.tryAcquire()) { json(exchange, 429, "{\"error\":\"stream_limit\"}"); return; }
    AudioPlayer player = manager.createPlayer(); AtomicBoolean ended = new AtomicBoolean(); AtomicReference<Throwable> failure = new AtomicReference<>();
    try {
      player.addListener(new AudioEventAdapter() {
        public void onTrackEnd(AudioPlayer p, AudioTrack t, AudioTrackEndReason r) { ended.set(true); }
        public void onTrackException(AudioPlayer p, AudioTrack t, FriendlyException e) { failure.set(e); ended.set(true); }
      });
      AudioTrack track = entry.track.makeClone(); track.setPosition(position); player.startTrack(track, false);
      AudioFrame first = null; long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(12);
      while (first == null && !ended.get() && System.nanoTime() < deadline) { first = player.provide(); if (first == null) Thread.sleep(10); }
      if (first == null) { json(exchange, 502, "{\"error\":" + quote(failure.get() == null ? "source_timeout" : failureCode(failure.get())) + "}"); return; }
      exchange.getResponseHeaders().set("Content-Type", "application/octet-stream");
      exchange.getResponseHeaders().set("Cache-Control", "no-store"); exchange.sendResponseHeaders(200, 0);
      try (OutputStream out = exchange.getResponseBody()) {
        out.write(first.getData());
        long lastFrame = System.nanoTime();
        while (true) {
          AudioFrame frame = player.provide();
          if (frame != null) { out.write(frame.getData()); lastFrame = System.nanoTime(); }
          else if (ended.get() || TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - lastFrame) > 20) break;
          else Thread.sleep(10);
        }
      }
    } finally { player.destroy(); streams.release(); exchange.close(); }
  }
  private static String failureCode(Throwable error) {
    String text = ""; for (int i=0; error != null && i<6; i++, error=error.getCause()) text += " " + error.getMessage();
    text = text.toLowerCase(Locale.ROOT);
    if (text.contains("sign in") || text.contains("not a bot") || text.contains("login") || text.contains("age restricted")) return "source_auth_required";
    if (text.contains("429") || text.contains("rate limit")) return "source_rate_limited";
    if (text.contains("403") || text.contains("forbidden") || text.contains("geo") || text.contains("region")) return "source_access_denied";
    if (text.contains("cipher") || text.contains("signature") || text.contains("player script")) return "source_module_update_needed";
    if (text.contains("timed out") || text.contains("timeout")) return "source_timeout";
    return "source_unavailable";
  }
  private static Map<String,String> query(String raw) {
    Map<String,String> result = new HashMap<>();
    if (raw != null) for (String pair : raw.split("&")) {
      String[] bits = pair.split("=", 2);
      result.put(URLDecoder.decode(bits[0], StandardCharsets.UTF_8), URLDecoder.decode(bits.length == 2 ? bits[1] : "", StandardCharsets.UTF_8));
    }
    return result;
  }
  private static void json(HttpExchange exchange, int status, String value) throws IOException {
    byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    exchange.getResponseHeaders().set("Cache-Control", "no-store"); exchange.sendResponseHeaders(status, bytes.length);
    try (OutputStream out = exchange.getResponseBody()) { out.write(bytes); }
  }
  private static String quote(String value) {
    if (value == null) return "null"; StringBuilder b = new StringBuilder("\"");
    for (char c : value.toCharArray()) {
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c < 32) b.append(String.format("\\u%04x", (int)c)); else b.append(c);
    }
    return b.append('"').toString();
  }
  public static void main(String[] args) throws Exception { new AudioEngine(); }
}
