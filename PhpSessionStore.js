// Custom store that saves/loads WA session from your PHP API
class PhpSessionStore {
  constructor(apiUrl, apiKey) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
  }

  async sessionExists({ session }) {
    try {
      const res  = await fetch(`${this.apiUrl}/v1/whatsapp/session-load`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify({ session_id: session }),
      });
      const json = await res.json();
      return json.success === true;
    } catch {
      return false;
    }
  }

  async save({ session, data }) {
    try {
      await fetch(`${this.apiUrl}/v1/whatsapp/session-save`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify({
          session_id:   session,
          session_data: typeof data === 'string' ? data : JSON.stringify(data),
        }),
      });
      console.log('Session saved to PHP ✓');
    } catch (err) {
      console.error('Failed to save session:', err.message);
    }
  }

  async extract({ session }) {
    try {
      const res  = await fetch(`${this.apiUrl}/v1/whatsapp/session-load`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify({ session_id: session }),
      });
      const json = await res.json();
      if (!json.success) return null;
      const data = json.session_data;
      try { return JSON.parse(data); } catch { return data; }
    } catch (err) {
      console.error('Failed to load session:', err.message);
      return null;
    }
  }

  async delete({ session }) {
    try {
      await fetch(`${this.apiUrl}/v1/whatsapp/session-delete`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify({ session_id: session }),
      });
      console.log('Session deleted from PHP ✓');
    } catch (err) {
      console.error('Failed to delete session:', err.message);
    }
  }
}

module.exports = PhpSessionStore;