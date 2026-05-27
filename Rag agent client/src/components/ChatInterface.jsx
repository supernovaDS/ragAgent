import { useState, useRef, useEffect } from 'react';
import { useUser } from "@clerk/clerk-react";
import MessageBubble from './MessageBubble';
import useAuthFetch from '../hooks/useAuthFetch';

const ChatInterface = ({ chatId, onTitleUpdate }) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState('');
  const [isFetching, setIsFetching] = useState(false);
  const messagesEndRef = useRef(null);
  const authFetch = useAuthFetch();
  const { user } = useUser();
  const userId = user?.id;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };


  useEffect(() => {
    const controller = new AbortController();
    const fetchMessages = async () => {
      let hasCache = false;
      if (userId && chatId && !chatId.toString().startsWith('temp_')) {
        try {
          const cached = localStorage.getItem(`rag_messages_${userId}_${chatId}`);
          if (cached) {
            setMessages(JSON.parse(cached));
            hasCache = true;
          } else {
            setMessages([]);
          }
        } catch (e) {
          console.error("Failed to load cached messages:", e);
        }
      } else {
        setMessages([]);
      }

      setIsFetching(!hasCache);
      try {
        const freshMessages = await authFetch(`/api/chats/${chatId}/messages`, {
          signal: controller.signal
        });
        setMessages(freshMessages);
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error("Failed to fetch messages:", error);
        }
      } finally {
        setIsFetching(false);
      }
    };
    if (chatId) {
      if (chatId.toString().startsWith('temp_')) {
        setMessages([]);
        setIsFetching(false);
      } else {
        fetchMessages();
      }
    }
    return () => controller.abort();
  }, [chatId, authFetch, userId]);

  // Sync messages to cache once loading/streaming are complete
  useEffect(() => {
    if (!userId || !chatId || chatId.toString().startsWith('temp_') || isLoading || streamingMessage) return;
    try {
      if (messages.length > 0) {
        localStorage.setItem(`rag_messages_${userId}_${chatId}`, JSON.stringify(messages));
        
        const metaKey = `rag_cached_chats_metadata_${userId}`;
        let cachedList = [];
        try {
          const cachedListStr = localStorage.getItem(metaKey);
          if (cachedListStr) {
            cachedList = JSON.parse(cachedListStr);
          }
        } catch (e) {
          console.error("Failed to parse cached chats metadata list:", e);
        }
        
        cachedList = cachedList.filter(id => id !== chatId);
        cachedList.push(chatId);
        
        const LIMIT = 10;
        while (cachedList.length > LIMIT) {
          const evictedId = cachedList.shift();
          localStorage.removeItem(`rag_messages_${userId}_${evictedId}`);
        }
        
        localStorage.setItem(metaKey, JSON.stringify(cachedList));
      } else {
        localStorage.removeItem(`rag_messages_${userId}_${chatId}`);
        const metaKey = `rag_cached_chats_metadata_${userId}`;
        try {
          const cachedListStr = localStorage.getItem(metaKey);
          if (cachedListStr) {
            const cachedList = JSON.parse(cachedListStr).filter(id => id !== chatId);
            localStorage.setItem(metaKey, JSON.stringify(cachedList));
          }
        } catch (e) {
          console.error("Failed to parse cached chats metadata list:", e);
        }
      }
    } catch (e) {
      console.error("Failed to cache messages:", e);
    }
  }, [messages, userId, chatId, isLoading, streamingMessage]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, streamingMessage]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading) return;

    const query = inputValue;
    const isFirstMessage = messages.length === 0;

    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', text: query }]);
    setInputValue('');
    setIsLoading(true);
    setStreamingMessage('');

    try {
      const response = await authFetch(`/api/chats/${chatId}/message`, {
        method: 'POST',
        body: JSON.stringify({ query })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedText = '';
      let isFirstChunk = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        if (isFirstChunk) {
          setIsLoading(false);
          isFirstChunk = false;
        }
        
        accumulatedText += decoder.decode(value, { stream: true });
        setStreamingMessage(accumulatedText);
      }

      setIsLoading(false);
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'model', text: accumulatedText }]);
      setStreamingMessage('');

      if (isFirstMessage) {
        onTitleUpdate();
      }

    } catch (error) {
      console.error(error);
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'model', text: '**Error:** Network error contacting the backend.' }]);
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="main-chat">
      <div className="messages-container">
        {isFetching ? (
          <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-muted)' }}>
             <p>Loading chat history...</p>
          </div>
        ) : messages.length === 0 && !streamingMessage && !isLoading ? (
          <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            <h2>RagAgent Chat</h2>
            <p style={{ marginTop: '1rem' }}>Ask me anything about your uploaded knowledge base!</p>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} role={msg.role} text={msg.text} />
            ))}
            {isLoading && (
              <MessageBubble role="model" text="*Thinking...*" />
            )}
            {streamingMessage && (
              <MessageBubble role="model" text={streamingMessage} isStreaming />
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-container">
        <form className="input-box" onSubmit={handleSubmit}>
          <textarea
            className="chat-input"
            placeholder={chatId.toString().startsWith('temp_') ? "Creating chat..." : "Message RagAgent..."}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading || chatId.toString().startsWith('temp_')}
            rows={1}
          />
          <button className="send-button" type="submit" disabled={!inputValue.trim() || isLoading || chatId.toString().startsWith('temp_')}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
};

export default ChatInterface;
