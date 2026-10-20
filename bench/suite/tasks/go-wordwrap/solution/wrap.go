package wordwrap

import (
	"strings"
	"unicode/utf8"
)

// Wrap fills lines of at most width runes.
func Wrap(text string, width int) []string {
	if width < 1 {
		panic("wordwrap: width must be at least 1")
	}
	lines := []string{}
	cur := ""
	for _, w := range strings.Fields(text) {
		switch {
		case cur == "":
			cur = w
		case utf8.RuneCountInString(cur)+1+utf8.RuneCountInString(w) <= width:
			cur += " " + w
		default:
			lines = append(lines, cur)
			cur = w
		}
	}
	if cur != "" {
		lines = append(lines, cur)
	}
	return lines
}
