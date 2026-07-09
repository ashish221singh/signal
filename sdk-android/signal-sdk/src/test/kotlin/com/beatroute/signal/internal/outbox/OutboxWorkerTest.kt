package com.beatroute.signal.internal.outbox

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import com.beatroute.signal.internal.DismissBody
import com.beatroute.signal.internal.FeedbackSender
import com.beatroute.signal.internal.ResponseBody
import com.beatroute.signal.internal.SendResult
import com.beatroute.signal.internal.SignalJson
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class OutboxWorkerTest {

    private lateinit var db: OutboxDatabase
    private lateinit var dao: OutboxDao
    private lateinit var context: Context

    /** Records every send and answers with a canned result. */
    private class FakeSender(private val result: SendResult) : FeedbackSender {
        var responseSends = 0
        var dismissSends = 0
        override suspend fun postResponse(body: ResponseBody): SendResult {
            responseSends++
            return result
        }

        override suspend fun postDismiss(body: DismissBody): SendResult {
            dismissSends++
            return result
        }
    }

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        db = Room.inMemoryDatabaseBuilder(context, OutboxDatabase::class.java)
            .allowMainThreadQueries().build()
        dao = db.outboxDao()
        OutboxDependencies.dao = dao
    }

    @After
    fun tearDown() {
        db.close()
        OutboxDependencies.dao = null
        OutboxDependencies.feedback = null
    }

    private fun responseJson(triggerId: String): String = SignalJson.encodeToString(
        ResponseBody(
            triggerId = triggerId,
            ratingValue = 5,
            deviceOs = "android-33",
            appVersion = "1.0.0",
            shownAt = "2026-07-09T10:00:00Z",
            respondedAt = "2026-07-09T10:00:05Z",
        ),
    )

    private fun enqueueResponse(triggerId: String, createdAt: Long = 100L) = runBlocking {
        dao.enqueue(
            OutboxEntity(
                kind = "response",
                triggerId = triggerId,
                payloadJson = responseJson(triggerId),
                createdAt = createdAt,
            ),
        )
    }

    private fun buildWorker(): OutboxWorker =
        TestListenableWorkerBuilder<OutboxWorker>(context).build()

    @Test
    fun `success deletes the row`() = runBlocking {
        OutboxDependencies.feedback = FakeSender(SendResult.Success)
        enqueueResponse("t1")

        val result = buildWorker().doWork()

        assertEquals(ListenableWorker.Result.success(), result)
        assertTrue(dao.pending().isEmpty())
    }

    @Test
    fun `retryable failure keeps the row and increments attempts and retries`() = runBlocking {
        OutboxDependencies.feedback = FakeSender(SendResult.RetryableFailure)
        enqueueResponse("t1")

        val result = buildWorker().doWork()

        assertEquals(ListenableWorker.Result.retry(), result)
        val pending = dao.pending()
        assertEquals(1, pending.size)
        assertEquals(1, pending[0].attempts)
    }

    @Test
    fun `drop consumes the row and succeeds`() = runBlocking {
        OutboxDependencies.feedback = FakeSender(SendResult.Drop)
        enqueueResponse("t1")

        val result = buildWorker().doWork()

        assertEquals(ListenableWorker.Result.success(), result)
        assertTrue(dao.pending().isEmpty())
    }

    @Test
    fun `two items are both processed in one run`() = runBlocking {
        val fake = FakeSender(SendResult.Success)
        OutboxDependencies.feedback = fake
        enqueueResponse("t1", createdAt = 100L)
        enqueueResponse("t2", createdAt = 200L)

        val result = buildWorker().doWork()

        assertEquals(ListenableWorker.Result.success(), result)
        assertTrue(dao.pending().isEmpty())
        assertEquals(2, fake.responseSends)
    }

    @Test
    fun `replaying an already-sent triggerId is harmless`() = runBlocking {
        // Backend dedups on trigger_id -> 204 Success even on replay.
        OutboxDependencies.feedback = FakeSender(SendResult.Success)
        enqueueResponse("t1")

        // First run sends + cleans up.
        assertEquals(ListenableWorker.Result.success(), buildWorker().doWork())
        assertTrue(dao.pending().isEmpty())

        // Re-enqueue the same payload and run again -> still Success, no error.
        enqueueResponse("t1")
        val second = buildWorker().doWork()
        assertEquals(ListenableWorker.Result.success(), second)
        assertTrue(dao.pending().isEmpty())
    }
}
