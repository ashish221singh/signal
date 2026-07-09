package com.beatroute.signal.internal

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class LocalSuppressionCacheTest {

    private lateinit var tempFile: File
    private lateinit var dataStore: DataStore<Preferences>
    private lateinit var cache: LocalSuppressionCache

    private val dayMs = 24L * 3600 * 1000
    private val now = 1_700_000_000_000L

    @Before
    fun setUp() {
        // Unique temp file per test so DataStore state is never shared between tests.
        tempFile = File.createTempFile("signal_suppression_${UUID.randomUUID()}", ".preferences_pb")
        tempFile.delete() // DataStore creates/manages the file itself
        dataStore = PreferenceDataStoreFactory.create { tempFile }
        cache = LocalSuppressionCache(dataStore)
    }

    @After
    fun tearDown() {
        tempFile.delete()
    }

    @Test
    fun `unknown key is not suppressed`() = runBlocking {
        assertFalse(cache.isSuppressed("delivery", "c1", now))
    }

    @Test
    fun `suppressed within 7-day floor at 6 days`() = runBlocking {
        cache.recordInteraction("delivery", "c1", now)
        assertTrue(cache.isSuppressed("delivery", "c1", now + 6 * dayMs))
    }

    @Test
    fun `not suppressed past 7-day floor at 8 days`() = runBlocking {
        cache.recordInteraction("delivery", "c1", now)
        assertFalse(cache.isSuppressed("delivery", "c1", now + 8 * dayMs))
    }

    @Test
    fun `different key is independent`() = runBlocking {
        cache.recordInteraction("delivery", "c1", now)
        // A different screenId+clientId must not be suppressed by the above recording.
        assertFalse(cache.isSuppressed("delivery", "c2", now + 6 * dayMs))
        assertFalse(cache.isSuppressed("payment", "c1", now + 6 * dayMs))
    }
}
