package com.beatroute.signal.internal

import android.content.Context
import android.os.Looper.getMainLooper
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.work.testing.WorkManagerTestInitHelper
import com.beatroute.signal.SessionProvider
import com.beatroute.signal.internal.outbox.OutboxDatabase
import com.beatroute.signal.internal.outbox.OutboxDependencies
import com.beatroute.signal.internal.outbox.OutboxEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The native side of the sheet bridge (docs/sheet-bridge-v1.md). Driving the JS<->native
 * boundary directly: a `SignalBridge.submit(json)` / `dismiss(json)` — the exact JSON
 * messages web-core emits over @JavascriptInterface — must land in the PRECIOUS outbox
 * (F2-D18) and record local suppression for `(eventName, userId)` (F2-D11).
 *
 * This is the unit-level replacement for the old native-sheet-to-outbox test: it proves
 * the bridge wiring + outbox path without a WebView. The visual sheet render is covered
 * by the web-core JS suite (the bundle is loaded as an asset by the fragment).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SignalBridgeTest {

    private lateinit var context: Context
    private lateinit var db: OutboxDatabase

    private val fixedNow = 1_700_000_000_000L

    private class FakeSession : SessionProvider {
        override fun userId(): String = "user-42"
        override fun clientId(): String = "client-7"
        override fun repTenureDays(): Int? = 90
    }

    private class FakeSuppressionStore : SuppressionStore {
        data class Record(val eventName: String, val userId: String, val nowMs: Long)

        val records = mutableListOf<Record>()
        override suspend fun isSuppressed(eventName: String, userId: String, nowMs: Long) = false
        override suspend fun recordInteraction(eventName: String, userId: String, nowMs: Long) {
            records.add(Record(eventName, userId, nowMs))
        }
    }

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        db = Room.inMemoryDatabaseBuilder(context, OutboxDatabase::class.java)
            .allowMainThreadQueries().build()
        OutboxDependencies.dao = db.outboxDao()
        // So Outbox.schedule() -> WorkManager.getInstance(context) doesn't throw.
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
    }

    @After
    fun tearDown() {
        db.close()
        OutboxDependencies.dao = null
        OutboxDependencies.feedback = null
    }

    private fun bridge(
        suppression: FakeSuppressionStore,
        eventName: String = "order_completion",
        triggerId: String = "trig-1",
    ): SignalBridge = SignalBridge(
        context = context,
        eventName = eventName,
        triggerId = triggerId,
        sessionProvider = FakeSession(),
        suppressionCache = suppression,
        clock = { fixedNow },
        // Unconfined so the enqueue coroutine runs synchronously on launch.
        scope = CoroutineScope(Dispatchers.Unconfined),
    )

    private fun awaitRows(): List<OutboxEntity> {
        repeat(50) {
            shadowOf(getMainLooper()).idle()
            val rows = runBlocking { db.outboxDao().pending() }
            if (rows.isNotEmpty()) return rows
            Thread.sleep(10)
        }
        return runBlocking { db.outboxDao().pending() }
    }

    private fun awaitSuppression(suppression: FakeSuppressionStore) {
        repeat(50) {
            shadowOf(getMainLooper()).idle()
            if (suppression.records.isNotEmpty()) return
            Thread.sleep(10)
        }
    }

    @Test
    fun `submit maps the web-core Answer into one response row and records suppression`() {
        val suppression = FakeSuppressionStore()
        // The exact SUBMIT JSON web-core emits over the bridge.
        val submitJson = """
            {
              "bridge_version": 1,
              "answer": {
                "trigger_id": "trig-1",
                "rating_value": 3,
                "positive": true,
                "other_text": null,
                "other_image_url": null
              }
            }
        """.trimIndent()

        bridge(suppression).submit(submitJson)

        val rows = awaitRows()
        assertEquals(1, rows.size)
        assertEquals("response", rows[0].kind)
        assertEquals("trig-1", rows[0].triggerId)
        val decoded = SignalJson.decodeFromString<ResponseBody>(rows[0].payloadJson)
        assertEquals("trig-1", decoded.triggerId)
        assertEquals(3, decoded.ratingValue)
        // The bridge patched session_age_days from the SessionProvider.
        assertEquals(90, decoded.sessionAgeDays)
        assertTrue(decoded.deviceOs.startsWith("Android"))

        awaitSuppression(suppression)
        assertEquals(1, suppression.records.size)
        assertEquals("order_completion", suppression.records[0].eventName)
        assertEquals("user-42", suppression.records[0].userId)
    }

    @Test
    fun `submit carries the negative branch free text and image url`() {
        val suppression = FakeSuppressionStore()
        val submitJson = """
            {
              "bridge_version": 1,
              "answer": {
                "trigger_id": "trig-9",
                "rating_value": 1,
                "positive": false,
                "other_text": "late delivery",
                "other_image_url": "https://cdn.example/x.jpg"
              }
            }
        """.trimIndent()

        bridge(suppression, triggerId = "trig-9").submit(submitJson)

        val rows = awaitRows()
        assertEquals(1, rows.size)
        val decoded = SignalJson.decodeFromString<ResponseBody>(rows[0].payloadJson)
        assertEquals("late delivery", decoded.otherText)
        assertEquals("https://cdn.example/x.jpg", decoded.otherImageUrl)
    }

    @Test
    fun `dismiss enqueues exactly one dismiss row and records suppression`() {
        val suppression = FakeSuppressionStore()

        bridge(suppression, triggerId = "trig-dismiss")
            .dismiss("""{"bridge_version":1,"reason":"backdrop"}""")

        val rows = awaitRows()
        assertEquals(1, rows.size)
        assertEquals("dismiss", rows[0].kind)
        val decoded = SignalJson.decodeFromString<DismissBody>(rows[0].payloadJson)
        assertEquals("trig-dismiss", decoded.triggerId)

        awaitSuppression(suppression)
        assertEquals(1, suppression.records.size)
        assertEquals("order_completion", suppression.records[0].eventName)
        assertEquals("user-42", suppression.records[0].userId)
    }

    @Test
    fun `config_invalid dismiss neither enqueues nor suppresses`() {
        val suppression = FakeSuppressionStore()

        bridge(suppression).dismiss("""{"bridge_version":1,"reason":"config_invalid"}""")

        // Give the (would-be) coroutine a chance to run, then assert nothing landed.
        repeat(20) {
            shadowOf(getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertEquals(0, runBlocking { db.outboxDao().pending() }.size)
        assertEquals(0, suppression.records.size)
    }

    @Test
    fun `malformed submit json is swallowed and never crashes`() {
        val suppression = FakeSuppressionStore()

        // Must not throw.
        bridge(suppression).submit("{ not valid json")

        repeat(10) {
            shadowOf(getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertEquals(0, runBlocking { db.outboxDao().pending() }.size)
    }
}
