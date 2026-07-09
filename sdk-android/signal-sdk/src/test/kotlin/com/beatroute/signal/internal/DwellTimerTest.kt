package com.beatroute.signal.internal

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * DwellTimer in isolation under virtual time (StandardTestDispatcher): the launched
 * coroutine's `delay` is scheduled on the test scheduler, so `advanceTimeBy` /
 * `advanceUntilIdle` make dwell timing exact and deterministic — no real clock, no network.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DwellTimerTest {

    private class FakeFire {
        val count = AtomicInteger(0)
        var lastScreenId: String? = null
        suspend fun fire(screenId: String) {
            count.incrementAndGet()
            lastScreenId = screenId
        }
    }

    @Test
    fun `dwell past threshold fires once with the screenId`() = runTest {
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
        val fake = FakeFire()
        val timer = DwellTimer(scope, DEFAULT_DWELL_MS, fake::fire)

        timer.enter("a")
        advanceTimeBy(DEFAULT_DWELL_MS + 1)
        advanceUntilIdle()

        assertEquals(1, fake.count.get())
        assertEquals("a", fake.lastScreenId)
    }

    @Test
    fun `exit before threshold cancels and never fires`() = runTest {
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
        val fake = FakeFire()
        val timer = DwellTimer(scope, DEFAULT_DWELL_MS, fake::fire)

        timer.enter("a")
        advanceTimeBy(DEFAULT_DWELL_MS - 1000)
        timer.exit("a")
        advanceUntilIdle()

        assertEquals(0, fake.count.get())
        assertNull(fake.lastScreenId)
    }

    @Test
    fun `re-entering restarts the dwell timer`() = runTest {
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
        val fake = FakeFire()
        val timer = DwellTimer(scope, DEFAULT_DWELL_MS, fake::fire)

        timer.enter("a")
        advanceTimeBy(2_000) // partway through the first dwell
        runCurrent()
        assertEquals(0, fake.count.get())

        timer.enter("a") // restart: the first job is cancelled
        advanceTimeBy(2_000) // total 4000 from first enter, but only 2000 from the restart
        runCurrent()
        assertEquals(0, fake.count.get()) // not yet — restart threshold is 3000

        advanceTimeBy(DEFAULT_DWELL_MS - 2_000 + 1) // finish the restarted dwell
        advanceUntilIdle()
        assertEquals(1, fake.count.get())
        assertEquals("a", fake.lastScreenId)
    }

    @Test
    fun `exit on a screen never entered is a no-op`() = runTest {
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
        val fake = FakeFire()
        val timer = DwellTimer(scope, DEFAULT_DWELL_MS, fake::fire)

        timer.exit("z") // never entered
        advanceUntilIdle()

        assertEquals(0, fake.count.get())
    }

    @Test
    fun `distinct screenIds dwell independently`() = runTest {
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
        val fired = mutableListOf<String>()
        val timer = DwellTimer(scope, DEFAULT_DWELL_MS) { fired.add(it) }

        timer.enter("a")
        timer.enter("b")
        timer.exit("a") // cancel only "a"
        advanceTimeBy(DEFAULT_DWELL_MS + 1)
        advanceUntilIdle()

        assertEquals(listOf("b"), fired)
    }
}
