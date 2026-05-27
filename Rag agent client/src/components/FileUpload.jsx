import { useState, useRef } from 'react';
import useAuthFetch from '../hooks/useAuthFetch';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const FileUpload = ({ chatId, onUploadComplete }) => {
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState('');
  const authFetch = useAuthFetch();
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
      await authFetch(`/api/chats/${chatId}/upload`, {
        method: 'POST',
        body: formData,
      });

      setMessage('');
      onUploadComplete();
    } catch (error) {
      console.error(error);
      setMessage(error.message || 'Upload failed.');
    } finally {
      setIsUploading(false);
      event.target.value = null;
    }
  };

  const handleUploadClick = () => {
    if (chatId && chatId.toString().startsWith('temp_')) {
      return;
    }
    fileInputRef.current?.click();
  };

  return (
    <>
      <div 
        className="upload-zone" 
        onClick={handleUploadClick}
        style={{
          opacity: chatId && chatId.toString().startsWith('temp_') ? 0.5 : 1,
          cursor: chatId && chatId.toString().startsWith('temp_') ? 'not-allowed' : 'pointer'
        }}
      >
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
