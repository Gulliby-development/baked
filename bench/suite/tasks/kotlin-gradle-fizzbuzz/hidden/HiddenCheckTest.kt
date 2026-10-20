import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class HiddenCheckTest {
    @Test
    fun classic() {
        assertEquals("FizzBuzz", fizzBuzz(15)[14])
        assertEquals(listOf("1", "2", "Fizz", "4", "Buzz"), fizzBuzz(5))
        assertEquals(emptyList<String>(), fizzBuzz(0))
    }

    @Test
    fun customRules() {
        assertEquals(listOf("1", "Ba", "3", "BaBa"), fizzBuzz(4, listOf(2 to "Ba", 4 to "Ba")))
        assertFailsWith<IllegalArgumentException> { fizzBuzz(-1) }
        assertFailsWith<IllegalArgumentException> { fizzBuzz(3, listOf(0 to "X")) }
    }
}
