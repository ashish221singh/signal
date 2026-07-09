package com.beatroute.signal.internal

/**
 * The shared trigger evaluation flow, reused by every hook that can fire a sheet
 * (the action hook `trackEvent`, and the dwell hooks in Task D.2).
 *
 * Order matters:
 *  1. M3-D9 — consult the local suppression cache FIRST and short-circuit before
 *     touching the network (the 7-day floor is a safe minimum cooldown).
 *  2. M3-D10 — resolve identity from the host [SessionProvider] per call.
 *  3. Ask eligibility; a null result (204 / error) shows nothing.
 *  4. Otherwise present the sheet.
 *
 * Callers wrap this in `runCatching` (M3-D16) so a failure never escapes into the host.
 */
internal suspend fun runTrigger(s: SignalState, screenId: String) {
    val clientId = s.sessionProvider.clientId()
    val now = s.clock()
    // M3-D9 short-circuit: suppressed locally -> never hit the network.
    if (s.suppressionCache.isSuppressed(screenId, clientId, now)) return
    val userId = s.sessionProvider.userId()
    val repTenure = s.sessionProvider.repTenureDays()
    // 204 / error -> null -> show nothing.
    val config = s.eligibility.check(screenId, userId, clientId, repTenure) ?: return
    s.sheetPresenter.show(screenId, config)
}
