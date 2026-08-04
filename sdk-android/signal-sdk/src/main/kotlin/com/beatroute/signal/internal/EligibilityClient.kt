package com.beatroute.signal.internal

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Fire-and-forget eligibility client (F2-D10). Re-keyed to the event model
 * (F2-D3/D13): the request carries `{ event_name, user_id, context?, session_age_days? }`
 * (screen_id/client_id are gone).
 *
 * The response is kept as the RAW config JSON (GR-2): the native shell never parses
 * the full config — it only extracts `trigger_id` (for outbox idempotency + dismiss)
 * and forwards the untouched body into the bundled web-core.
 */
internal class EligibilityClient(
    private val baseUrl: HttpUrl,
    private val appKey: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(2, TimeUnit.SECONDS).build(),
) : EligibilitySource {
    override suspend fun check(
        eventName: String,
        userId: String,
        context: String?,
        sessionAgeDays: Int?,
    ): EligibilityResult? = withContext(Dispatchers.IO) {
        try {
            val url = baseUrl.newBuilder().addPathSegments("v1/sdk/eligibility")
                .addQueryParameter("event_name", eventName)
                .addQueryParameter("user_id", userId)
                .apply {
                    if (!context.isNullOrEmpty()) addQueryParameter("context", context)
                    if (sessionAgeDays != null) {
                        addQueryParameter("session_age_days", sessionAgeDays.toString())
                    }
                }
                .build()
            val req = Request.Builder().url(url).header("X-Signal-App-Key", appKey).get().build()
            client.newCall(req).execute().use { res ->
                if (res.code != 200) return@use null
                val body = res.body?.string() ?: return@use null
                EligibilityResult.from(body)
            }
        } catch (_: Throwable) {
            null // fire-and-forget: never surface a failure (F2-D10)
        }
    }
}
