# Codebase Audit — RagAgent (MRE2.0)

Full-stack audit of the backend (`RagAgent/`) and frontend (`Rag agent client/`) codebases covering security, bugs, logical flaws, redundancy, and reusability.

---

## 🔴 Security Issues

### 1. JWT signature verification silently disabled in dev
**File**: [auth.py](file:///s:/projects/MRE2.0/RagAgent/app/auth.py#L22-L24)
**Severity**: 🔴 Critical

```python
# dev fallback
decoded = jwt.decode(token, options={"verify_signature": False})
```

If `CLERK_JWKS_URL` is empty (the default is `""`), **any crafted JWT with a valid `sub` claim is accepted without verification**. An attacker can forge tokens and access any user's chats, documents, and data. This is the single biggest vulnerability in the codebase.

**Fix**: Fail hard if `CLERK_JWKS_URL` is not set in production. Add an explicit `ENVIRONMENT` or `DEBUG` setting and only allow the unverified fallback when `DEBUG=True`.

---

### 2. Debug search endpoint exposed in production
**File**: [api.py](file:///s:/projects/MRE2.0/RagAgent/app/api.py#L152-L166)
**Severity**: 🟡 Medium

```python
@router.get("/chats/{chat_id}/debug/search")
```

This endpoint leaks internal vector/lexical scores, document IDs, chunk contents, and Cloudinary URLs. It's auth-gated (good), but should be removed or gated behind a `DEBUG` flag before deploying to production.

---

### 3. Health endpoint leaks internal state
**File**: [main.py](file:///s:/projects/MRE2.0/RagAgent/main.py#L37-L48)
**Severity**: 🟡 Medium

The `/health` endpoint is **unauthenticated** and returns `vector_count`, `qdrant_status`, and raw exception strings (`str(e)`). Exception strings can leak internal hostnames, credentials fragments, or stack details.

**Fix**: Return only `{"status": "healthy"}` or `{"status": "unhealthy"}` publicly. Log details server-side.

---

### 4. Cloudinary images are publicly accessible forever
**File**: [ingest.py](file:///s:/projects/MRE2.0/RagAgent/app/ingest.py#L192-L196)
**Severity**: 🟡 Medium

Images are uploaded with a predictable `public_id` pattern (`{doc_id}_page{N}_img{M}`) and no access control. Anyone who can guess or enumerate a `doc_id` UUID can view all extracted images. If the document is deleted, the background cleanup may silently fail (exception is caught and printed), leaving orphaned images accessible.

**Fix**: Use Cloudinary's `type: "authenticated"` upload or signed URLs. Consider adding a `folder` prefix per user.

---

### 5. No rate limiting on API endpoints
**Severity**: 🟡 Medium

There is no rate limiting on `/api/chats/{chat_id}/message` or `/api/chats/{chat_id}/upload`. A malicious user could:
- Spam the chat endpoint to exhaust your Gemini API quota (your free-tier limit is 15 RPM).
- Upload many large PDFs to exhaust Cloudinary/Qdrant storage.

**Fix**: Add a FastAPI rate-limiting middleware (e.g., `slowapi`).

---

### 6. `CORS_ORIGINS` defaults include localhost only
**File**: [config.py](file:///s:/projects/MRE2.0/RagAgent/app/config.py#L16)
**Severity**: 🟢 Low (but easy to misconfigure)

The default `CORS_ORIGINS` is `"http://localhost:5173,http://localhost:5174,http://localhost:3000"`. If you deploy without overriding this, the frontend on your production domain will get CORS-blocked. Conversely, if someone adds `"*"` as a quick fix, it opens the API to any origin.

---

### 7. No input sanitization on `file.filename`
**File**: [api.py](file:///s:/projects/MRE2.0/RagAgent/app/api.py#L137)
**Severity**: 🟢 Low

`file.filename` is user-controlled and stored directly in the database and passed to Cloudinary. While this doesn't lead to path traversal (you're not writing to disk), filenames like `../../etc/passwd.pdf` or extremely long names could cause display issues or be used in social engineering.

**Fix**: Sanitize the filename (strip path separators, truncate length).

---

## 🟠 Bugs & Logical Flaws

### 8. Upload reads entire file into memory BEFORE size check
**File**: [api.py](file:///s:/projects/MRE2.0/RagAgent/app/api.py#L130-L134)
**Severity**: 🟠 Bug

```python
file_bytes = await file.read()       # reads 500MB into RAM
if len(file_bytes) > MAX_UPLOAD_SIZE: # THEN checks size
```

A malicious user can upload a 2GB file, causing the server to allocate 2GB of RAM before the check rejects it. This is a trivial denial-of-service vector.

**Fix**: Use chunked reading with an early abort:
```python
chunks, total = [], 0
async for chunk in file:
    total += len(chunk)
    if total > MAX_UPLOAD_SIZE:
        raise HTTPException(413, "File too large")
    chunks.append(chunk)
file_bytes = b"".join(chunks)
```

---

### 9. Synchronous PDF ingestion blocks the event loop
**File**: [api.py](file:///s:/projects/MRE2.0/RagAgent/app/api.py#L137)
**Severity**: 🟠 Bug

`ingest_pdf()` is a heavy, synchronous CPU/IO operation (PyMuPDF parsing, Cloudinary uploads, Gemini API calls, Qdrant upserts). It's called directly inside an `async def` endpoint, which **blocks the entire FastAPI event loop** for potentially minutes. All other requests (including active chat streams) will hang.

**Fix**: Either:
- Run it in a background task: `background_tasks.add_task(ingest_pdf, ...)`
- Or use `await asyncio.to_thread(ingest_pdf, ...)`

---

### 10. `call_with_retry` catches non-rate-limit errors
**File**: [utils.py](file:///s:/projects/MRE2.0/RagAgent/app/utils.py#L21-L26)
**Severity**: 🟠 Bug

```python
is_rate_limit = (
    getattr(e, "code", None) == 429 or
    "RESOURCE_EXHAUSTED" in str(e) or
    "quota" in str(e).lower() or
    "limit" in str(e).lower()   # <-- catches "Invalid input: character limit exceeded"
)
```

The `"limit" in str(e).lower()` check is too broad. It would match errors like `"Invalid input: character limit exceeded"` or `"Rate limit not applicable"`, causing the retry loop to waste 2+ minutes retrying a genuinely invalid request.

**Fix**: Remove the `"limit"` check, or match more specifically: `"rate limit" in str(e).lower()`.

---

### 11. Streaming generator swallows real exceptions
**File**: [api.py](file:///s:/projects/MRE2.0/RagAgent/app/api.py#L202-L219)
**Severity**: 🟡 Medium

```python
def generate():
    try:
        for chunk in chat_with_pdf_agent(...):
            yield chunk
    except Exception as e:
        yield error_msg
```

If the Gemini API raises an authentication error, a database connection failure, or any other critical exception, it's silently converted to a vague `"Something went wrong"` message in the stream. The real error is only `print()`-ed, not logged with a proper logger or traceback.

**Fix**: Use `logging.exception()` instead of `print()`, and include the exception type in the user-facing message for debugging (at least in dev).

---

### 12. Chat title race condition
**File**: [api.py](file:///s:/projects/MRE2.0/RagAgent/app/api.py#L180-L191)
**Severity**: 🟢 Low

The auto-title logic checks `chat.title == "New Chat"` and then makes a Gemini API call. If two messages are sent concurrently on a new chat, both will see `"New Chat"` and both will fire a title generation request, wasting an API call and potentially overwriting each other.

---

### 13. `_ocr_page_if_needed` is dead code
**File**: [ingest.py](file:///s:/projects/MRE2.0/RagAgent/app/ingest.py#L103-L122)
**Severity**: 🟢 Low

The function `_ocr_page_if_needed` exists but is **never called** anywhere. The actual OCR logic uses `_ocr_page_from_bytes` instead. This is dead code that should be removed.

---

### 14. Clerk theme hardcoded to `dark`
**File**: [main.jsx](file:///s:/projects/MRE2.0/Rag%20agent%20client/src/main.jsx#L20)
**Severity**: 🟢 Low

```jsx
appearance={{ baseTheme: dark }}
```

The Clerk sign-in modal is always styled with the dark theme, even when the user has selected light mode. This creates a visual inconsistency.

**Fix**: Pass the theme state down or use Clerk's `useTheme` to match your app theme dynamically.

---

## 🔵 Redundancy & Reusability

### 15. Duplicated chat-fetching logic in `App.jsx`
**File**: [App.jsx](file:///s:/projects/MRE2.0/Rag%20agent%20client/src/App.jsx#L67-L109)
**Severity**: Redundancy

`fetchChats` (lines 71-84) and the `useEffect` `loadChats` (lines 86-109) contain **identical logic** — both call `getChats()`, set chats, and resolve `activeChatId`. The `fetchChats` callback is only used indirectly via `onTitleUpdate`.

**Fix**: Remove `fetchChats`, and expose `loadChats` via a ref or just call the shared logic once.

---

### 16. Duplicated localStorage cache cleanup logic in `ChatInterface.jsx`
**File**: [ChatInterface.jsx](file:///s:/projects/MRE2.0/Rag%20agent%20client/src/components/ChatInterface.jsx#L68-L111)
**Severity**: Redundancy

The metadata list management code (`rag_cached_chats_metadata_*`) is copy-pasted across both the "messages present" branch (lines 74-94) and the "empty messages" branch (lines 96-106). Both parse the same metadata key, filter the chat ID, and re-save.

**Fix**: Extract a `updateCacheMetadata(userId, chatId, action)` utility function.

---

### 17. `_cleanup_chat` and `_cleanup_document` share vector deletion logic
**File**: [api.py](file:///s:/projects/MRE2.0/RagAgent/app/api.py#L57-L94)
**Severity**: Redundancy

Both functions build nearly identical Qdrant `Filter` objects — one filtering by `chat_id`, the other by `document_id`. They could share a helper:
```python
def _delete_vectors_by(field: str, value: str):
    vector_db.client.delete(
        collection_name=settings.QDRANT_COLLECTION_NAME,
        points_selector=qdrant_client.models.Filter(
            must=[qdrant_client.models.FieldCondition(key=field, match=qdrant_client.models.MatchValue(value=value))]
        )
    )
```

---

### 18. `temp_` prefix check repeated everywhere on the frontend
**Files**: [App.jsx](file:///s:/projects/MRE2.0/Rag%20agent%20client/src/App.jsx), [ChatInterface.jsx](file:///s:/projects/MRE2.0/Rag%20agent%20client/src/components/ChatInterface.jsx), [FileUpload.jsx](file:///s:/projects/MRE2.0/Rag%20agent%20client/src/components/FileUpload.jsx)
**Severity**: Redundancy

`chatId.toString().startsWith('temp_')` appears **8 times** across 3 files. This should be a shared utility:
```js
const isTempChat = (id) => id?.toString().startsWith('temp_');
```

---

## 📋 Summary Table

| # | Category | Severity | File | Issue |
|---|----------|----------|------|-------|
| 1 | Security | 🔴 Critical | auth.py | JWT signature bypass when JWKS URL empty |
| 2 | Security | 🟡 Medium | api.py | Debug search endpoint in production |
| 3 | Security | 🟡 Medium | main.py | Health endpoint leaks internals |
| 4 | Security | 🟡 Medium | ingest.py | Cloudinary images publicly accessible |
| 5 | Security | 🟡 Medium | — | No API rate limiting |
| 6 | Security | 🟢 Low | config.py | CORS defaults could misfire |
| 7 | Security | 🟢 Low | api.py | Unsanitized filename |
| 8 | Bug | 🟠 High | api.py | File read before size check (OOM DoS) |
| 9 | Bug | 🟠 High | api.py | Sync ingestion blocks event loop |
| 10 | Bug | 🟠 Medium | utils.py | Retry catches non-rate-limit errors |
| 11 | Bug | 🟡 Medium | api.py | Streaming swallows real exceptions |
| 12 | Bug | 🟢 Low | api.py | Chat title race condition |
| 13 | Dead code | 🟢 Low | ingest.py | `_ocr_page_if_needed` never called |
| 14 | UI | 🟢 Low | main.jsx | Clerk theme hardcoded to dark |
| 15 | Redundancy | — | App.jsx | Duplicated chat-fetching logic |
| 16 | Redundancy | — | ChatInterface.jsx | Duplicated cache cleanup |
| 17 | Redundancy | — | api.py | Duplicated vector deletion |
| 18 | Redundancy | — | 3 files | `temp_` check repeated 8 times |

> [!IMPORTANT]
> **Issue #1 (JWT bypass)** and **Issue #8 (OOM DoS)** should be fixed before any public deployment. They are exploitable with zero authentication or a single HTTP request respectively.
