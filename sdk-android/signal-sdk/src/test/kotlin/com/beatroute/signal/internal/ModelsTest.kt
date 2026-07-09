package com.beatroute.signal.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsTest {

    private fun fixture(name: String): String =
        ModelsTest::class.java.getResourceAsStream("/fixtures/$name")!!.bufferedReader().readText()

    @Test
    fun `decodes eligibility config from contract fixture`() {
        val config = SignalJson.decodeFromString<EligibilityConfig>(fixture("eligibility_config.json"))

        assertEquals("11111111-1111-4111-8111-111111111111", config.triggerId)
        assertEquals("22222222-2222-4222-8222-222222222222", config.campaignId)
        assertEquals("CSAT", config.metricType)
        assertEquals("How was your delivery?", config.header)
        assertEquals("star", config.ratingType)
        assertEquals(5, config.ratingScaleMax)
        assertEquals(4, config.positiveThreshold)
        assertEquals(2, config.chipsOnNegative.size)
        assertEquals(listOf("Too slow", "Wrong item"), config.chipsOnNegative)
        assertTrue(config.otherRequiresText)
        assertTrue(config.otherAllowsImage)
        assertEquals("play_store_review", config.onPositiveAction)
        assertTrue(config.skipEnabled)
    }

    @Test
    fun `decodes error body from contract fixture`() {
        val body = SignalJson.decodeFromString<ErrorBody>(fixture("error_body.json"))

        assertEquals("unknown_trigger", body.error.code)
        assertEquals("no such trigger_id", body.error.message)
    }
}
