import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ingestion import load_and_split

def test_load_and_split_text(tmp_path):
    p = tmp_path / "doc.txt"
    p.write_text(("Para one. " * 200) + "\n\n" + ("Para two. " * 200), encoding="utf-8")
    chunks = load_and_split({"source": "text", "path": str(p)},
                            {"strategy": "recursive", "chunk_size": 500, "overlap": 50})
    assert len(chunks) > 1
    assert all(hasattr(c, "page_content") for c in chunks)
    assert all(len(c.page_content) <= 700 for c in chunks)
    print(f"load_and_split: {len(chunks)} chunks — PASS")

if __name__ == "__main__":
    import tempfile, pathlib
    test_load_and_split_text(pathlib.Path(tempfile.mkdtemp()))
