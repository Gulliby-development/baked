from cli import main
from textstats import top_words, word_count

def test_count():
    assert word_count("a b  c\nd") == 4
    assert word_count("") == 0

def test_top():
    assert top_words("b a, B. c a b!", 2) == [("b", 3), ("a", 2)]
    assert top_words("y x", 2) == [("x", 1), ("y", 1)]

def test_cli(tmp_path, capsys):
    f = tmp_path / "t.txt"
    f.write_text("one two two")
    assert main([str(f)]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0] == "words: 3"
    assert out[1] == "two 2"

def test_cli_missing(tmp_path, capsys):
    assert main([str(tmp_path / "nope.txt")]) == 1
    assert capsys.readouterr().err
