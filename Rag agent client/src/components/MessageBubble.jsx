import { memo, useEffect, useMemo, useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { Sparkles, ImageOff } from 'lucide-react';

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

const prepareMarkdown = (text) => (
  text
    .replace(EVIDENCE_LINE_RE, '')
    .replace(PAGE_CITATION_RE, (_match, page) => `[p. ${page}](citation://page/${page})`)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
);

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

const MarkdownImage = ({ src, alt, onZoom }) => {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="markdown-image-failed" title="Failed to load document image">
        <ImageOff size={16} />
        <span>Image failed to load</span>
      </div>
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
        onError={() => setFailed(true)}
      />
    </button>
  );
};

const MessageBubble = memo(({ role, text, isStreaming = false, userImageUrl = null }) => {
  const isUser = role === 'user';
  const visibleText = useSmoothStreamingText(text || '', isStreaming);
  const [lightboxImage, setLightboxImage] = useState(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const citations = useMemo(() => parseEvidence(visibleText), [visibleText]);
  const markdownText = useMemo(() => prepareMarkdown(visibleText), [visibleText]);

  const markdownComponents = useMemo(() => ({
    img({ src, alt }) {
      if (!src) return null;
      return <MarkdownImage src={src} alt={alt} onZoom={setLightboxImage} />;
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
  }), []);
  
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
          <ReactMarkdown components={markdownComponents}>{markdownText}</ReactMarkdown>
        </div>
      </div>
      <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(null)} />
    </div>
  );
});

MessageBubble.displayName = 'MessageBubble';

export default MessageBubble;
