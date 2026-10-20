fun groupAnagrams(words: List<String>): List<List<String>> {
    val groups = LinkedHashMap<String, MutableList<String>>()
    for (w in words) {
        val key = w.lowercase().filter { it.isLetter() }.toList().sorted().joinToString("")
        if (w.isBlank()) continue
        groups.getOrPut(key) { mutableListOf() }.add(w)
    }
    return groups.values.toList()
}
