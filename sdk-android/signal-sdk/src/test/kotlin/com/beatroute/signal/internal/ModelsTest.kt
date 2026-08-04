package com.beatroute.signal.internal

import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ModelsTest {

    private fun fixture(name: String): String =
        ModelsTest::class.java.getResourceAsStream("/fixtures/$name")!!.bufferedReader().readText()

    @Test
    fun `EligibilityResult extracts trigger_id and keeps the raw config verbatim`() {
        val raw = fixture("eligibility_config.json")
        val result = EligibilityResult.from(raw)!!

        // Only trigger_id is parsed by the shell (GR-2); the rest is forwarded untouched.
        assertEquals("11111111-1111-4111-8111-111111111111", result.triggerId)
        assertEquals(raw, result.rawConfigJson)
    }

    @Test
    fun `EligibilityResult is null when trigger_id is missing`() {
        assertNull(EligibilityResult.from("""{"header":"hi"}"""))
    }

    @Test
    fun `EligibilityResult is null for a non-object body`() {
        assertNull(EligibilityResult.from("""[1,2,3]"""))
        assertNull(EligibilityResult.from("not json"))
    }

    @Test
    fun `ResponseBody serializes to the re-keyed wire shape`() {
        val body = ResponseBody(
            triggerId = "t1",
            ratingValue = 5,
            otherText = "great",
            deviceOs = "Android 13",
            appVersion = "1.0.0",
            sessionAgeDays = 90,
            shownAt = "2026-08-04T10:00:00Z",
            respondedAt = "2026-08-04T10:00:05Z",
        )
        val json = SignalJson.encodeToString(body)

        // Re-keyed to session_age_days (F2-D3); no rep_tenure_days / chip_selected.
        assert(json.contains("\"session_age_days\":90")) { json }
        assert(!json.contains("rep_tenure_days")) { json }
        assert(!json.contains("chip_selected")) { json }

        val round = SignalJson.decodeFromString<ResponseBody>(json)
        assertEquals(body, round)
    }

    @Test
    fun `decodes error body from contract fixture`() {
        val body = SignalJson.decodeFromString<ErrorBody>(fixture("error_body.json"))

        assertEquals("unknown_trigger", body.error.code)
        assertEquals("no such trigger_id", body.error.message)
    }
}
