package com.beatroute.signal.internal

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Classification of a precious-path send (M3-D7). The outbox uses this to decide
 * retry-vs-drop for the /response and /dismiss endpoints.
 */
internal sealed interface SendResult {
    /** 204 — recorded (dedup on the backend makes replays harmless). */
    data object Success : SendResult

    /** Transient — the outbox should retry on reconnect (5xx, IO/timeout, unexpected). */
    data object RetryableFailure : SendResult

    /** Permanent — the outbox should consume and discard (404 unknown trigger, 422 invalid body). */
    data object Drop : SendResult
}

/**
 * Send seam for precious-path bodies. Extracted so the outbox worker can depend on an
 * interface (and tests can supply a fake) rather than the concrete OkHttp-backed client.
 */
internal interface FeedbackSender {
    suspend fun postResponse(body: ResponseBody): SendResult
    suspend fun postDismiss(body: DismissBody): SendResult
}

internal class FeedbackClient(
    private val baseUrl: HttpUrl,
    private val appKey: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(10, TimeUnit.SECONDS).build(),
) : FeedbackSender {
    override suspend fun postResponse(body: ResponseBody): SendResult =
        post("v1/sdk/response", SignalJson.encodeToString(body))

    override suspend fun postDismiss(body: DismissBody): SendResult =
        post("v1/sdk/dismiss", SignalJson.encodeToString(body))

    private suspend fun post(pathSegments: String, json: String): SendResult =
        withContext(Dispatchers.IO) {
            try {
                val url = baseUrl.newBuilder().addPathSegments(pathSegments).build()
                val reqBody = json.toRequestBody("application/json".toMediaType())
                val req = Request.Builder()
                    .url(url)
                    .header("X-Signal-App-Key", appKey)
                    .post(reqBody)
                    .build()
                client.newCall(req).execute().use { res -> classify(res.code) }
            } catch (_: IOException) {
                // Transport failure (connect refused, timeout, reset) — transient, retry later.
                SendResult.RetryableFailure
            }
        }

    private fun classify(code: Int): SendResult = when {
        code == 204 -> SendResult.Success
        code == 404 || code == 422 -> SendResult.Drop
        code in 500..599 -> SendResult.RetryableFailure
        // Other 4xx: a client error that won't fix itself on retry -> Drop.
        code in 400..499 -> SendResult.Drop
        // Anything else unexpected (3xx, non-204 2xx) -> retry; safer than silently dropping precious data.
        else -> SendResult.RetryableFailure
    }
}
