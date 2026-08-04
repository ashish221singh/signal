package com.beatroute.signal.internal

/**
 * The shared trigger evaluation flow, reused by the action hook `trackEvent`.
 *
 * Order matters:
 *  1. F2-D11 — consult the local suppression cache FIRST and short-circuit before
 *     touching the network (the 7-day floor is a safe minimum cooldown).
 *  2. F2-D3 — resolve identity from the host [com.beatroute.signal.SessionProvider]
 *     per call; the resolved user id is both the eligibility subject and the
 *     suppression subject.
 *  3. Ask eligibility; a null result (204 / error) shows nothing (fail-silent, F2-D10).
 *  4. Otherwise present the sheet (a WebView hosting the bundled web-core), forwarding
 *     the raw config JSON untouched (GR-2).
 *
 * Callers wrap this in `runCatching` (F2-D10) so a failure never escapes into the host.
 */
internal suspend fun runTrigger(s: SignalState, eventName: String) {
    val userId = s.sessionProvider.userId()
    val now = s.clock()
    // F2-D11 short-circuit: suppressed locally -> never hit the network.
    if (s.suppressionCache.isSuppressed(eventName, userId, now)) return
    val sessionAgeDays = s.sessionProvider.repTenureDays()
    // 204 / error -> null -> show nothing.
    val result = s.eligibility.check(eventName, userId, context = null, sessionAgeDays) ?: return
    s.sheetPresenter.show(eventName, result)
}
