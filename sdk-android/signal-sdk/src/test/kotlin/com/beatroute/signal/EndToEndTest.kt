package com.beatroute.signal

import android.app.Application
import android.os.Bundle
import android.os.Looper.getMainLooper
import androidx.appcompat.app.AppCompatActivity
import androidx.test.core.app.ApplicationProvider
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import com.beatroute.signal.internal.ResponseBody
import com.beatroute.signal.internal.SignalJson
import com.beatroute.signal.internal.outbox.OutboxDependencies
import com.beatroute.signal.internal.outbox.OutboxEntity
import com.beatroute.signal.internal.outbox.OutboxWorker
import com.beatroute.signal.ui.SignalBottomSheetFragment
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Milestone 3 exit proof (Task H.1): the WHOLE Signal loop against a real
 * [MockWebServer], driven through the REAL `Signal.init` wiring — a real
 * [com.beatroute.signal.internal.EligibilityClient], the real
 * [com.beatroute.signal.internal.SignalSheetPresenter] (shows the real
 * [SignalBottomSheetFragment] via the [com.beatroute.signal.internal.ActivityTracker]
 * registered on the Application), the real Room outbox, the real
 * [com.beatroute.signal.internal.LocalSuppressionCache] (DataStore), and the real
 * [OutboxWorker]. Nothing is faked except the host [SessionProvider] and the network
 * peer (the mock server).
 *
 * trackEvent -> eligibility GET -> sheet shown -> submit -> outbox row -> worker
 * flush -> POST /response -> row cleared -> a second trackEvent is short-circuited by
 * local suppression (no second eligibility GET).
 *
 * DRIVING SUBMIT: the one place we do not drive raw widgets is the submit tap. Raw
 * widget taps under Robolectric are fragile, so — exactly as the G.3 / earlier UI
 * tests did — we invoke the shown fragment's installed `onSubmit` bridge directly with
 * an assembled positive [ResponseBody]. That callback IS the real submit bridge: the
 * presenter installs it in `show(...)`, so calling it exercises the real
 * presenter -> outbox -> suppression path end to end. Everything else (init wiring,
 * eligibility HTTP, fragment show, worker flush, POST HTTP, suppression short-circuit)
 * runs through the genuine production code.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class EndToEndTest {

    /** A Material3/AppCompat-themed host so the BottomSheetDialogFragment can inflate. */
    class HostActivity : AppCompatActivity() {
        override fun onCreate(savedInstanceState: Bundle?) {
            setTheme(com.beatroute.signal.R.style.Theme_Signal)
            super.onCreate(savedInstanceState)
        }
    }

    /** The fixture's trigger_id — the config that eligibility hands back. */
    private val fixtureTriggerId = "11111111-1111-4111-8111-111111111111"

    private lateinit var server: MockWebServer
    private lateinit var app: Application
    private lateinit var activity: HostActivity

    /** Counts eligibility GETs seen by the mock, so step 5 can prove no second call. */
    private val eligibilityGets = AtomicInteger(0)

    /** Host-owned identity; the only real collaborator we substitute. */
    private class FakeSession : SessionProvider {
        override fun userId(): String = "user-42"
        override fun clientId(): String = "client-7"
        override fun repTenureDays(): Int? = 90
    }

    private fun fixture(name: String): String =
        EndToEndTest::class.java.getResourceAsStream("/fixtures/$name")!!
            .bufferedReader().readText()

    @After
    fun tearDown() {
        Signal.resetForTest()
        server.shutdown()
        OutboxDependencies.dao = null
        OutboxDependencies.feedback = null
    }

    /**
     * Bounded await: drain the main looper (where the SDK scope's
     * Dispatchers.Main.immediate continuations resume) and poll [condition] up to ~50x
     * with a short real sleep between tries, so genuine async completes but a real
     * wiring failure still fails the test instead of hanging.
     */
    private fun awaitTrue(condition: () -> Boolean): Boolean {
        repeat(50) {
            shadowOf(getMainLooper()).idle()
            if (condition()) return true
            Thread.sleep(10)
        }
        shadowOf(getMainLooper()).idle()
        return condition()
    }

    private fun pending(): List<OutboxEntity> =
        runBlocking { OutboxDependencies.dao!!.pending() }

    @Test
    fun `full loop trackEvent to sheet to submit to outbox flush, then suppressed`() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    request.method == "GET" && path.startsWith("/v1/sdk/eligibility") -> {
                        eligibilityGets.incrementAndGet()
                        MockResponse().setResponseCode(200)
                            .setBody(fixture("eligibility_config.json"))
                    }
                    request.method == "POST" && path.startsWith("/v1/sdk/response") ->
                        MockResponse().setResponseCode(204)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()

        app = ApplicationProvider.getApplicationContext()

        // Ordering: init FIRST so the ActivityTracker registers on the Application,
        // THEN resume the host so the tracker captures the resumed FragmentActivity.
        Signal.init(
            context = app,
            environment = SignalEnvironment.STAGING,
            sessionProvider = FakeSession(),
            baseUrlOverride = server.url("/").toString(),
            appKeyOverride = "e2e-key",
        )
        // The presenter's submit path calls Outbox.enqueueAndSchedule ->
        // WorkManager.getInstance(app); initialize the test WorkManager so it resolves.
        WorkManagerTestInitHelper.initializeTestWorkManager(app)

        activity = Robolectric.buildActivity(HostActivity::class.java).setup().get()

        // ---- Step 1: trackEvent -> real eligibility GET ----
        Signal.trackEvent("order_completion")

        assertTrue(
            "expected an eligibility GET after trackEvent",
            awaitTrue { eligibilityGets.get() >= 1 },
        )
        val eligibilityReq = server.takeRequest(2, TimeUnit.SECONDS)!!
        assertEquals("GET", eligibilityReq.method)
        assertTrue(eligibilityReq.path!!.startsWith("/v1/sdk/eligibility"))
        assertEquals("e2e-key", eligibilityReq.getHeader("X-Signal-App-Key"))
        val eligibilityUrl = eligibilityReq.requestUrl!!
        assertEquals("order_completion", eligibilityUrl.queryParameter("screen_id"))
        assertEquals("user-42", eligibilityUrl.queryParameter("user_id"))
        assertEquals("client-7", eligibilityUrl.queryParameter("client_id"))
        assertEquals("90", eligibilityUrl.queryParameter("rep_tenure_days"))

        // ---- Step 2: the sheet fragment is shown on the host ----
        assertTrue(
            "expected the signal_sheet fragment to be shown",
            awaitTrue {
                activity.supportFragmentManager.findFragmentByTag("signal_sheet") != null
            },
        )
        val fragment = activity.supportFragmentManager
            .findFragmentByTag("signal_sheet") as? SignalBottomSheetFragment
        assertNotNull("shown fragment should be a SignalBottomSheetFragment", fragment)

        // ---- Step 3: drive a POSITIVE submit through the installed bridge ----
        // Direct callback invocation of the presenter-installed onSubmit bridge (see
        // class doc). rating_value 5 >= positive_threshold 4 -> positive.
        fragment!!.onSubmit!!.invoke(
            ResponseBody(
                triggerId = fixtureTriggerId,
                ratingValue = 5,
                deviceOs = "Android 13",
                appVersion = "1.0.0",
                shownAt = "2026-07-09T10:00:00Z",
                respondedAt = "2026-07-09T10:00:05Z",
            ),
        )

        assertTrue(
            "expected exactly one response row in the outbox after submit",
            awaitTrue { pending().size == 1 },
        )
        val rows = pending()
        assertEquals(1, rows.size)
        assertEquals("response", rows[0].kind)
        assertEquals(fixtureTriggerId, rows[0].triggerId)
        val enqueued = SignalJson.decodeFromString<ResponseBody>(rows[0].payloadJson)
        assertEquals(fixtureTriggerId, enqueued.triggerId)
        assertEquals(5, enqueued.ratingValue)
        // The presenter patched rep tenure from the SessionProvider.
        assertEquals(90, enqueued.repTenureDays)

        // ---- Step 4: run the real worker -> POST /response -> row cleared ----
        val worker = TestListenableWorkerBuilder<OutboxWorker>(app).build()
        val result = runBlocking { worker.doWork() }
        assertEquals(ListenableWorker.Result.success(), result)

        val responseReq = server.takeRequest(2, TimeUnit.SECONDS)!!
        assertEquals("POST", responseReq.method)
        assertTrue(responseReq.path!!.startsWith("/v1/sdk/response"))
        assertEquals("e2e-key", responseReq.getHeader("X-Signal-App-Key"))
        val postedBody = SignalJson.decodeFromString<ResponseBody>(responseReq.body.readUtf8())
        assertEquals(fixtureTriggerId, postedBody.triggerId)
        assertEquals(5, postedBody.ratingValue)

        assertTrue(
            "outbox should be empty after a successful flush",
            awaitTrue { pending().isEmpty() },
        )

        // ---- Step 5: a second trackEvent is short-circuited by local suppression ----
        // The submit records local suppression for (order_completion, client-7) at the real
        // clock's "now", but that write happens in the presenter's launched coroutine AFTER
        // the outbox enqueue (which we already awaited). Wait until the SDK's OWN real
        // LocalSuppressionCache actually reports the pair as suppressed before firing the
        // second trackEvent — otherwise we'd race the DataStore write. This queries the exact
        // cache instance Signal.init built (via the internal SignalState), so it's deterministic.
        val realCache = Signal.state!!.suppressionCache
        assertTrue(
            "the submit should have recorded local suppression for the pair",
            awaitTrue {
                runBlocking {
                    realCache.isSuppressed("order_completion", "client-7", System.currentTimeMillis())
                }
            },
        )

        // The 7-day floor means a second trackEvent must never reach the network. Capture the
        // eligibility count, fire again, and assert it is unchanged.
        val getsBeforeSecond = eligibilityGets.get()
        Signal.trackEvent("order_completion")
        // Give the flow room to (not) run: idle + poll, then assert no new GET happened.
        repeat(20) {
            shadowOf(getMainLooper()).idle()
            Thread.sleep(10)
        }
        assertEquals(
            "suppression must short-circuit eligibility on the second trackEvent",
            getsBeforeSecond,
            eligibilityGets.get(),
        )
        // No further request should be queued for the mock either.
        assertNull(server.takeRequest(500, TimeUnit.MILLISECONDS))
    }
}
