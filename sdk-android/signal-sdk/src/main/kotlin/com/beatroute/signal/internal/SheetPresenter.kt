package com.beatroute.signal.internal

/**
 * Displays the feedback sheet for a resolved [EligibilityConfig].
 *
 * Extracted as an interface so the trigger flow can be driven with a fake in
 * tests. The real, fragment-showing presenter is wired in Task G.3.
 */
internal interface SheetPresenter {
    fun show(config: EligibilityConfig)
}

/**
 * Placeholder presenter used until the real fragment-showing presenter lands.
 */
// TODO(G.3): replace with the real fragment-showing presenter.
internal object NoOpSheetPresenter : SheetPresenter {
    override fun show(config: EligibilityConfig) {}
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
