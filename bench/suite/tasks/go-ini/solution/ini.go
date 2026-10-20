package ini

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

// Parse reads INI sections and keys.
func Parse(r io.Reader) (map[string]map[string]string, error) {
	out := map[string]map[string]string{}
	section := ""
	sc := bufio.NewScanner(r)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		switch {
		case line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "#"):
		case strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]"):
			section = strings.TrimSpace(line[1 : len(line)-1])
		default:
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				return nil, fmt.Errorf("line %d: expected key = value", n)
			}
			if out[section] == nil {
				out[section] = map[string]string{}
			}
			out[section][strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return out, sc.Err()
}
