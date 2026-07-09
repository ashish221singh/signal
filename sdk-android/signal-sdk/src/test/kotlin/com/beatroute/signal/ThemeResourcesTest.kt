package com.beatroute.signal
import android.util.TypedValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ThemeResourcesTest {
  @Test fun `brand orange token is exposed`() {
    val ctx = RuntimeEnvironment.getApplication()
    val c = ctx.getColor(com.beatroute.signal.R.color.signal_orange_500)
    assertEquals(0xFFF78200.toInt(), c)
  }

  @Test fun `sheet radius dimen resolves`() {
    val ctx = RuntimeEnvironment.getApplication()
    val px = ctx.resources.getDimension(com.beatroute.signal.R.dimen.signal_radius_sheet)
    val expected = TypedValue.applyDimension(
      TypedValue.COMPLEX_UNIT_DIP, 20f, ctx.resources.displayMetrics
    )
    assertEquals(expected, px, 0.5f)
    assertTrue(px > 0f)
  }
}
