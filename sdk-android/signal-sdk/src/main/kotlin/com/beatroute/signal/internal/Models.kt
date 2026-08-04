package com.beatroute.signal.internal

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The result of an eligibility check that the shell forwards to the bundled web-core.
 *
 * Per the sheet bridge contract (docs/sheet-bridge-v1.md, GR-2), the native shell
 * NEVER parses the full config — it can't consume the TS contracts and must stay
 * forward-compatible with fields it doesn't understand. So it keeps the config as
 * the **raw JSON** returned by `/v1/sdk/eligibility` and relays it as-is into the
 * WebView. The only field the shell itself needs is [triggerId] — the idempotency
 * key for the precious outbox and the subject of a `dismiss` report.
 */
internal data class EligibilityResult(
    val triggerId: String,
    /** The raw eligibility config JSON, forwarded verbatim into web-core. */
    val rawConfigJson: String,
) {
    companion object {
        /**
         * Parse only the `trigger_id` out of a raw config body, keeping the body
         * itself untouched for forwarding. Returns null when the body isn't an
         * object or has no string `trigger_id` (fail-silent — no sheet).
         */
        fun from(rawConfigJson: String): EligibilityResult? {
            val obj = runCatching {
                SignalJson.decodeFromString<JsonObject>(rawConfigJson)
            }.getOrNull() ?: return null
            val triggerId = runCatching {
                obj["trigger_id"]?.jsonPrimitive?.content
            }.getOrNull() ?: return null
            return EligibilityResult(triggerId, rawConfigJson)
        }
    }
}

/**
 * The wire response body (contracts `responseBodySchema`). web-core's transport-agnostic
 * `Answer` (trigger_id, rating_value, other_text?, other_image_url?) is mapped onto this
 * by the bridge, which adds the fields the shell owns (device_os, app_version,
 * session_age_days, shown_at/responded_at). Re-keyed to `session_age_days` (F2-D3/D13).
 */
@Serializable
internal data class ResponseBody(
    @SerialName("trigger_id") val triggerId: String,
    @SerialName("rating_value") val ratingValue: Int,
    @SerialName("other_text") val otherText: String? = null,
    @SerialName("other_image_url") val otherImageUrl: String? = null,
    @SerialName("device_os") val deviceOs: String,
    @SerialName("app_version") val appVersion: String,
    @SerialName("session_age_days") val sessionAgeDays: Int? = null,
    @SerialName("shown_at") val shownAt: String,
    @SerialName("responded_at") val respondedAt: String,
)

@Serializable
internal data class DismissBody(
    @SerialName("trigger_id") val triggerId: String,
    @SerialName("shown_at") val shownAt: String,
    @SerialName("dismissed_at") val dismissedAt: String,
)

@Serializable
internal data class ErrorBody(
    val error: ErrorDetail,
)

@Serializable
internal data class ErrorDetail(
    val code: String,
    val message: String,
)
