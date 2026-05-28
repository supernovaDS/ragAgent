import { useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import API_BASE from '../api';

export default function useAuthFetch() {
  const { getToken } = useAuth();

  const authFetch = useCallback(async (path, options = {}) => {
    const token = await getToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    };

    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      let errorDetail = '';
      try {
        const parsed = JSON.parse(errorText);
        errorDetail = parsed.detail || parsed.message || '';
      } catch {
        // Response body was not JSON; fall back to the HTTP status below.
      }
      throw new Error(errorDetail || `Request failed with status ${res.status}`);
    }

    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return res.json();
    }
    return res;
  }, [getToken]);

  return authFetch;
}
