package com.beatroute.signal

/**
 * Selects the Signal backend an integrator talks to (M3-D12).
 *
 * The environment fixes both the base URL and the app key, so a debug host
 * build simply picks [STAGING] and is wired end-to-end with no extra config.
 *
 * NOTE: the base URLs and app keys below are DOCUMENTED PLACEHOLDERS. The real
 * values come from BeatRoute infra at integration time — the `.example` hosts and
 * the `STAGING_APP_KEY` / `PROD_APP_KEY` literals are intentionally fake and must
 * be replaced (or supplied via the override params on [Signal.init]) before ship.
 */
enum class SignalEnvironment(
    internal val baseUrl: String,
    internal val appKey: String,
) {
    STAGING("https://staging.signal.beatroute.example/", "STAGING_APP_KEY"),
    PRODUCTION("https://signal.beatroute.example/", "PROD_APP_KEY"),
}
