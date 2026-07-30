# Interview Preparation Guide: Agentic Multimodal RAG Engine

This guide contains comprehensive technical questions and in-depth answers that an interviewer may ask about the project. The questions are categorized into **System Architecture**, **Multimodal Ingestion**, **Retrieval & RAG Optimization**, **LLM Integration & Streaming**, and **Performance & Production Debugging**.

---

## Table of Contents
1. [System Architecture & Storage](#1-system-architecture--storage)
2. [Multimodal Ingestion Pipeline](#2-multimodal-ingestion-pipeline)
3. [Advanced Retrieval & RAG Optimization](#3-advanced-retrieval--rag-optimization)
4. [LLM Integration & Streaming Response Architecture](#4-llm-integration--streaming-response-architecture)
5. [Production Performance & Mobile Optimization (Debugging Case Studies)](#5-production-performance--mobile-optimization-debugging-case-studies)

---

## 1. System Architecture & Storage

### Q1.1: Walk me through the high-level architecture of your application. Why did you choose this tech stack?
* **Answer**: 
  The application is built on a decoupled, full-stack architecture designed for real-time document interaction:
  * **Frontend (React + Vite)**: Chosen for speed, lightweight bundle size, and fast HMR (Hot Module Replacement) during development. Written in modern vanilla CSS to maintain absolute control over design tokens and responsive animations without framework bloat.
  * **Backend (FastAPI)**: Selected for its high performance (built on Starlette and Uvicorn), native support for asynchronous tasks (`async/await`), automatic OpenAPI documentation, and efficient handling of Server-Sent Events (SSE) for token streaming.
  * **Relational Storage (Supabase PostgreSQL)**: Stores structured metadata such as user authentication mapping, active chat sessions, document details, and historical chat messages. It enforces referential integrity so that deleting a chat session cascades and cleans up all associated messages and document references.
  * **Vector Database (Qdrant Cloud)**: Used for storing, indexing, and executing semantic searches over 3072-dimensional document embeddings. Selected for its payload filtering capabilities, high search throughput, and easy-to-use Python client.
  * **Object Storage (Cloudinary)**: Hosts images extracted from PDFs, serving them via CDN URLs referenced in the vector and relational databases.

### Q1.2: Why do you need both PostgreSQL (Supabase) and Qdrant? Why not just use PGVector in PostgreSQL?
* **Answer**: 
  While PGVector is a solid option for simpler use cases, using a specialized vector database like Qdrant side-by-side with a relational database offers clear advantages for production RAG systems:
  * **Performance Isolation**: Searching vectors is compute-intensive (requires heavy CPU/Memory for HNSW index traversal). Keeping vector queries in Qdrant ensures that long-running RAG queries do not starve database connections or CPU cycles needed for relational transactional operations (like loading chat history or user auth).
  * **Payload Filtering & Scalability**: Qdrant is optimized for fast search filtering using metadata (e.g., matching `chat_id` or `document_id`) during the vector index traversal itself, rather than post-filtering.
  * **Advanced Indexing**: Qdrant allows fine-grained configurations for vector compression (scalar quantization) and HNSW parameters that aren't easily tunable in PGVector.
  * **Hybrid Search Implementation**: Implementing custom local BM25 scoring alongside vector search is much easier to manage when drawing candidate payloads directly from Qdrant's fast document scroll API.

---

## 2. Multimodal Ingestion Pipeline

### Q2.1: How does your ingestion pipeline process a PDF? Explain the difference between searchable and scanned documents.
* **Answer**: 
  When a PDF is uploaded, `ingest.py` performs the following steps:
  1. **PDF Reading**: Opens the document using `PyMuPDF` (`fitz`).
  2. **Page Character Check**: For each page, it extracts native textual content. If the length of the extracted text falls below a threshold (e.g., `OCR_TEXT_MIN_CHARS = 80`), the pipeline classifies the page as a "scanned/visual page" and triggers an **OCR Fallback** using the **Gemini Vision API** to read the text, headings, and tables visually.
  3. **Table Extraction**: Extracts tables and formats them into Markdown strings, which are then stored as independent chunks to preserve tabular structure (which semantic vector search alone often flattens and ruins).
  4. **Embedded Image Extraction**: Extracts raw image files (graphics, charts, diagrams) embedded in the PDF pages. It uploads them to Cloudinary under the key name structure `[doc_id]_page[num]_img[idx]`.
  5. **Image Captioning (Alt-Text)**: Sends the extracted image to the Gemini Vision API to generate a detailed, context-aware caption describing the chart, diagram, or graphic.
  6. **Vectorization**: Vectorizes both text chunks, markdown tables, and generated image captions using Google's 3072-dimensional embedding model and batch-upserts them to Qdrant.

### Q2.2: How do you handle images in a RAG system? You can't directly embed an image into a text-only LLM context easily without wasting tokens.
* **Answer**: 
  We handle images using a **multimodal text-enrichment model**:
  * During ingestion, we do not store raw image bytes in the vector database. Instead, we extract the image, upload it to Cloudinary, and pass the image along with page-surrounding text to the Gemini Vision model.
  * Gemini generates a rich, highly descriptive textual caption (e.g., *"Line chart showing the quarterly revenue growth of Company X from 2024 to 2026, peaking at $4.5M in Q4"*).
  * We embed this text caption into Qdrant as a point with the metadata tag `entity_type: "image"` and the Cloudinary `image_url`.
  * During retrieval, if the user query matches the image's caption (e.g., *"show me revenue growth"*), the RAG pipeline retrieves the caption, extracts the `image_url` from the metadata, and includes it in the LLM context.
  * The frontend detects the image markdown tag `![alt](url)` and renders the actual image inside the message bubble with a clickable zoom lightbox, keeping the context window light while providing visual grounding.

---

## 3. Advanced Retrieval & RAG Optimization

### Q3.1: What is Hybrid Search? How did you implement it in this project?
* **Answer**: 
  Hybrid search merges two search philosophies: **dense vector search** (which captures semantic meaning and synonyms) and **sparse lexical search** (which captures exact keyword matches like serial numbers, abbreviations, or codes).
  * **Vector Search**: Embeds the query and runs a cosine similarity search in Qdrant, filtered by the current `chat_id`.
  * **Lexical Search (BM25)**: Since Qdrant is a vector database and doesn't natively support standard BM25 out-of-the-box in the same way Elasticsearch does, we implemented a custom BM25 engine. The backend scrolls and fetches all candidate payloads matching the current `chat_id` in Qdrant. We then tokenize the text and score the documents using a local BM25 ranking algorithm.
  * **Reciprocal Rank Fusion (RRF)**: The results of both searches are combined. RRF ranks the documents based on their position in both search lists, rather than trying to normalize and merge raw cosine similarity scores with BM25 scores (which are on different scales). The RRF formula applied is:
    $$RRF\_Score(d) = \sum_{m \in M} \frac{1}{k + r_m(d)}$$
    *(where $M$ is the set of retrieval systems, $r_m(d)$ is the rank of document $d$ in system $m$, and $k$ is a constant, typically 60).*

### Q3.2: Explain your "Intent-Driven Boosting" and "Query Expansion" strategies in `tools.py`.
* **Answer**: 
  Standard RAG often fails when queries target visual assets (e.g., *"show me the flowchart"*) or tabular data. To solve this, we implemented:
  * **Query Expansion**: The user query is passed through a rule-based analyzer that checks for key terms (e.g., images, tables, charts) and generates expanded variations (e.g., *"revenue table"*, *"revenue chart"*, *"revenue spreadsheet"*) to fetch a broader set of vector candidates.
  * **Intent-Driven Boosting**: If the query contains image intent (e.g., *"photos"*, *"diagram"*, *"png"*), we run a secondary vector query in Qdrant filtered strictly to points where `entity_type == "image"`. During the RRF merge step, we apply a significant heuristic multiplier boost (`0.50` instead of `0.0`) to any candidate that contains an image payload. Similarly, table queries boost markdown table chunks by `0.22`.
  * **Adaptive Context Expansion (Neighbor Pages)**: When an anchor chunk is selected as relevant, we dynamically pull in surrounding page chunks from the same document (Neighbor Page expansion) to guarantee the LLM has full context (especially useful for questions spanning multiple pages). If the query has image intent, the neighbor-page search limit is increased to 8 to prioritize capturing visual chunks.

### Q3.3: You mention an "LLM Reranker" in your configuration. How does it work and what is the trade-off?
* **Answer**: 
  * **Mechanism**: After retrieving and merging candidates using hybrid search, we take the top 30 candidates and pass them to a lightweight LLM (Gemini 3.1 Flash-Lite) with a strict JSON-formatting prompt: *"Given this user query, output a JSON array listing only the IDs of the evidence chunks that are strictly necessary to answer it."* This trims down the final context to the top 15-18 most relevant chunks.
  * **Trade-off (Latency vs. Accuracy)**: Reranking significantly improves accuracy by removing "noise" chunks that confuse the LLM. However, it introduces an extra network hop (calling the reranking model), which adds roughly `200ms - 500ms` of latency to the read path. We expose `ENABLE_LLM_RERANKER` as a config toggle so it can be disabled if latency is the primary constraint.

---

## 4. LLM Integration & Streaming Response Architecture

### Q4.1: Why did you choose DeepSeek for reasoning and Gemini as a fallback? How is the stream parsed?
* **Answer**: 
  * **Model Choice**: DeepSeek's reasoning models (such as `deepseek-v4-flash`) are superior at structured, logical chain-of-thought processing. They output a separate text stream containing their "thoughts" (`reasoning_content`) before yielding the final response (`content`). Gemini is kept as a fallback model because of its high rate limits, multi-modal flexibility, and speed.
  * **Stream Parsing**: In `agent.py`, we hook into the OpenAI-compatible stream. If `thinking_mode` is enabled, as we iterate over the streaming chunks, we inspect the token metadata for `reasoning_content`. We prepend `<details><summary>Thinking Process</summary>\n` to the stream on the first reasoning token, yield the raw thoughts, and then close the tag with `\n</details>\n\n` as soon as the model transitions to yielding standard `content` tokens.

### Q4.2: How does the frontend handle this custom collapsible stream?
* **Answer**: 
  In `MessageBubble.jsx`, we parse the accumulated text stream using a utility function (`parseThinkingAndContent`).
  * It splits the text into two variables: `thinking` (whatever is inside the `<details>` tags) and `content` (whatever is outside it).
  * We render the `thinking` part inside a custom React component called `ThinkingAccordion`.
  * **Auto-Collapse**: During streaming, the accordion remains open, displaying a pulsing brain animation to show that the model is actively reasoning. As soon as the backend closes the `</details>` tag and starts streaming the final response, the accordion automatically collapses so the user can focus on the final answer without manual clicks.

---

## 5. Production Performance & Mobile Optimization (Debugging Case Studies)

### Q5.1: Tell me about a difficult bug you faced in this project and how you resolved it.
* **Answer**: 
  * **The Bug (Mobile Scroll & Stream Freeze)**: During mobile testing, users reported two major issues:
    1. The chat input box was cut off by the mobile browser's address bar and the page was completely locked (unable to scroll).
    2. Real-time streaming and the thinking accordion animation were not displaying progressively — instead, the screen froze, loading indefinitely, and then the entire completed response popped up at once.
  * **The Root Cause Analysis**:
    1. **Layout Lock**: The container CSS used `height: 100vh`. On mobile, `100vh` includes the browser address bar space, pushing the input form below the viewport. Additionally, because the parent flexbox components lacked `min-height: 0`, the flex children expanded to fit their full content size, causing the entire container to overflow. Because the wrapper had `overflow: hidden`, the browser clipped the page and broke scrolling.
    2. **Response Buffering**: FastAPI's `StreamingResponse` was returning chunks with a generic `text/plain` media type without anti-buffering headers. Mobile carriers and mobile Safari aggressively buffer streaming HTTP connections to save battery.
    3. **UI Thread Starvation**: Because React state updates were triggered at a high frequency on every incoming stream chunk, the mobile device's CPU became starved, blocking the main thread and preventing the browser from rendering paint cycles until the stream finished.
  * **The Fix**:
    1. **CSS Viewport Fix**: Replaced `100vh` with modern dynamic viewport height `100dvh` and added `min-height: 0` to flex layouts to enforce boundary constraints.
    2. **Anti-Buffering Headers**: Modified the FastAPI endpoint to return headers:
       `"X-Accel-Buffering": "no"`
       `"Cache-Control": "no-cache, no-transform"`
       `"Content-Encoding": "identity"`
       This forced intermediate proxies and mobile web engines to disable buffering and stream chunks instantly.
       3. **Microtask Yielding**: Added `await new Promise(resolve => setTimeout(resolve, 0))` on each read chunk in the React fetch loop. This yielded control back to the browser's event loop, letting it perform layout and paint frames smoothly between chunks.

### Q5.2: If this application scales to 100,000 active users, where will the bottleneck be, and how would you fix it?
* **Answer**: 
  * **Vector DB Limits**: Qdrant Cloud would experience high search latency under concurrent connections. 
    * *Fix*: Implement a caching layer (Redis) in front of Qdrant to cache embeddings for identical queries, and configure Qdrant read replicas.
  * **LLM API Rate Limits & Cost**: Direct API calls to DeepSeek and Gemini will hit rate limits and accumulate high costs.
    * *Fix*: Implement response caching for popular queries. Route simpler queries to smaller, self-hosted models (like Llama-3-8B via vLLM) and only escalate complex, multi-page queries to DeepSeek-v4.
  * **Database Connection Pool Exhaustion**: PostgreSQL database connections on Supabase will run out due to high API concurrency.
    * *Fix*: Introduce a connection pooler like PgBouncer in front of PostgreSQL, and optimize SQLAlchemy queries to release connections immediately after transaction completion.
  * **State Management & Streaming Latency**: Maintaining active SSE streaming connections on a standard single-process Uvicorn backend will starve the server.
    * *Fix*: Scale the FastAPI backend horizontally across containers behind an Nginx load balancer, and use Redis Pub/Sub to manage distributed message streams.
