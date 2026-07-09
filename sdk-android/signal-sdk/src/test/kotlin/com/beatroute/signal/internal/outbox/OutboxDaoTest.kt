package com.beatroute.signal.internal.outbox

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class OutboxDaoTest {

    private lateinit var db: OutboxDatabase
    private lateinit var dao: OutboxDao

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            OutboxDatabase::class.java,
        ).allowMainThreadQueries().build()
        dao = db.outboxDao()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun `enqueue then pending returns the item`() = runBlocking {
        val item = OutboxEntity(
            kind = "response",
            triggerId = "t1",
            payloadJson = "{\"a\":1}",
            createdAt = 100L,
        )
        dao.enqueue(item)

        val pending = dao.pending()
        assertEquals(1, pending.size)
        val stored = pending[0]
        assertEquals("response", stored.kind)
        assertEquals("t1", stored.triggerId)
        assertEquals("{\"a\":1}", stored.payloadJson)
        assertEquals(0, stored.attempts)
        assertEquals(100L, stored.createdAt)
    }

    @Test
    fun `pending orders by createdAt ascending`() = runBlocking {
        dao.enqueue(
            OutboxEntity(kind = "response", triggerId = "later", payloadJson = "{}", createdAt = 200L),
        )
        dao.enqueue(
            OutboxEntity(kind = "response", triggerId = "earlier", payloadJson = "{}", createdAt = 100L),
        )

        val pending = dao.pending()
        assertEquals(2, pending.size)
        assertEquals("earlier", pending[0].triggerId)
        assertEquals("later", pending[1].triggerId)
    }

    @Test
    fun `delete removes and incrementAttempts bumps count`() = runBlocking {
        dao.enqueue(
            OutboxEntity(kind = "response", triggerId = "t1", payloadJson = "{}", createdAt = 100L),
        )
        val id = dao.pending()[0].id

        dao.incrementAttempts(id)
        assertEquals(1, dao.pending()[0].attempts)

        dao.delete(id)
        assertEquals(0, dao.pending().size)
    }

    @Test
    fun `unique index on triggerId and kind prevents duplicate enqueue`() = runBlocking {
        // Distinct id values; conflict is on the unique (triggerId, kind) index, not the PK.
        dao.enqueue(
            OutboxEntity(id = 1, kind = "response", triggerId = "t1", payloadJson = "{\"v\":1}", createdAt = 100L),
        )
        dao.enqueue(
            OutboxEntity(id = 2, kind = "response", triggerId = "t1", payloadJson = "{\"v\":2}", createdAt = 200L),
        )

        val pending = dao.pending()
        assertEquals(1, pending.size)
        // The first (winning) row is retained; the second enqueue is ignored.
        assertEquals("{\"v\":1}", pending[0].payloadJson)
    }
}
