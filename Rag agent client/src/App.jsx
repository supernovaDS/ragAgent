import { useState, useEffect, useCallback } from 'react';
import { SignedIn, SignedOut, SignIn, UserButton, useUser } from "@clerk/clerk-react";
import FileUpload from './components/FileUpload';
import ChatInterface from './components/ChatInterface';
import { PlusCircle, MessageSquare, Trash2, Sun, Moon, Menu, X } from 'lucide-react';
import useAuthFetch from './hooks/useAuthFetch';
import { isTempChat } from './utils/chatUtils';

function AuthenticatedApp({ theme, onToggleTheme }) {
  const authFetch = useAuthFetch();
  const { user } = useUser();
  const userId = user?.id;

  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Load from localStorage cache once userId is available
  useEffect(() => {
    if (!userId) return;
    try {
      const cachedChats = localStorage.getItem(`rag_chats_${userId}`);
      if (cachedChats) {
        const parsedChats = JSON.parse(cachedChats);
        const cachedActiveId = localStorage.getItem(`rag_active_chat_${userId}`);
        const nextActiveId = cachedActiveId && parsedChats.some(c => c.id === cachedActiveId)
          ? cachedActiveId
          : parsedChats[0]?.id ?? null;

        queueMicrotask(() => {
          setChats(parsedChats);
          setActiveChatId(nextActiveId);
        });
      }
    } catch (e) {
      console.error("Failed to load cached chats:", e);
    }
  }, [userId]);

  // Sync chats to localStorage
  useEffect(() => {
    if (!userId) return;
    try {
      if (chats.length > 0) {
        const chatsToCache = chats.filter(c => !isTempChat(c.id));
        localStorage.setItem(`rag_chats_${userId}`, JSON.stringify(chatsToCache));
      } else {
        localStorage.removeItem(`rag_chats_${userId}`);
      }
    } catch (e) {
      console.error("Failed to cache chats:", e);
    }
  }, [chats, userId]);

  // Sync activeChatId to localStorage
  useEffect(() => {
    if (!userId) return;
    try {
      if (activeChatId && !isTempChat(activeChatId)) {
        localStorage.setItem(`rag_active_chat_${userId}`, activeChatId);
      } else if (!activeChatId) {
        localStorage.removeItem(`rag_active_chat_${userId}`);
      }
    } catch (e) {
      console.error("Failed to cache active chat ID:", e);
    }
  }, [activeChatId, userId]);

  // Fix #15: single fetchChats function used both for initial load and title refreshes
  const fetchChats = useCallback(async (options = {}) => {
    const { signal } = options;
    try {
      const data = await authFetch('/api/chats', signal ? { signal } : {});
      if (data) {
        setChats(data);
        setActiveChatId((currentId) => {
          if (currentId && data.some((chat) => chat.id === currentId)) return currentId;
          return data[0]?.id ?? null;
        });
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error("Failed to fetch chats:", error);
      }
    }
  }, [authFetch]);

  // Initial load
  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      fetchChats({ signal: controller.signal });
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [fetchChats]);

  const getDocuments = useCallback(async (chatId) => {
    return authFetch(`/api/chats/${chatId}/documents`);
  }, [authFetch]);

  const fetchDocuments = useCallback(async (chatId) => {
    try {
      const data = await getDocuments(chatId);
      if (data) setDocuments(data);
    } catch (error) {
      console.error("Failed to fetch documents:", error);
    }
  }, [getDocuments]);

  const createNewChat = async () => {
    const tempId = `temp_${crypto.randomUUID()}`;
    const placeholderChat = {
      id: tempId,
      title: "New Chat",
      created_at: new Date().toISOString()
    };

    setChats(prev => [placeholderChat, ...prev]);
    setActiveChatId(tempId);

    try {
      const newChat = await authFetch('/api/chats', { method: 'POST' });
      setChats(prev => prev.map(c => c.id === tempId ? newChat : c));
      setActiveChatId(currentId => currentId === tempId ? newChat.id : currentId);
    } catch (error) {
      console.error("Failed to create chat:", error);
      setChats(prev => prev.filter(c => c.id !== tempId));
      setActiveChatId(currentId => currentId === tempId ? null : currentId);
      alert("Failed to create new chat. Please try again.");
    }
  };

  const deleteChat = async (e, chatId) => {
    e.stopPropagation();
    if (!window.confirm("Delete this chat and all its PDFs?")) return;
    
    const originalChats = [...chats];
    const originalActiveChatId = activeChatId;
    const originalDocuments = [...documents];

    const updatedChats = chats.filter(chat => chat.id !== chatId);
    setChats(updatedChats);

    if (activeChatId === chatId) {
      const nextActiveId = updatedChats[0]?.id ?? null;
      setActiveChatId(nextActiveId);
      setDocuments([]);
    }

    try {
      await authFetch(`/api/chats/${chatId}`, { method: 'DELETE' });

      // Clean up local cache for this chat on success
      if (userId) {
        try {
          localStorage.removeItem(`rag_messages_${userId}_${chatId}`);
          const metaKey = `rag_cached_chats_metadata_${userId}`;
          const cachedListStr = localStorage.getItem(metaKey);
          if (cachedListStr) {
            const cachedList = JSON.parse(cachedListStr).filter(id => id !== chatId);
            localStorage.setItem(metaKey, JSON.stringify(cachedList));
          }
        } catch (cacheErr) {
          console.error("Failed to prune metadata for deleted chat:", cacheErr);
        }
      }
    } catch (error) {
      console.error("Failed to delete chat:", error);
      setChats(originalChats);
      setActiveChatId(originalActiveChatId);
      setDocuments(originalDocuments);
      alert("Failed to delete chat. Please try again.");
    }
  };

  useEffect(() => {
    if (!activeChatId) return;
    let isCancelled = false;

    const loadDocuments = async () => {
      try {
        const data = await getDocuments(activeChatId);
        if (!isCancelled && data) setDocuments(data);
      } catch (error) {
        if (!isCancelled) console.error("Failed to fetch documents:", error);
      }
    };

    if (isTempChat(activeChatId)) {
      queueMicrotask(() => setDocuments([]));
    } else {
      loadDocuments();
    }

    return () => {
      isCancelled = true;
    };
  }, [activeChatId, getDocuments]);

  const deleteDocument = async (docId) => {
    if (!window.confirm("Delete this PDF from the knowledge base?")) return;
    
    const originalDocuments = [...documents];
    setDocuments(prev => prev.filter(d => d.id !== docId));

    try {
      await authFetch(`/api/documents/${docId}`, { method: 'DELETE' });
    } catch (error) {
      console.error("Failed to delete document:", error);
      setDocuments(originalDocuments);
      alert("Failed to delete document. Please try again.");
    }
  };

  return (
    <div className="app-container">
      {isSidebarOpen && (
        <div 
          className="sidebar-overlay" 
          onClick={() => setIsSidebarOpen(false)} 
        />
      )}

      <div className={`sidebar ${isSidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-title">RagAgent</div>
          <div className="sidebar-header-right">
            <button 
              onClick={onToggleTheme} 
              className="theme-toggle-btn"
              title={theme === 'dark' ? 'Switch to Light' : 'Switch to Dark'}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <UserButton />
            <button 
              className="sidebar-close-btn"
              onClick={() => setIsSidebarOpen(false)}
              aria-label="Close sidebar"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        
        <button 
          onClick={() => {
            createNewChat();
            setIsSidebarOpen(false);
          }}
          className="sidebar-action-btn"
        >
          <PlusCircle size={18} /> New Chat
        </button>

        <div className="chat-list-container">
          <div className="sidebar-section-title">Your Chats</div>
          {chats.map(chat => (
            <div 
              key={chat.id} 
              onClick={() => {
                setActiveChatId(chat.id);
                setIsSidebarOpen(false);
              }}
              className={`chat-list-item ${activeChatId === chat.id ? 'active' : ''}`}
            >
              <div className="chat-item-text">
                <MessageSquare size={16} />
                <span className="chat-item-title">{chat.title}</span>
              </div>
              <Trash2 
                size={16} 
                className="chat-item-delete"
                onClick={(e) => deleteChat(e, chat.id)} 
              />
            </div>
          ))}
        </div>

        {activeChatId && (
          <div className="kb-section">
            <div className="sidebar-section-title">Knowledge Base</div>
            <div className="kb-documents-list">
              {documents.map(doc => (
                <div key={doc.id} className="kb-document-item">
                  <span className="kb-document-filename">{doc.filename}</span>
                  <Trash2 size={14} onClick={() => deleteDocument(doc.id)} />
                </div>
              ))}
            </div>
            <div>
              <FileUpload chatId={activeChatId} onUploadComplete={() => fetchDocuments(activeChatId)} />
            </div>
          </div>
        )}
      </div>

      <div className="main-content-wrapper">
        <div className="mobile-header">
          <button 
            className="hamburger-menu-btn"
            onClick={() => setIsSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <div className="mobile-header-title">
            {activeChatId 
              ? (chats.find(c => c.id === activeChatId)?.title || "Chat") 
              : "RagAgent"}
          </div>
          <div style={{ width: 32 }} />
        </div>

        {activeChatId ? (
          <ChatInterface chatId={activeChatId} onTitleUpdate={fetchChats} />
        ) : (
          <div className="chat-empty-state">
            <h2>Welcome to RagAgent</h2>
            <p>Create or select a chat from the sidebar, upload your PDF knowledge base, and start asking questions.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('theme');
    if (saved) return saved;
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  return (
    <>
      <SignedOut>
        <div className="login-wrapper">
          <SignIn routing="hash" />
        </div>
      </SignedOut>
      <SignedIn>
        <AuthenticatedApp theme={theme} onToggleTheme={toggleTheme} />
      </SignedIn>
    </>
  );
}

export default App;
