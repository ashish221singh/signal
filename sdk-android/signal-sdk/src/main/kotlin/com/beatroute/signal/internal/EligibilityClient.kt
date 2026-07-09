package com.beatroute.signal.internal

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

internal class EligibilityClient(
    private val baseUrl: HttpUrl,
    private val appKey: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(2, TimeUnit.SECONDS).build(),
) : EligibilitySource {
    override suspend fun check(
        screenId: String,
        userId: String,
        clientId: String,
        repTenureDays: Int?,
    ): EligibilityConfig? = withContext(Dispatchers.IO) {
        try {
            val url = baseUrl.newBuilder().addPathSegments("v1/sdk/eligibility")
                .addQueryParameter("screen_id", screenId)
                .addQueryParameter("user_id", userId)
                .addQueryParameter("client_id", clientId)
                .apply {
                    if (repTenureDays != null) {
                        addQueryParameter("rep_tenure_days", repTenureDays.toString())
                    }
                }
                .build()
            val req = Request.Builder().url(url).header("X-Signal-App-Key", appKey).get().build()
            client.newCall(req).execute().use { res ->
                if (res.code != 200) return@use null
                val body = res.body?.string() ?: return@use null
                runCatching { SignalJson.decodeFromString<EligibilityConfig>(body) }.getOrNull()
            }
        } catch (_: Throwable) {
            null // fire-and-forget: never surface a failure (M3-D7)
        }
    }
}
