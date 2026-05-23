import { useState, useRef, useEffect } from 'react';
import { useAuth } from "@clerk/clerk-react";
import MessageBubble from './MessageBubble';
import API_BASE from '../api';

const ChatInterface = ({ chatId, onTitleUpdate }) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState('');
  const [isFetching, setIsFetching] = useState(false);
  const messagesEndRef = useRef(null);
  const { getToken } = useAuth();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Fetch messages when chatId changes
  useEffect(() => {
    const controller = new AbortController();
    const fetchMessages = async () => {
      setMessages([]);
      setIsFetching(true);
      try {
        const token = await getToken();
        const res = await fetch(`${API_BASE}/api/chats/${chatId}/messages`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        if (res.ok) {
          setMessages(await res.json());
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error("Failed to fetch messages:", error);
        }
      } finally {
        setIsFetching(false);
      }
    };
    if (chatId) {
      fetchMessages();
    }
    return () => controller.abort();
  }, [chatId, getToken]);

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
      const token = await getToken();
      const response = await fetch(`${API_BASE}/api/chats/${chatId}/message`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ query })
      });

      if (!response.ok) {
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'model', text: `**Error:** Failed to fetch` }]);
        setIsLoading(false);
        return;
      }

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
            placeholder="Message RagAgent..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            rows={1}
          />
          <button className="send-button" type="submit" disabled={!inputValue.trim() || isLoading}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
};

export default ChatInterface;
