import { useState, useEffect, useCallback } from 'react';
import { SignedIn, SignedOut, SignIn, UserButton, useAuth } from "@clerk/clerk-react";
import FileUpload from './components/FileUpload';
import ChatInterface from './components/ChatInterface';
import { PlusCircle, MessageSquare, Trash2 } from 'lucide-react';
import API_BASE from './api';

function AuthenticatedApp() {
  const { getToken } = useAuth();
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [documents, setDocuments] = useState([]);

  const getChats = useCallback(async () => {
    const token = await getToken();
    const res = await fetch(`${API_BASE}/api/chats`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return res.ok ? res.json() : null;
  }, [getToken]);

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

  // Fetch chats on mount
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
    const token = await getToken();
    const res = await fetch(`${API_BASE}/api/chats/${chatId}/documents`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return res.ok ? res.json() : null;
  }, [getToken]);

  const fetchDocuments = useCallback(async (chatId) => {
    try {
      const data = await getDocuments(chatId);
      if (data) setDocuments(data);
    } catch (error) {
      console.error("Failed to fetch documents:", error);
    }
  }, [getDocuments]);

  const createNewChat = async () => {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/chats`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const newChat = await res.json();
        setChats(prev => [newChat, ...prev]);
        setActiveChatId(newChat.id);
      }
    } catch (error) {
      console.error("Failed to create chat:", error);
    }
  };

  const deleteChat = async (e, chatId) => {
    e.stopPropagation();
    if (!window.confirm("Delete this chat and all its PDFs?")) return;
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/chats/${chatId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        if (activeChatId === chatId) {
          setActiveChatId(null);
          setDocuments([]);
        }
        fetchChats();
      }
    } catch (error) {
      console.error("Failed to delete chat:", error);
    }
  };

  // Fetch documents when active chat changes
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

    loadDocuments();

    return () => {
      isCancelled = true;
    };
  }, [activeChatId, getDocuments]);

  const deleteDocument = async (docId) => {
    if (!window.confirm("Delete this PDF from the knowledge base?")) return;
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/documents/${docId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setDocuments(prev => prev.filter(d => d.id !== docId));
      }
    } catch (error) {
      console.error("Failed to delete document:", error);
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
