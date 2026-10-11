package org.substream.app

import android.annotation.SuppressLint
import android.app.Activity
import android.util.Base64
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.media3.common.MediaItem
import androidx.media3.common.AudioAttributes
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.ui.PlayerView
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

@OptIn(UnstableApi::class)
class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var playerView: PlayerView
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private var player: ExoPlayer? = null
    private var session = ""
    private var stateListener: Player.Listener? = null
    private var resumeAfterForeground = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private val progressTick = object : Runnable {
        override fun run() {
            val active = player
            if (active != null) {
                emit("progress", JSONObject().put("currentTimeSeconds", active.currentPosition / 1000.0)
                    .put("durationSeconds", (active.duration.takeIf { it >= 0 } ?: 0L) / 1000.0))
                mainHandler.postDelayed(this, 1000)
            }
        }
    }
    private val io = Executors.newFixedThreadPool(4)
    private val assetsPrefix = "https://appassets.androidplatform.net/assets/"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        playerView = layoutInflater.inflate(R.layout.player_surface, root, false) as PlayerView
        playerView.visibility = View.GONE
        root.addView(playerView, FrameLayout.LayoutParams(1, 1))

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        webView = WebView(this)
        configureWebView()
        root.addView(webView, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        webView.loadUrl("${assetsPrefix}index.html")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.setBackgroundColor(Color.TRANSPARENT)
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
        }
        webView.addJavascriptInterface(NativeBridge(), "SubstreamNative")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url
                if (isTrustedAppUrl(uri)) {
                    val response = assetLoader.shouldInterceptRequest(uri) ?: return null
                    if (response.mimeType?.startsWith("text/html", ignoreCase = true) != true || response.data == null) return response
                    val headers = mutableMapOf<String, String>()
                    response.responseHeaders?.let { headers.putAll(it) }
                    headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' http: https:; font-src 'self' data: https:; frame-src 'none'; child-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'"
                    val statusCode = response.statusCode.takeIf { it in 100..599 && it !in 300..399 } ?: 200
                    val reasonPhrase = response.reasonPhrase?.takeIf { it.isNotBlank() } ?: "OK"
                    return WebResourceResponse(response.mimeType, response.encoding, statusCode,
                        reasonPhrase, headers, response.data)
                }
                if (request.isForMainFrame || request.requestHeaders["Accept"]?.contains("text/html", ignoreCase = true) == true) {
                    return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), null)
                }
                // Provider/API requests must reach their intended hosts directly; only document/frame navigation is blocked.
                return null
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return !isTrustedAppUrl(request.url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!isTrustedAppUrl(Uri.parse(url))) view.stopLoading()
            }
        }
    }

    private fun isTrustedAppUrl(uri: Uri): Boolean =
        uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
            uri.userInfo == null && (uri.port == -1 || uri.port == 443) &&
            (uri.path ?: "").startsWith("/assets/") &&
            !(uri.path ?: "").split('/').any { it == ".." }

    private inner class NativeBridge {
        @JavascriptInterface
        fun postMessage(raw: String) {
            if (raw.length > 1_200_000) return
            runOnUiThread {
                if (!isTrustedAppUrl(Uri.parse(webView.url ?: ""))) return@runOnUiThread
                handleMessage(raw)
            }
        }
    }

    private fun handleMessage(raw: String) {
        val message = try { JSONObject(raw) } catch (_: Exception) { return }
        if (message.optInt("v") != 1) return
        val command = message.optString("command")
        val id = message.optString("id")
        val requestedSession = message.optString("session")
        val payload = message.optJSONObject("payload") ?: JSONObject()
        if (command == "create") {
            releasePlayer()
            session = requestedSession.take(80)
            if (session.isBlank()) session = id.take(80)
            playerView.visibility = View.VISIBLE
            return
        }
        if (command == "request") {
            if (requestedSession != "android-transport") return
            performRequest(id, requestedSession, payload)
            return
        }
        if (requestedSession.isNotEmpty() && requestedSession != session) return
        when (command) {
            "load" -> loadMedia(payload)
            "play" -> player?.play()
            "pause" -> player?.pause()
            "seek" -> player?.seekTo((payload.optDouble("seconds", 0.0) * 1000).toLong().coerceAtLeast(0))
            "skip" -> player?.let { it.seekTo((it.currentPosition + payload.optDouble("seconds", 0.0) * 1000).toLong().coerceAtLeast(0)) }
            "restart" -> player?.seekTo(0)
            "displayMode" -> applyDisplayMode(payload.optString("mode"))
            "resize" -> resizeSurface(payload)
            "audioTrack" -> selectTrack(payload.optString("id"), false)
            "textTrack" -> selectTrack(payload.optString("id"), true)
            "textTrackEnabled" -> setTextTracksEnabled(payload.optBoolean("enabled"))
            "subtitle" -> attachSubtitle(payload)
            "subtitleOffset" -> Unit // Media3 subtitle offset support is implemented by the shared cue renderer.
            "destroy" -> releasePlayer()
        }
    }

    private fun loadMedia(payload: JSONObject) {
        val rawUrl = payload.optString("url")
        val uri = try { Uri.parse(rawUrl) } catch (_: Exception) { null }
        if (uri == null || uri.scheme !in listOf("http", "https") || uri.host.isNullOrBlank() || rawUrl.length > 16384) {
            emit("error", JSONObject().put("message", "Playback could not be started"))
            return
        }
        releasePlayer()
        playerView.visibility = View.VISIBLE
        val selector = DefaultTrackSelector(this)
        val exo = ExoPlayer.Builder(this).setTrackSelector(selector).build()
        exo.setAudioAttributes(AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
            .build(), true)
        player = exo
        playerView.player = exo
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                emit("state", JSONObject().put("state", when (playbackState) {
                    Player.STATE_BUFFERING -> "buffering"
                    Player.STATE_READY -> if (exo.playWhenReady) "playing" else "paused"
                    Player.STATE_ENDED -> "ended"
                    else -> "loading"
                }))
                emitTrackLists(exo.currentTracks)
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                emit("state", JSONObject().put("state", if (isPlaying) "playing" else "paused"))
            }
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                emit("state", JSONObject().put("state", "error"))
                emit("error", JSONObject().put("message", "Playback failed"))
            }
            override fun onTracksChanged(tracks: Tracks) { emitTrackLists(tracks) }
        }
        stateListener = listener
        exo.addListener(listener)
        val item = MediaItem.fromUri(uri)
        exo.setMediaItem(item, (payload.optDouble("resumeSeconds", 0.0).coerceAtLeast(0.0) * 1000).toLong())
        exo.prepare()
        // Shared screens call load() directly and expect the selected item to start.
        exo.playWhenReady = true
        emit("state", JSONObject().put("state", "loading"))
        mainHandler.removeCallbacks(progressTick)
        mainHandler.post(progressTick)
    }

    private fun emitTrackLists(tracks: Tracks) {
        val audio = org.json.JSONArray()
        val subtitles = org.json.JSONArray()
        tracks.groups.forEachIndexed { groupIndex, group ->
            for (trackIndex in 0 until group.length) {
                val format = group.getTrackFormat(trackIndex)
                val isSelected = group.isTrackSelected(trackIndex)
                val id = "$groupIndex-$trackIndex"
                val language = format.language?.takeUnless { it == "und" }
                val label = listOfNotNull(language, format.label, format.sampleMimeType?.substringAfter('/')?.uppercase())
                    .distinct().joinToString(" · ").ifBlank { "Track ${trackIndex + 1}" }
                when (group.type) {
                    androidx.media3.common.C.TRACK_TYPE_AUDIO -> audio.put(JSONObject().put("id", id).put("label", label).put("selected", isSelected).putOpt("language", language).putOpt("codec", format.codecs))
                    androidx.media3.common.C.TRACK_TYPE_TEXT -> subtitles.put(JSONObject().put("id", id).put("label", label).put("selected", isSelected).put("playable", true).putOpt("language", language).put("forced", format.selectionFlags and androidx.media3.common.C.SELECTION_FLAG_FORCED != 0).put("hearingImpaired", format.roleFlags and androidx.media3.common.C.ROLE_FLAG_CAPTION != 0).putOpt("codec", format.codecs))
                }
            }
        }
        emit("audioTracks", JSONObject().put("tracks", audio))
        emit("textTracks", JSONObject().put("tracks", subtitles))
    }

    private fun selectTrack(id: String, text: Boolean) {
        val parts = id.split("-")
        if (parts.size != 2) return
        val groupIndex = parts[0].toIntOrNull() ?: return
        val trackIndex = parts[1].toIntOrNull() ?: return
        val current = player?.currentTracks ?: return
        val group = current.groups.getOrNull(groupIndex) ?: return
        if (trackIndex !in 0 until group.length) return
        if ((group.type == androidx.media3.common.C.TRACK_TYPE_TEXT) != text) return
        val selector = player?.trackSelectionParameters ?: return
        val override = androidx.media3.common.TrackSelectionOverride(group.mediaTrackGroup, trackIndex)
        player?.trackSelectionParameters = selector.buildUpon()
            .setTrackTypeDisabled(if (text) androidx.media3.common.C.TRACK_TYPE_TEXT else androidx.media3.common.C.TRACK_TYPE_AUDIO, false)
            .setOverrideForType(override).build()
    }

    private fun setTextTracksEnabled(enabled: Boolean) {
        val p = player ?: return
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_TEXT, !enabled).build()
    }

    private fun attachSubtitle(payload: JSONObject) {
        val text = payload.optString("text")
        if (text.length > 2_000_000) {
            emit("error", JSONObject().put("message", "Subtitle could not be attached")); return
        }
        val mime = if (text.contains("WEBVTT", ignoreCase = true)) "text/vtt" else "application/x-subrip"
        val subtitle = MediaItem.SubtitleConfiguration.Builder(Uri.parse("data:$mime,${Uri.encode(text)}"))
            .setMimeType(mime).setLanguage(payload.optString("language", "und")).setSelectionFlags(C.SELECTION_FLAG_DEFAULT).build()
        val p = player ?: return
        p.setMediaItem(p.currentMediaItem?.buildUpon()?.setSubtitleConfigurations(listOf(subtitle))?.build() ?: return, p.currentPosition)
        p.prepare()
    }

    private fun applyDisplayMode(mode: String) {
        playerView.resizeMode = when (mode) {
            "fit" -> androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FIT
            "fill" -> androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_ZOOM
            else -> androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FIT
        }
    }

    private fun resizeSurface(payload: JSONObject) {
        val density = resources.displayMetrics.density
        val x = (payload.optDouble("x", 0.0) * density).toInt()
        val y = (payload.optDouble("y", 0.0) * density).toInt()
        val width = (payload.optDouble("width", 0.0) * density).toInt()
        val height = (payload.optDouble("height", 0.0) * density).toInt()
        if (width > 0 && height > 0) {
            val params = playerView.layoutParams as FrameLayout.LayoutParams
            params.width = width; params.height = height; params.leftMargin = x; params.topMargin = y
            playerView.layoutParams = params
        }
    }

    private fun performRequest(id: String, eventSession: String, payload: JSONObject) {
        val rawUrl = payload.optString("url")
        val uri = try { Uri.parse(rawUrl) } catch (_: Exception) { null }
        val requestId = payload.optString("requestId", id).take(100)
        if (uri == null || uri.scheme !in listOf("http", "https") || uri.host.isNullOrBlank() || rawUrl.length > 16384) {
            emitForSession(eventSession, "requestError", JSONObject().put("requestId", requestId).put("message", "Request failed")); return
        }
        val method = payload.optString("method", "GET").uppercase()
        if (method !in setOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD")) {
            emitForSession(eventSession, "requestError", JSONObject().put("requestId", requestId).put("message", "Request failed")); return
        }
        val body = payload.optString("body", "").toByteArray(Charsets.UTF_8)
        if (body.size > 1_048_576) {
            emitForSession(eventSession, "requestError", JSONObject().put("requestId", requestId).put("message", "Request failed")); return
        }
        val headers = payload.optJSONObject("headers") ?: JSONObject()
        io.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = URL(rawUrl).openConnection() as HttpURLConnection
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 20_000
                connection.readTimeout = 20_000
                connection.requestMethod = method
                val keys = headers.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    if (key.length <= 128 && key.matches(Regex("[A-Za-z0-9-]+"))) {
                        val value = headers.optString(key)
                        if (value.length <= 16_384 && !key.equals("host", true) && !key.equals("cookie", true)) connection.setRequestProperty(key, value)
                    }
                }
                if (method in setOf("POST", "PUT", "PATCH") && body.isNotEmpty()) {
                    connection.doOutput = true
                    connection.outputStream.use { it.write(body) }
                }
                val status = connection.responseCode
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                val bytes = ByteArrayOutputStream()
                stream?.use { input ->
                    val buffer = ByteArray(8192); var total = 0
                    while (true) {
                        val count = input.read(buffer); if (count < 0) break
                        total += count; if (total > 16_777_216) throw IllegalStateException("response limit")
                        bytes.write(buffer, 0, count)
                    }
                }
                val safeHeaders = JSONObject()
                connection.headerFields.forEach { (name, values) ->
                    if (name != null && name.lowercase() in setOf("content-type", "content-length", "etag", "last-modified", "cache-control")) safeHeaders.put(name, values?.joinToString(",") ?: "")
                }
                val response = JSONObject().put("requestId", requestId).put("status", status)
                    .put("headers", safeHeaders).put("bodyBase64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
                runOnUiThread { emitForSession(eventSession, "response", response) }
            } catch (_: Exception) {
                runOnUiThread { emitForSession(eventSession, "requestError", JSONObject().put("requestId", requestId).put("message", "Request failed")) }
            } finally { connection?.disconnect() }
        }
    }

    private fun emit(type: String, payload: JSONObject) {
        emitForSession(session, type, payload)
    }

    private fun emitForSession(eventSession: String, type: String, payload: JSONObject) {
        if (!::webView.isInitialized || eventSession.isBlank()) return
        val event = JSONObject().put("v", 1).put("session", eventSession).put("type", type).put("payload", payload)
        val js = "window.__substreamAndroid&&window.__substreamAndroid.onEvent(${JSONObject.quote(event.toString())})"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    private fun releasePlayer() {
        mainHandler.removeCallbacks(progressTick)
        player?.let { exo ->
            stateListener?.let(exo::removeListener)
            exo.stop(); exo.clearMediaItems(); exo.release()
        }
        stateListener = null
        player = null
        playerView.player = null
        playerView.visibility = View.GONE
    }

    private fun sendBackToWeb() {
        if (::webView.isInitialized) {
            webView.evaluateJavascript(
                "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}))", null)
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK || event.keyCode == KeyEvent.KEYCODE_ESCAPE
            || event.keyCode == KeyEvent.KEYCODE_BUTTON_B) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) sendBackToWeb()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    @Deprecated("Android TV Back is routed to the WebView")
    override fun onBackPressed() {
        sendBackToWeb()
    }

    override fun onPause() {
        resumeAfterForeground = player?.isPlaying == true
        player?.pause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        if (resumeAfterForeground) player?.play()
        resumeAfterForeground = false
    }

    override fun onDestroy() {
        releasePlayer()
        io.shutdownNow()
        webView.removeJavascriptInterface("SubstreamNative")
        webView.destroy()
        super.onDestroy()
    }
}
