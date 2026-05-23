import { useState, useRef } from 'react';
import { useAuth } from "@clerk/clerk-react";
import API_BASE from '../api';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const FileUpload = ({ chatId, onUploadComplete }) => {
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState('');
  const { getToken } = useAuth();
  const fileInputRef = useRef(null);

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      setMessage('Only PDFs supported.');
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      setMessage('File too large. Max 50MB.');
      return;
    }

    setIsUploading(true);
    setMessage('');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const token = await getToken();
      const response = await fetch(`${API_BASE}/api/chats/${chatId}/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData,
      });

      if (response.ok) {
        setMessage('');
        onUploadComplete();
      } else {
        const data = await response.json();
        setMessage(`Error: ${data.detail || 'Upload failed'}`);
      }
    } catch (error) {
      console.error(error);
      setMessage('Network error.');
    } finally {
      setIsUploading(false);
      event.target.value = null;
    }
  };

  return (
    <>
      <div className="upload-zone" onClick={() => fileInputRef.current?.click()}>
        <input 
          type="file" 
          ref={fileInputRef}
          accept="application/pdf" 
          style={{ display: 'none' }} 
          onChange={handleFileUpload}
        />
        <span>+ Upload PDF</span>
        {message && <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--error-color, #ff4a4a)' }}>{message}</div>}
      </div>
      
      {/* Full screen loader during upload/ingestion */}
      {isUploading && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, 
          backgroundColor: 'rgba(15, 15, 15, 0.85)', 
          zIndex: 9999, display: 'flex', flexDirection: 'column', 
          alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(3px)',
          color: '#ffffff'
        }}>
          <div className="spinner" />
          <div style={{ marginTop: '1rem', fontWeight: 600 }}>Extracting Text & Uploading Images...</div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: 'rgba(255, 255, 255, 0.7)' }}>This takes about 5-10 seconds per page.</div>
        </div>
      )}
    </>
  );
};

export default FileUpload;
