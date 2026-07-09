package com.beatroute.signal.internal

/**
 * Displays the feedback sheet for a resolved [EligibilityConfig].
 *
 * Extracted as an interface so the trigger flow can be driven with a fake in
 * tests. The real, fragment-showing presenter is wired in Task G.3.
 */
internal interface SheetPresenter {
    fun show(screenId: String, config: EligibilityConfig)
}

/**
 * Placeholder presenter, kept as a harmless fallback for tests that don't need the
 * real fragment-showing presenter. Production wiring uses [SignalSheetPresenter].
 */
internal object NoOpSheetPresenter : SheetPresenter {
    override fun show(screenId: String, config: EligibilityConfig) {}
}

/**
 * Test seam over [EligibilityClient] so the trigger flow can be faked.
 */
internal interface EligibilitySource {
    suspend fun check(
        screenId: String,
        userId: String,
        clientId: String,
        repTenureDays: Int?,
    ): EligibilityConfig?
}

/**
 * Test seam over [LocalSuppressionCache] so the trigger flow can be faked.
 */
internal interface SuppressionStore {
    suspend fun isSuppressed(screenId: String, clientId: String, nowMs: Long): Boolean
    suspend fun recordInteraction(screenId: String, clientId: String, nowMs: Long)
}
