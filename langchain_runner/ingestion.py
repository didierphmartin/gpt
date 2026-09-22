"""RAG ingestion (Plan 1, v1 strict minimum): load a document, recursive-split,
write to pgvector. Backends are fixed for v1 (pdf/text loader, recursive splitter,
pgvector store, OpenAI embeddings)."""
import os
from langchain_community.document_loaders import PyPDFLoader, TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter


def load_and_split(loader_cfg, splitter_cfg):
    """Return a list of LangChain Documents. No DB / no network (testable)."""
    source = loader_cfg.get("source", "pdf")
    path = loader_cfg["path"]
    if source == "pdf":
        docs = PyPDFLoader(path).load()
    elif source == "text":
        docs = TextLoader(path, encoding="utf-8").load()
    else:
        raise ValueError(f"v1 supports source 'pdf'|'text', got {source!r}")
    if splitter_cfg.get("strategy", "recursive") != "recursive":
        raise ValueError("v1 supports splitter strategy 'recursive' only")
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=int(splitter_cfg.get("chunk_size", 1000)),
        chunk_overlap=int(splitter_cfg.get("overlap", 150)),
    )
    return splitter.split_documents(docs)


def _embeddings(spec):
    """spec like 'openai:text-embedding-3-small' (v1 default)."""
    provider, _, model = (spec or "openai:text-embedding-3-small").partition(":")
    if provider == "openai":
        from langchain_openai import OpenAIEmbeddings
        return OpenAIEmbeddings(model=model or "text-embedding-3-small")
    raise ValueError(f"v1 supports embeddings provider 'openai', got {provider!r}")


def ingest(loader_cfg, splitter_cfg, store_cfg):
    """Full pipeline: load -> split -> write to pgvector. Returns a summary dict.
    Needs VECTOR_DB_DSN + a reachable pgvector DB (integration / E2E)."""
    from langchain_postgres import PGVector
    chunks = load_and_split(loader_cfg, splitter_cfg)
    if store_cfg.get("store", "pgvector") != "pgvector":
        raise ValueError("v1 supports store 'pgvector' only")
    dsn = os.environ.get("VECTOR_DB_DSN")
    if not dsn:
        raise RuntimeError("VECTOR_DB_DSN is not set")
    collection = store_cfg.get("collection") or store_cfg.get("index") or "default"
    PGVector.from_documents(
        documents=chunks,
        embedding=_embeddings(store_cfg.get("embeddings")),
        collection_name=collection,
        connection=dsn,
        use_jsonb=True,
    )
    return {"store": "pgvector", "collection": collection, "chunks": len(chunks)}
