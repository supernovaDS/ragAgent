import { useState, useRef } from 'react';
import useAuthFetch from '../hooks/useAuthFetch';
import { isTempChat } from '../utils/chatUtils';

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
    if (isTempChat(chatId)) {
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
          opacity: isTempChat(chatId) ? 0.5 : 1,
          cursor: isTempChat(chatId) ? 'not-allowed' : 'pointer'
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
        {message && <div className="upload-error">{message}</div>}
      </div>
      

      {isUploading && (
        <div className="upload-overlay">
          <div className="spinner" />
          <div className="upload-overlay-text">Extracting Text & Uploading Images...</div>
          <div className="upload-overlay-subtext">This takes about 5-10 seconds per page.</div>
        </div>
      )}
    </>
  );
};

export default FileUpload;
