import { memo, useEffect, useMemo, useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, ImageOff, ExternalLink, Brain, ChevronDown, ChevronUp } from 'lucide-react';

const EVIDENCE_LINE_RE = /^\[Evidence\s+(\d+)\]\s+filename=(.*?);\s*page=(.*?);\s*source=(.*?);\s*relevance=([^\n]+)$/gim;
const PAGE_CITATION_RE = /\[(?:p\.?|page)\s*(\d+)(?:\s*[-,]\s*\d+)?\]/gi;

const normalizePage = (page) => {
  const value = Number.parseInt(String(page ?? '').trim(), 10);
  return Number.isFinite(value) ? value : null;
};

const parseEvidence = (text) => {
  const citations = [];
  const seen = new Set();

  for (const match of text.matchAll(EVIDENCE_LINE_RE)) {
    const page = normalizePage(match[3]);
    if (!page) continue;

    const id = `evidence-${match[1]}-${page}`;
    seen.add(`page-${page}`);
    citations.push({
      id,
      label: `p. ${page}`,
      title: `Evidence ${match[1]}`,
      filename: match[2]?.trim() || 'Uploaded document',
      page,
      source: match[4]?.trim(),
      relevance: match[5]?.trim(),
    });
  }

  for (const match of text.matchAll(PAGE_CITATION_RE)) {
    const page = normalizePage(match[1]);
    if (!page || seen.has(`page-${page}`)) continue;

    seen.add(`page-${page}`);
    citations.push({
      id: `page-${page}`,
      label: `p. ${page}`,
      title: 'Document citation',
      filename: 'Uploaded document',
      page,
    });
  }

  return citations;
};

const parseThinkingAndContent = (text) => {
  const detailsStart = text.indexOf('<details><summary>Thinking Process</summary>');
  if (detailsStart === -1) {
    return { thinking: '', content: text, hasThinking: false, isThinkingComplete: false };
  }

  const contentBefore = text.slice(0, detailsStart);
  const detailsEnd = text.indexOf('</details>', detailsStart);
  if (detailsEnd === -1) {
    const thinkingPart = text.slice(detailsStart + '<details><summary>Thinking Process</summary>'.length);
    return {
      thinking: thinkingPart.trim(),
      content: contentBefore.trim(),
      hasThinking: true,
      isThinkingComplete: false
    };
  } else {
    const thinkingPart = text.slice(detailsStart + '<details><summary>Thinking Process</summary>'.length, detailsEnd);
    const contentPart = contentBefore + text.slice(detailsEnd + '</details>'.length);
    return {
      thinking: thinkingPart.trim(),
      content: contentPart.trim(),
      hasThinking: true,
      isThinkingComplete: true
    };
  }
};

const prepareMarkdown = (text) => (
  text
    .replace(EVIDENCE_LINE_RE, '')
    .replace(PAGE_CITATION_RE, (_match, page) => `[p. ${page}](citation://page/${page})`)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
);

const ThinkingAccordion = ({ thinking, isThinkingComplete }) => {
  const [isOpen, setIsOpen] = useState(true);
  const wasThinkingCompleteRef = useRef(isThinkingComplete);

  useEffect(() => {
    // If it transitions from incomplete to complete, collapse it automatically!
    if (!wasThinkingCompleteRef.current && isThinkingComplete) {
      setIsOpen(false);
    }
    wasThinkingCompleteRef.current = isThinkingComplete;
  }, [isThinkingComplete]);

  // If we load an already completed thinking process, default to collapsed
  useEffect(() => {
    if (isThinkingComplete) {
      setIsOpen(false);
    } else {
      setIsOpen(true);
    }
  }, []);

  if (!thinking) return null;

  return (
    <div className={`thinking-accordion ${isOpen ? 'open' : 'collapsed'}`}>
      <button
        type="button"
        className="thinking-header"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <span className="thinking-title">
          <Brain className={`thinking-icon ${!isThinkingComplete ? 'pulsing-brain' : ''}`} size={16} />
          <span>{isThinkingComplete ? 'Thought Process' : 'Thinking...'}</span>
        </span>
        {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {isOpen && (
        <div className="thinking-content">
          <div className="thinking-inner">
            {thinking}
          </div>
        </div>
      )}
    </div>
  );
};

const useSmoothStreamingText = (targetText, enabled) => {
  const [visibleText, setVisibleText] = useState('');
  const targetRef = useRef(targetText);

  useEffect(() => {
    targetRef.current = targetText;
  }, [targetText]);

  useEffect(() => {
    if (!enabled) return undefined;

    let frameId;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;

      setVisibleText((current) => {
        const target = targetRef.current;
        if (!target.startsWith(current)) return target;

        const remaining = target.length - current.length;
        if (remaining <= 0) return current;

        const step = Math.min(Math.max(Math.ceil(remaining / 12), 1), 12);
        return target.slice(0, current.length + step);
      });

      frameId = window.setTimeout(tick, 24);
    };

    frameId = window.setTimeout(tick, 24);

    return () => {
      cancelled = true;
      window.clearTimeout(frameId);
    };
  }, [enabled]);

  return enabled ? visibleText : targetText;
};

const CitationBadges = ({ citations }) => {
  const [activeId, setActiveId] = useState(null);

  if (citations.length === 0) return null;

  return (
    <div className="citation-strip" aria-label="Document citations">
      {citations.map((citation) => {
        const isActive = activeId === citation.id;
        return (
          <span className="citation-shell" key={citation.id}>
            <button
              type="button"
              className="citation-badge"
              aria-expanded={isActive}
              onClick={() => setActiveId(isActive ? null : citation.id)}
            >
              {citation.label}
            </button>
            {isActive && (
              <span className="citation-popover" role="status">
                <strong>{citation.title}</strong>
                <span>{citation.filename}</span>
                <span>Page {citation.page}</span>
                {citation.source && <span>Source: {citation.source}</span>}
                {citation.relevance && <span>Relevance: {citation.relevance}</span>}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
};

const ImageLightbox = ({ image, onClose }) => {
  useEffect(() => {
    if (!image) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [image, onClose]);

  if (!image) return null;

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close image preview">
        Close
      </button>
      <img
        src={image.src}
        alt={image.alt || 'Document image preview'}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
};

const MarkdownImage = ({ src, alt, onZoom, isStreaming }) => {
  const [failedImage, setFailedImage] = useState({ src: null, failed: false });
  const failed = failedImage.failed && failedImage.src === src;

  // Check if it has a standard image extension (casing-insensitive, ignoring query/hash)
  const isImageExt = useMemo(() => {
    if (!src) return false;
    const cleanUrl = src.split(/[?#]/)[0];
    return /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(cleanUrl);
  }, [src]);

  if (failed) {
    return (
      <span className="markdown-image-failed" title="Failed to load document image" style={{ display: 'inline-flex' }}>
        <ImageOff size={16} />
        <span>Image failed to load</span>
      </span>
    );
  }

  // If still streaming and the URL is not yet recognized as an image, show a clean loading indicator
  if (isStreaming && !isImageExt) {
    return (
      <span className="markdown-image-failed" style={{ borderStyle: 'solid', display: 'inline-flex' }}>
        <div className="spinner" style={{ width: 14, height: 14, borderWidth: '1.5px', borderTopColor: 'var(--accent-color)' }} />
        <span>Loading diagram...</span>
      </span>
    );
  }

  // Once streaming is finished, if it's not a valid image extension, upgrade it to a link!
  if (!isImageExt) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="markdown-link-upgrade"
        title="Open external link"
      >
        <ExternalLink size={14} />
        <span>View Link: {alt || src}</span>
      </a>
    );
  }

  return (
    <button
      type="button"
      className="markdown-image-button"
      onClick={() => onZoom({ src, alt })}
      aria-label="Open document image preview"
    >
      <img 
        src={src} 
        alt={alt || 'Document image'} 
        loading="lazy" 
        referrerPolicy="no-referrer"
        onError={() => {
          // Only trigger failure once the URL is complete and streaming has finished
          if (isImageExt && !isStreaming) {
            setFailedImage({ src, failed: true });
          }
        }}
      />
    </button>
  );
};

const MessageBubble = memo(({ role, text, isStreaming = false, userImageUrl = null }) => {
  const isUser = role === 'user';
  const visibleText = useSmoothStreamingText(text || '', isStreaming);
  const [lightboxImage, setLightboxImage] = useState(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const { thinking, content, isThinkingComplete } = useMemo(() => {
    return parseThinkingAndContent(visibleText);
  }, [visibleText]);

  const citations = useMemo(() => parseEvidence(visibleText), [visibleText]);
  const markdownText = useMemo(() => prepareMarkdown(content), [content]);

  const markdownComponents = useMemo(() => ({
    img({ src, alt }) {
      if (!src) return null;
      return <MarkdownImage src={src} alt={alt} onZoom={setLightboxImage} isStreaming={isStreaming} />;
    },
    a({ href, children, ...props }) {
      if (href?.startsWith('citation://')) {
        return (
          <span className="inline-citation" title="Document citation">
            {children}
          </span>
        );
      }

      return (
        <a href={href} target="_blank" rel="noreferrer" {...props}>
          {children}
        </a>
      );
    },
  }), [isStreaming]);
  
  return (
    <div className={`message-row ${role}`}>
      <div className="message-content">
        <div className={`avatar ${isUser ? ((userImageUrl && !avatarFailed) ? 'user' : 'user-icon') : 'model'}`}>
          {isUser ? (
            (userImageUrl && !avatarFailed) ? (
              <img 
                src={userImageUrl} 
                alt="User" 
                referrerPolicy="no-referrer" 
                onError={() => setAvatarFailed(true)}
              />
            ) : 'U'
          ) : (
            <Sparkles />
          )}
        </div>
        <div className={`markdown-body${isStreaming ? ' streaming-markdown' : ''}`}>
          <CitationBadges citations={citations} />
          <ThinkingAccordion thinking={thinking} isThinkingComplete={isThinkingComplete} />
          {markdownText ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {markdownText}
            </ReactMarkdown>
          ) : null}
        </div>
      </div>
      <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(null)} />
    </div>
  );
});

MessageBubble.displayName = 'MessageBubble';

export default MessageBubble;
