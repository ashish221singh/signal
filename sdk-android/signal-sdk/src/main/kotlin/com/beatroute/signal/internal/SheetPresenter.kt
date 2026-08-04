package com.beatroute.signal.internal

/**
 * Presents the feedback sheet (a WebView hosting the bundled web-core) for a resolved
 * [EligibilityResult]. [eventName] is the trigger that fired, used as the suppression
 * subject alongside the resolved user id.
 *
 * Extracted as an interface so the trigger flow can be driven with a fake in tests.
 * The real, WebView-showing presenter is [WebSheetPresenter].
 */
internal interface SheetPresenter {
    fun show(eventName: String, result: EligibilityResult)
}

/**
 * Placeholder presenter, kept as a harmless fallback for tests that don't need the
 * real WebView-showing presenter. Production wiring uses [WebSheetPresenter].
 */
internal object NoOpSheetPresenter : SheetPresenter {
    override fun show(eventName: String, result: EligibilityResult) {}
}

/**
 * Test seam over [EligibilityClient] so the trigger flow can be faked. Re-keyed to
 * the event model (F2-D3/D13): `{ event_name, user_id, context?, session_age_days? }`.
 */
internal interface EligibilitySource {
    suspend fun check(
        eventName: String,
        userId: String,
        context: String?,
        sessionAgeDays: Int?,
    ): EligibilityResult?
}

/**
 * Test seam over [LocalSuppressionCache] so the trigger flow can be faked. The
 * suppression subject is now `(eventName, userId)` (F2-D3/D9): events replace screens,
 * and the resolved user id is the stable cooldown subject.
 */
internal interface SuppressionStore {
    suspend fun isSuppressed(eventName: String, userId: String, nowMs: Long): Boolean
    suspend fun recordInteraction(eventName: String, userId: String, nowMs: Long)
}
