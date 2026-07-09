package com.beatroute.signal.internal

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
internal data class EligibilityConfig(
    @SerialName("trigger_id") val triggerId: String,
    @SerialName("campaign_id") val campaignId: String,
    @SerialName("metric_type") val metricType: String,
    val header: String,
    @SerialName("rating_type") val ratingType: String, // star | emoji | effort_scale
    @SerialName("rating_scale_max") val ratingScaleMax: Int,
    @SerialName("positive_threshold") val positiveThreshold: Int,
    @SerialName("chips_on_negative") val chipsOnNegative: List<String>,
    @SerialName("other_requires_text") val otherRequiresText: Boolean,
    @SerialName("other_allows_image") val otherAllowsImage: Boolean,
    @SerialName("on_positive_action") val onPositiveAction: String, // none | play_store_review
    @SerialName("skip_enabled") val skipEnabled: Boolean,
)

@Serializable
internal data class ResponseBody(
    @SerialName("trigger_id") val triggerId: String,
    @SerialName("rating_value") val ratingValue: Int,
    @SerialName("chip_selected") val chipSelected: String? = null,
    @SerialName("other_text") val otherText: String? = null,
    @SerialName("other_image_url") val otherImageUrl: String? = null,
    @SerialName("device_os") val deviceOs: String,
    @SerialName("app_version") val appVersion: String,
    @SerialName("rep_tenure_days") val repTenureDays: Int? = null,
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
