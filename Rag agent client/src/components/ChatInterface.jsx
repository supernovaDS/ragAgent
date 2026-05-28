import { useState, useRef, useEffect } from 'react';
import { useUser } from "@clerk/clerk-react";
import MessageBubble from './MessageBubble';
import useAuthFetch from '../hooks/useAuthFetch';
import { isTempChat } from '../utils/chatUtils';

// Fix #16: extracted shared metadata cache management
function updateCacheMetadata(userId, chatId, action) {
  const metaKey = `rag_cached_chats_metadata_${userId}`;
  try {
    const raw = localStorage.getItem(metaKey);
    let cachedList = raw ? JSON.parse(raw) : [];
    cachedList = cachedList.filter(id => id !== chatId);

    if (action === 'add') {
      cachedList.push(chatId);
      const LIMIT = 10;
      while (cachedList.length > LIMIT) {
        const evictedId = cachedList.shift();
        localStorage.removeItem(`rag_messages_${userId}_${evictedId}`);
      }
    }

    localStorage.setItem(metaKey, JSON.stringify(cachedList));
  } catch (e) {
    console.error("Failed to update cached chats metadata:", e);
  }
}

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
      if (userId && chatId && !isTempChat(chatId)) {
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
      if (isTempChat(chatId)) {
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
    if (!userId || !chatId || isTempChat(chatId) || isLoading || streamingMessage) return;
    try {
      if (messages.length > 0) {
        localStorage.setItem(`rag_messages_${userId}_${chatId}`, JSON.stringify(messages));
        updateCacheMetadata(userId, chatId, 'add');
      } else {
        localStorage.removeItem(`rag_messages_${userId}_${chatId}`);
        updateCacheMetadata(userId, chatId, 'remove');
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
          <div className="chat-empty-state">
             <p>Loading chat history...</p>
          </div>
        ) : messages.length === 0 && !streamingMessage && !isLoading ? (
          <div className="chat-empty-state">
            <h2>RagAgent Chat</h2>
            <p>Ask me anything about your uploaded knowledge base!</p>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <MessageBubble 
                key={msg.id} 
                role={msg.role} 
                text={msg.text} 
                userImageUrl={user?.imageUrl} 
              />
            ))}
            {isLoading && (
              <MessageBubble role="model" text="*Thinking...*" userImageUrl={user?.imageUrl} />
            )}
            {streamingMessage && (
              <MessageBubble role="model" text={streamingMessage} isStreaming userImageUrl={user?.imageUrl} />
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-container">
        <form className="input-box" onSubmit={handleSubmit}>
          <textarea
            className="chat-input"
            placeholder={isTempChat(chatId) ? "Creating chat..." : "Message RagAgent..."}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading || isTempChat(chatId)}
            rows={1}
          />
          <button className="send-button" type="submit" disabled={!inputValue.trim() || isLoading || isTempChat(chatId)}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
};

export default ChatInterface;
