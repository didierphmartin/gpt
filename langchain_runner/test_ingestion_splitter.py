"""Parity test: ingestion_splitter.recursive_split must match langchain's
RecursiveCharacterTextSplitter.split_text exactly."""
from langchain_text_splitters import RecursiveCharacterTextSplitter
from ingestion_splitter import recursive_split

SAMPLES = [
    "Hello world. This is a test.\n\nA second paragraph with more words in it, "
    "long enough to force splitting across several chunks when the size is small.",
    "abcdefghij klmnopqrst uvwxyz0123 4567890123\n4567890123 4567890123",
    ("Line one\nLine two\nLine three\n\nNew block here with a fairly long run of "
     "text that keeps going and going so that the splitter has real work to do "
     "and must merge and overlap pieces."),
    "no separators here just one very long token aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
]
CASES = [(50, 0), (50, 10), (100, 20), (20, 5)]

def test_parity():
    for text in SAMPLES:
        for cs, ov in CASES:
            expected = RecursiveCharacterTextSplitter(
                chunk_size=cs, chunk_overlap=ov).split_text(text)
            got = recursive_split(text, chunk_size=cs, overlap=ov)
            assert got == expected, (
                f"mismatch cs={cs} ov={ov}\n exp={expected}\n got={got}")
    print("PARITY OK")

if __name__ == "__main__":
    test_parity()
