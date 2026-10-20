package wordwrap

import (
	"reflect"
	"testing"
)

func TestHiddenWrap(t *testing.T) {
	cases := []struct {
		in    string
		width int
		want  []string
	}{
		{"the quick brown fox", 10, []string{"the quick", "brown fox"}},
		{"  a\tb\n c ", 3, []string{"a b", "c"}},
		{"extraordinary word", 5, []string{"extraordinary", "word"}},
		{"\u00e9\u00e9\u00e9 \u00e9\u00e9", 6, []string{"\u00e9\u00e9\u00e9 \u00e9\u00e9"}},
	}
	for _, c := range cases {
		if got := Wrap(c.in, c.width); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Wrap(%q, %d) = %q, want %q", c.in, c.width, got, c.want)
		}
	}
	if got := Wrap("   ", 4); got == nil || len(got) != 0 {
		t.Errorf("blank text: got %#v", got)
	}
}

func TestHiddenPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("width 0 did not panic")
		}
	}()
	Wrap("a", 0)
}
