package com.beatroute.signal.internal

import android.content.Context
import android.os.Looper.getMainLooper
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.FragmentManager
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.work.testing.WorkManagerTestInitHelper
import com.beatroute.signal.R
import com.beatroute.signal.SessionProvider
import com.beatroute.signal.internal.outbox.OutboxDatabase
import com.beatroute.signal.internal.outbox.OutboxDependencies
import com.beatroute.signal.ui.SignalBottomSheetFragment
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Task G.3 integration: [SignalSheetPresenter] must show the sheet on the host's
 * FragmentManager and route the sheet's submit / dismiss into the PRECIOUS outbox
 * (M3-D7) plus record local suppression (M3-D9).
 *
 * Driving submit/dismiss: rather than fight the real widget UI (which is fragile
 * under Robolectric), we invoke the shown fragment's `onSubmit` / `onDismiss`
 * callbacks directly. Those callbacks ARE the exact bridge under test — the
 * presenter installs them in `show(...)`, so calling them exercises the real
 * enqueue + suppression path end to end.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SheetToOutboxTest {

    /** A Material3/AppCompat-themed host so the BottomSheetDialogFragment can inflate. */
    class HostActivity : AppCompatActivity() {
        override fun onCreate(savedInstanceState: Bundle?) {
            setTheme(R.style.Theme_Signal)
            super.onCreate(savedInstanceState)
        }
    }

    private lateinit var context: Context
    private lateinit var db: OutboxDatabase
    private lateinit var activity: HostActivity
    private lateinit var fm: FragmentManager

    private val fixedNow = 1_700_000_000_000L

    private class FakeSession(
        private val clientId: String = "client-7",
        private val repTenure: Int? = 90,
    ) : SessionProvider {
        override fun userId(): String = "user-42"
        override fun clientId(): String = clientId
        override fun repTenureDays(): Int? = repTenure
    }

    private class FakeSuppressionStore : SuppressionStore {
        data class Record(val screenId: String, val clientId: String, val nowMs: Long)

        val records = mutableListOf<Record>()
        override suspend fun isSuppressed(screenId: String, clientId: String, nowMs: Long) = false
        override suspend fun recordInteraction(screenId: String, clientId: String, nowMs: Long) {
            records.add(Record(screenId, clientId, nowMs))
        }
    }

    private class FakeSender : FeedbackSender {
        override suspend fun postResponse(body: ResponseBody): SendResult = SendResult.Success
        override suspend fun postDismiss(body: DismissBody): SendResult = SendResult.Success
    }

    private fun config(triggerId: String = "trig-1") = EligibilityConfig(
        triggerId = triggerId,
        campaignId = "camp-1",
        metricType = "csat",
        header = "How was it?",
        ratingType = "star",
        ratingScaleMax = 5,
        positiveThreshold = 4,
        chipsOnNegative = listOf("Slow"),
        otherRequiresText = true,
        otherAllowsImage = true,
        onPositiveAction = "none",
        skipEnabled = true,
    )

    private class NoopUploader : ImageUploader {
        override suspend fun upload(bytes: ByteArray, contentType: String): String? = null
    }

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        db = Room.inMemoryDatabaseBuilder(context, OutboxDatabase::class.java)
            .allowMainThreadQueries().build()
        OutboxDependencies.dao = db.outboxDao()
        OutboxDependencies.feedback = FakeSender()
        // So Outbox.schedule() -> WorkManager.getInstance(context) doesn't throw.
        WorkManagerTestInitHelper.initializeTestWorkManager(context)

        activity = Robolectric.buildActivity(HostActivity::class.java)
            .setup().get()
        fm = activity.supportFragmentManager
    }

    @After
    fun tearDown() {
        db.close()
        OutboxDependencies.dao = null
        OutboxDependencies.feedback = null
    }

    private fun buildPresenter(
        suppression: FakeSuppressionStore,
        session: SessionProvider = FakeSession(),
    ): SignalSheetPresenter = SignalSheetPresenter(
        context = context,
        sessionProvider = session,
        suppressionCache = suppression,
        clock = { fixedNow },
        // Unconfined so the enqueue coroutine runs synchronously on launch.
        scope = CoroutineScope(Dispatchers.Unconfined),
        imageUploader = NoopUploader(),
        host = FragmentHostProvider { fm },
    )

    private fun shownFragment(): SignalBottomSheetFragment {
        shadowOf(getMainLooper()).idle()
        return fm.findFragmentByTag("signal_sheet") as SignalBottomSheetFragment
    }

    /**
     * The enqueue runs in a launched coroutine whose Room writes hop to Room's own
     * executor; drain the main looper (where the Unconfined continuations resume)
     * until the outbox row lands, with a bounded wait so a real failure still fails.
     */
    private fun awaitRows(): List<com.beatroute.signal.internal.outbox.OutboxEntity> {
        repeat(50) {
            shadowOf(getMainLooper()).idle()
            val rows = runBlocking { db.outboxDao().pending() }
            if (rows.isNotEmpty()) return rows
            Thread.sleep(10)
        }
        return runBlocking { db.outboxDao().pending() }
    }

    /** Suppression is recorded after the enqueue in the same coroutine; wait for it. */
    private fun awaitSuppression(suppression: FakeSuppressionStore) {
        repeat(50) {
            shadowOf(getMainLooper()).idle()
            if (suppression.records.isNotEmpty()) return
            Thread.sleep(10)
        }
    }

    @Test
    fun `showing displays the sheet fragment on the host FragmentManager`() {
        val suppression = FakeSuppressionStore()
        buildPresenter(suppression).show("delivery", config("trig-show"))

        shadowOf(getMainLooper()).idle()
        val fragment = fm.findFragmentByTag("signal_sheet")
        assertNotNull(fragment)
        assertTrue(fragment is SignalBottomSheetFragment)
        assertTrue(fragment is androidx.fragment.app.DialogFragment)
    }

    @Test
    fun `submit enqueues exactly one response row and records suppression`() = runBlocking {
        val suppression = FakeSuppressionStore()
        buildPresenter(suppression).show("delivery", config("trig-resp"))

        val fragment = shownFragment()
        // Drive the exact submit bridge the presenter installed.
        fragment.onSubmit?.invoke(
            ResponseBody(
                triggerId = "trig-resp",
                ratingValue = 5,
                deviceOs = "Android 13",
                appVersion = "1.0.0",
                shownAt = "2026-07-09T10:00:00Z",
                respondedAt = "2026-07-09T10:00:05Z",
            ),
        )

        val rows = awaitRows()
        assertEquals(1, rows.size)
        assertEquals("response", rows[0].kind)
        val decoded = SignalJson.decodeFromString<ResponseBody>(rows[0].payloadJson)
        assertEquals("trig-resp", decoded.triggerId)
        assertEquals(5, decoded.ratingValue)
        // Presenter patched tenure from the SessionProvider.
        assertEquals(90, decoded.repTenureDays)

        awaitSuppression(suppression)
        assertEquals(1, suppression.records.size)
        assertEquals("delivery", suppression.records[0].screenId)
        assertEquals("client-7", suppression.records[0].clientId)
    }

    @Test
    fun `dismiss enqueues exactly one dismiss row and records suppression`() = runBlocking {
        val suppression = FakeSuppressionStore()
        buildPresenter(suppression).show("delivery", config("trig-dismiss"))

        val fragment = shownFragment()
        fragment.onDismiss?.invoke()

        val rows = awaitRows()
        assertEquals(1, rows.size)
        assertEquals("dismiss", rows[0].kind)
        val decoded = SignalJson.decodeFromString<DismissBody>(rows[0].payloadJson)
        assertEquals("trig-dismiss", decoded.triggerId)

        awaitSuppression(suppression)
        assertEquals(1, suppression.records.size)
        assertEquals("delivery", suppression.records[0].screenId)
        assertEquals("client-7", suppression.records[0].clientId)
    }
}
