package com.beatroute.signal.internal

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import android.webkit.JavascriptInterface
import com.beatroute.signal.SessionProvider
import com.beatroute.signal.internal.outbox.Outbox
import com.beatroute.signal.internal.outbox.OutboxEntity
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/**
 * The native side of the sheet bridge (docs/sheet-bridge-v1.md), exposed to the
 * WebView's JS as `window.SignalBridge` via `@JavascriptInterface`.
 *
 * web-core is pure and delegates every impure intent here as a JSON message:
 *  - `ready`         → the JS harness is live; inject the raw config (host -> core INIT).
 *  - `submit`        → map web-core's `Answer` onto the wire `ResponseBody` and enqueue
 *                      it to the PRECIOUS outbox (F2-D10/D18), then record local
 *                      suppression for `(eventName, userId)` (F2-D11).
 *  - `dismiss`       → enqueue a `/dismiss` to the same outbox + record suppression.
 *  - `openUrl`       → open the URL in the browser (post-submit redirect).
 *  - `openReview`    → fire a Play Store review intent (post-submit store_review).
 *  - `resize`        → size the host WebView/dialog to the measured sheet height.
 *
 * @JavascriptInterface methods are invoked on a WebView-owned background thread, so
 * anything touching the UI (config injection, resize, close) is posted back through
 * the [Ui] seam (which hops to the main thread); outbox writes run on the SDK scope.
 * Everything is wrapped so a malformed message can never crash the host (F2-D10).
 */
internal class SignalBridge(
    private val context: Context,
    private val eventName: String,
    private val triggerId: String,
    private val sessionProvider: SessionProvider,
    private val suppressionCache: SuppressionStore,
    private val clock: () -> Long,
    private val scope: CoroutineScope,
) {

    /**
     * The fragment-side UI operations the bridge triggers. Injected after the fragment's
     * view exists so the bridge can drive config injection + close on the main thread.
     */
    internal class Ui(
        val injectConfig: () -> Unit,
        val requestClose: () -> Unit,
    )

    @Volatile private var ui: Ui? = null

    /** Fragment installs its UI seam once its view is created. */
    internal fun attach(ui: Ui) {
        this.ui = ui
    }

    /** READY: the JS bundle is live and the host is installed — hand over the config. */
    @JavascriptInterface
    fun ready(json: String) {
        runCatching {
            scope.launch { withContext(Dispatchers.Main) { ui?.injectConfig?.invoke() } }
        }
    }

    /** SUBMIT: persist the response to the precious outbox, then suppress locally. */
    @JavascriptInterface
    fun submit(json: String) {
        runCatching {
            val msg = SignalJson.decodeFromString<SubmitMessage>(json)
            val answer = msg.answer
            val now = clock()
            val response = ResponseBody(
                triggerId = answer.triggerId,
                ratingValue = answer.ratingValue,
                otherText = answer.otherText,
                otherImageUrl = answer.otherImageUrl,
                deviceOs = "Android " + Build.VERSION.RELEASE,
                appVersion = hostAppVersion(),
                sessionAgeDays = sessionProvider.repTenureDays(),
                shownAt = Instant.ofEpochMilli(now).toString(),
                respondedAt = Instant.ofEpochMilli(now).toString(),
            )
            scope.launch {
                runCatching {
                    Outbox.enqueueAndSchedule(
                        context,
                        OutboxEntity(
                            kind = "response",
                            triggerId = response.triggerId,
                            payloadJson = SignalJson.encodeToString(response),
                            createdAt = now,
                        ),
                    )
                    suppressionCache.recordInteraction(eventName, sessionProvider.userId(), clock())
                }
            }
        }.onFailure { Log.w("Signal", "bridge submit failed", it) }
    }

    /** DISMISS: record a `/dismiss` to the outbox + suppress locally, then close. */
    @JavascriptInterface
    fun dismiss(json: String) {
        runCatching {
            val msg = runCatching { SignalJson.decodeFromString<DismissMessage>(json) }.getOrNull()
            val reason = msg?.reason
            // config_invalid fires before a real sheet showed (fail-closed): there is no
            // server trigger to report — just close.
            if (reason != "config_invalid") {
                val now = clock()
                val body = DismissBody(
                    triggerId = triggerId,
                    shownAt = Instant.ofEpochMilli(now).toString(),
                    dismissedAt = Instant.ofEpochMilli(now).toString(),
                )
                scope.launch {
                    runCatching {
                        Outbox.enqueueAndSchedule(
                            context,
                            OutboxEntity(
                                kind = "dismiss",
                                triggerId = body.triggerId,
                                payloadJson = SignalJson.encodeToString(body),
                                createdAt = now,
                            ),
                        )
                        suppressionCache.recordInteraction(
                            eventName, sessionProvider.userId(), clock(),
                        )
                    }
                }
            }
            scope.launch { withContext(Dispatchers.Main) { ui?.requestClose?.invoke() } }
        }.onFailure { Log.w("Signal", "bridge dismiss failed", it) }
    }

    /**
     * REQUEST_UPLOAD (GR-3 default): uploads happen INSIDE web-core — the photo
     * `<input type=file>` is served by the native file chooser
     * ([com.beatroute.signal.ui.WebViewSheetFragment]'s `onShowFileChooser`) and web-core
     * performs the presign + PUT itself. The host therefore does not implement a native
     * upload; if web-core ever routes an upload through this host method the JS harness
     * resolves it as an error (submit text-only), so this endpoint is intentionally inert.
     */
    @JavascriptInterface
    fun requestUpload(json: String) {
        Log.d("Signal", "requestUpload received; uploads are handled inside web-core")
    }

    /** OPEN_URL: post-submit redirect. Opens the system browser. */
    @JavascriptInterface
    fun openUrl(json: String) {
        runCatching {
            val url = SignalJson.decodeFromString<OpenUrlMessage>(json).url
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }.onFailure { Log.w("Signal", "openUrl failed", it) }
    }

    /** OPEN_REVIEW: fire a Play Store review intent for the host package. */
    @JavascriptInterface
    fun openReview(json: String) {
        runCatching {
            val intent = Intent(
                Intent.ACTION_VIEW,
                Uri.parse("market://details?id=" + context.packageName),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }.onFailure { Log.w("Signal", "openReview failed", it) }
    }

    /** RESIZE: native sizes the WebView/dialog to the measured sheet height. The
     *  WebView already fills the transparent dialog, so this is currently a debug log —
     *  the layout is height-agnostic (web-core paints its own backdrop). */
    @JavascriptInterface
    fun resize(json: String) {
        runCatching {
            val h = SignalJson.decodeFromString<ResizeMessage>(json).height
            Log.d("Signal", "sheet resize height=$h")
        }
    }

    private fun hostAppVersion(): String = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    }.getOrDefault("")

    // ---- Bridge message payloads (docs/sheet-bridge-v1.md) ----

    /** web-core's transport-agnostic Answer (SUBMIT payload). */
    @Serializable
    internal data class BridgeAnswer(
        @SerialName("trigger_id") val triggerId: String,
        @SerialName("rating_value") val ratingValue: Int,
        val positive: Boolean = false,
        @SerialName("other_text") val otherText: String? = null,
        @SerialName("other_image_url") val otherImageUrl: String? = null,
    )

    @Serializable
    private data class SubmitMessage(val answer: BridgeAnswer)

    @Serializable
    private data class DismissMessage(val reason: String? = null)

    @Serializable
    private data class OpenUrlMessage(val url: String)

    @Serializable
    private data class ResizeMessage(val height: Double = 0.0)
}
