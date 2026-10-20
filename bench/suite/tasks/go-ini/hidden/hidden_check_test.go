package ini

import (
	"strings"
	"testing"
)

func TestHiddenParse(t *testing.T) {
	got, err := Parse(strings.NewReader("top = 1\n; c\n\n[db]\nhost = x \nhost=y\n# c\n[web]\nport= 80"))
	if err != nil {
		t.Fatal(err)
	}
	if got[""]["top"] != "1" || got["db"]["host"] != "y" || got["web"]["port"] != "80" {
		t.Errorf("got %v", got)
	}
}

func TestHiddenError(t *testing.T) {
	_, err := Parse(strings.NewReader("[a]\nok=1\nbroken"))
	if err == nil || !strings.Contains(err.Error(), "3") {
		t.Errorf("err = %v", err)
	}
}
