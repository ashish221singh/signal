package com.beatroute.signal.internal

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import kotlinx.coroutines.flow.first

/**
 * DataStore-backed local suppression cache (M3-D9).
 *
 * OPTIMIZATION ONLY, never authoritative. After any completed interaction for a
 * `(screenId, clientId)` pair, this short-circuits eligibility calls for a 7-day
 * local floor — the minimum real server cooldown. The backend's atomic claim
 * remains the source of truth: a 7-day floor can never suppress a legitimate ask
 * early (min real cooldown is 7 days), and under-caching only costs one harmless 204.
 */
internal class LocalSuppressionCache(
    private val dataStore: DataStore<Preferences>,
) {
    private fun key(screenId: String, clientId: String) =
        longPreferencesKey("$screenId|$clientId")

    /** Records a completed interaction at [nowMs] for the given pair. */
    suspend fun recordInteraction(screenId: String, clientId: String, nowMs: Long) {
        dataStore.edit { prefs -> prefs[key(screenId, clientId)] = nowMs }
    }

    /**
     * Returns true iff a prior interaction is recorded for the pair and it falls
     * within the 7-day suppression floor relative to [nowMs]. Missing key -> false.
     */
    suspend fun isSuppressed(screenId: String, clientId: String, nowMs: Long): Boolean {
        val stored = dataStore.data.first()[key(screenId, clientId)]
        return stored != null && (nowMs - stored) < SUPPRESS_FLOOR_MS
    }

    companion object {
        /** Minimum server cooldown; the local floor never exceeds this. */
        const val SUPPRESS_FLOOR_MS = 7L * 24 * 3600 * 1000

        /** Builds the real, Context-backed DataStore for production use. */
        fun create(context: Context): LocalSuppressionCache {
            val store = PreferenceDataStoreFactory.create {
                context.preferencesDataStoreFile("signal_suppression")
            }
            return LocalSuppressionCache(store)
        }
    }
}
