package com.beatroute.signal
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * The design-token color palette survives the F2 refit (the WebView sheet still lives
 * in a Signal-themed host container). The sheet-only dimens/type/drawables were removed
 * with the native sheet, so this only asserts the retained brand token.
 */
@RunWith(RobolectricTestRunner::class)
class ThemeResourcesTest {
  @Test fun `brand orange token is exposed`() {
    val ctx = RuntimeEnvironment.getApplication()
    val c = ctx.getColor(com.beatroute.signal.R.color.signal_orange_500)
    assertEquals(0xFFF78200.toInt(), c)
  }
}
