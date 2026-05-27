import { useState, useEffect, useCallback } from 'react';
import { SignedIn, SignedOut, SignIn, UserButton, useUser } from "@clerk/clerk-react";
import FileUpload from './components/FileUpload';
import ChatInterface from './components/ChatInterface';
import { PlusCircle, MessageSquare, Trash2 } from 'lucide-react';
import useAuthFetch from './hooks/useAuthFetch';

function AuthenticatedApp() {
  const authFetch = useAuthFetch();
  const { user } = useUser();
  const userId = user?.id;

  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [documents, setDocuments] = useState([]);

  // Load from localStorage cache once userId is available
  useEffect(() => {
    if (!userId) return;
    try {
      const cachedChats = localStorage.getItem(`rag_chats_${userId}`);
      if (cachedChats) {
        const parsedChats = JSON.parse(cachedChats);
        setChats(parsedChats);
        
        const cachedActiveId = localStorage.getItem(`rag_active_chat_${userId}`);
        if (cachedActiveId && parsedChats.some(c => c.id === cachedActiveId)) {
          setActiveChatId(cachedActiveId);
        } else if (parsedChats.length > 0) {
          setActiveChatId(parsedChats[0].id);
        }
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
        const chatsToCache = chats.filter(c => !c.id.toString().startsWith('temp_'));
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
      if (activeChatId && !activeChatId.toString().startsWith('temp_')) {
        localStorage.setItem(`rag_active_chat_${userId}`, activeChatId);
      } else if (!activeChatId) {
        localStorage.removeItem(`rag_active_chat_${userId}`);
      }
    } catch (e) {
      console.error("Failed to cache active chat ID:", e);
    }
  }, [activeChatId, userId]);

  const getChats = useCallback(async () => {
    return authFetch('/api/chats');
  }, [authFetch]);

  const fetchChats = useCallback(async () => {
    try {
      const data = await getChats();
      if (data) {
        setChats(data);
        setActiveChatId((currentId) => {
          if (currentId && data.some((chat) => chat.id === currentId)) return currentId;
          return data[0]?.id ?? null;
        });
      }
    } catch (error) {
      console.error("Failed to fetch chats:", error);
    }
  }, [getChats]);

  useEffect(() => {
    let isCancelled = false;

    const loadChats = async () => {
      try {
        const data = await getChats();
        if (!isCancelled && data) {
          setChats(data);
          setActiveChatId((currentId) => {
            if (currentId && data.some((chat) => chat.id === currentId)) return currentId;
            return data[0]?.id ?? null;
          });
        }
      } catch (error) {
        if (!isCancelled) console.error("Failed to fetch chats:", error);
      }
    };

    loadChats();

    return () => {
      isCancelled = true;
    };
  }, [getChats]);

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

    if (activeChatId.toString().startsWith('temp_')) {
      setDocuments([]);
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
      <div className="sidebar" style={{ overflow: 'hidden' }}>
        <div className="sidebar-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div className="sidebar-title" style={{ margin: 0 }}>RagAgent</div>
          <UserButton />
        </div>
        
        <button 
          onClick={createNewChat}
          style={{ width: '100%', padding: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '0.5rem', cursor: 'pointer', marginBottom: '1rem', color: 'var(--text-main)' }}
        >
          <PlusCircle size={18} /> New Chat
        </button>

        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem', padding: '0 0.5rem' }}>Your Chats</div>
          {chats.map(chat => (
            <div 
              key={chat.id} 
              onClick={() => setActiveChatId(chat.id)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 0.5rem', cursor: 'pointer', borderRadius: '0.5rem', background: activeChatId === chat.id ? 'var(--border-color)' : 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', overflow: 'hidden' }}>
                <MessageSquare size={16} />
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '0.9rem' }}>{chat.title}</span>
              </div>
              <Trash2 size={16} color="var(--text-muted)" onClick={(e) => deleteChat(e, chat.id)} style={{ cursor: 'pointer' }} />
            </div>
          ))}
        </div>

        {activeChatId && (
          <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem', padding: '0 0.5rem' }}>Knowledge Base</div>
            <div style={{ maxHeight: '150px', overflowY: 'auto', marginBottom: '0.5rem' }}>
              {documents.map(doc => (
                <div key={doc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', fontSize: '0.85rem' }}>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '80%' }}>{doc.filename}</span>
                  <Trash2 size={14} color="var(--text-muted)" style={{ cursor: 'pointer' }} onClick={() => deleteDocument(doc.id)} />
                </div>
              ))}
            </div>
            <div>
              <FileUpload chatId={activeChatId} onUploadComplete={() => fetchDocuments(activeChatId)} />
            </div>
          </div>
        )}
      </div>

      {activeChatId ? (
        <ChatInterface chatId={activeChatId} onTitleUpdate={fetchChats} />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
          Create a new chat to begin.
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <>
      <SignedOut>
        <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--bg-color)' }}>
          <SignIn routing="hash" />
        </div>
      </SignedOut>
      <SignedIn>
        <AuthenticatedApp />
      </SignedIn>
    </>
  );
}

export default App;
