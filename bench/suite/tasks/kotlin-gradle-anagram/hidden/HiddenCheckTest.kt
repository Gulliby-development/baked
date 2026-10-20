import kotlin.test.Test
import kotlin.test.assertEquals

class HiddenCheckTest {
    @Test
    fun groups() {
        assertEquals(
            listOf(listOf("Listen", "silent!"), listOf("abc", "cab ", "BCA"), listOf("x")),
            groupAnagrams(listOf("Listen", "abc", "silent!", "", "cab ", "x", "BCA")),
        )
    }

    @Test
    fun empty() {
        assertEquals(emptyList<List<String>>(), groupAnagrams(listOf("  ", "")))
    }
}
